import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { migrate } from '../src/db/schema.ts';
import { createSessionRepo } from '../src/db/session-repo.ts';
import type { BridgeErrorCode, CheckoutSession, SessionRepo } from '../src/types.ts';
import { at, expectBridgeError, makeSession, makeStore, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/**
 * SessionRepo: regra de sessão "viva", idempotência atômica do insertPending, transições
 * de status, listagem, estatísticas e limpeza.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** makeSession cria sessões com createdAt = T0 e expiresAt = T0 + 15 min. */
const EXPIRES = at(15 * MINUTE);

const CREATED_PATCH = {
  strategy: 'storefront_cart',
  checkoutUrl: 'https://checkout.example.com/cart/c/abc',
  cartId: 'gid://shopify/Cart/abc',
  subtotal: '79.80',
  currency: 'BRL',
} as const;

const open: Db[] = [];
const tempDirs: string[] = [];

function fresh(): TestContext & { sessions: SessionRepo } {
  const ctx = setup();
  open.push(ctx.db);
  return { ...ctx, sessions: ctx.repos.sessions };
}

/** Insere e exige que a sessão tenha de fato entrado. */
function insert(sessions: SessionRepo, overrides: Partial<CheckoutSession> = {}, now?: string): CheckoutSession {
  const session = makeSession(overrides);
  const result = sessions.insertPending(session, now ?? session.createdAt);
  assert.equal(result.inserted, true, 'a sessão deveria ter sido inserida');
  return result.session;
}

function rawColumn(db: Db, id: string, column: 'lines' | 'status' | 'created_at' | 'expires_at'): unknown {
  // O nome da coluna vem do tipo literal acima, nunca de dado externo.
  return db.get<Record<string, unknown>>(`SELECT ${column} AS v FROM checkout_sessions WHERE id = ?`, [id])?.v;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('insertPending: gravação', () => {
  it('insere em pending e devolve a sessão como ficou no banco', () => {
    const { sessions, db } = fresh();
    const input = makeSession();
    const result = sessions.insertPending(input, T0);

    assert.equal(result.inserted, true);
    assert.deepEqual(result.session, input);
    assert.deepEqual(sessions.get(input.id), input);
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
  });

  it('entra sempre como pending e sem resultado, qualquer que seja o objeto recebido', () => {
    const { sessions } = fresh();
    const input = makeSession({
      status: 'created',
      strategy: 'permalink',
      checkoutUrl: 'https://exemplo.com/cart/1:1',
      cartId: 'gid://shopify/Cart/x',
      subtotal: '10.00',
      currency: 'BRL',
      errorCode: 'internal',
    });
    const { session } = sessions.insertPending(input, T0);

    assert.equal(session.status, 'pending');
    assert.equal(session.strategy, null);
    assert.equal(session.checkoutUrl, null);
    assert.equal(session.cartId, null);
    assert.equal(session.subtotal, null);
    assert.equal(session.currency, null);
    assert.equal(session.errorCode, null);
    // E não conta como "created" para a idempotência depois dos 60 s.
    assert.equal(sessions.findActiveByKey(input.idempotencyKey, at(61 * SECOND)), null);
  });

  it('linhas fazem ida e volta como JSON, com ids grandes preservados como texto', () => {
    const { sessions, db } = fresh();
    const lines = [
      { vitrineVariantId: '50123456789012345678', checkoutVariantId: '60123456789012345678', quantity: 1 },
      { vitrineVariantId: '2', checkoutVariantId: '92', quantity: 37 },
      { vitrineVariantId: '3', checkoutVariantId: '93', quantity: 2 },
    ];
    const created = insert(sessions, { lines });

    assert.deepEqual(created.lines, lines);
    assert.deepEqual(sessions.get(created.id)?.lines, lines);
    const raw = rawColumn(db, created.id, 'lines');
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(String(raw)), lines);
  });

  it('grava só os campos do contrato de cada linha (propriedades do comprador ficam de fora)', () => {
    const { sessions, db } = fresh();
    const line = { vitrineVariantId: '1', checkoutVariantId: '91', quantity: 2, properties: { Gravação: 'Maria S.' } };
    const created = insert(sessions, { lines: [line] });

    assert.deepEqual(created.lines, [{ vitrineVariantId: '1', checkoutVariantId: '91', quantity: 2 }]);
    assert.ok(!String(rawColumn(db, created.id, 'lines')).includes('Maria'));
  });

  it('recusa linha fora do contrato em vez de gravar um histórico diferente do carrinho', () => {
    const { sessions, db } = fresh();
    const bad: unknown[] = [
      { vitrineVariantId: 1, checkoutVariantId: '91', quantity: 1 },
      { vitrineVariantId: '1', checkoutVariantId: null, quantity: 1 },
      { vitrineVariantId: '1', checkoutVariantId: '91', quantity: '2' },
      { vitrineVariantId: '1', checkoutVariantId: '91', quantity: Number.NaN },
      null,
    ];
    for (const line of bad) {
      const session = makeSession({ lines: [line as CheckoutSession['lines'][number]] });
      expectBridgeError(() => sessions.insertPending(session, T0), 'invalid_request');
    }
    assert.equal(tableCount(db, 'checkout_sessions'), 0);
  });

  it('carrinho sem linhas e campos opcionais nulos fazem ida e volta', () => {
    const { sessions } = fresh();
    const created = insert(sessions, { lines: [], country: null, ipHash: null });
    assert.deepEqual(created.lines, []);
    assert.equal(created.country, null);
    assert.equal(created.ipHash, null);
  });

  it('coluna lines corrompida no banco vira lista vazia em vez de quebrar a leitura', () => {
    const { sessions, db } = fresh();
    const created = insert(sessions);
    db.run('UPDATE checkout_sessions SET lines = ? WHERE id = ?', ['{isso não é json', created.id]);
    assert.deepEqual(sessions.get(created.id)?.lines, []);
    db.run('UPDATE checkout_sessions SET lines = ? WHERE id = ?', ['{"a":1}', created.id]);
    assert.deepEqual(sessions.get(created.id)?.lines, []);
  });

  it('normaliza as datas para o formato canônico', () => {
    const { sessions, db } = fresh();
    const created = insert(sessions, { createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:15:00+00:00' });
    assert.equal(created.createdAt, T0);
    assert.equal(created.expiresAt, EXPIRES);
    assert.equal(rawColumn(db, created.id, 'created_at'), T0);
    assert.equal(rawColumn(db, created.id, 'expires_at'), EXPIRES);
  });

  it('valida campos obrigatórios e datas sem gravar nada', () => {
    const { sessions, db } = fresh();
    expectBridgeError(() => sessions.insertPending(makeSession({ id: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ idempotencyKey: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ vitrineStoreId: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ checkoutStoreId: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ linkId: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ createdAt: 'ontem' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession({ expiresAt: '' }), T0), 'invalid_request');
    expectBridgeError(() => sessions.insertPending(makeSession(), 'agora'), 'invalid_request');
    assert.equal(tableCount(db, 'checkout_sessions'), 0);
  });

  it('id repetido com chave diferente é conflito e não altera a sessão original', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions, { idempotencyKey: 'chave-a' });
    expectBridgeError(
      () => sessions.insertPending(makeSession({ id: first.id, idempotencyKey: 'chave-b', country: 'PT' }), T0),
      'conflict',
    );
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
    assert.deepEqual(sessions.get(first.id), first);
  });

  it('valores hostis entram como dado, nunca como SQL', () => {
    const { sessions, db } = fresh();
    const key = "x' OR '1'='1'; DROP TABLE checkout_sessions; --";
    const created = insert(sessions, { idempotencyKey: key });
    assert.equal(sessions.findActiveByKey(key, T0)?.id, created.id);
    assert.equal(sessions.findActiveByKey("x' OR '1'='1", T0), null);
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
  });
});

describe('sessão viva: findActiveByKey', () => {
  it('devolve null para chave desconhecida', () => {
    const { sessions } = fresh();
    insert(sessions, { idempotencyKey: 'chave-a' });
    assert.equal(sessions.findActiveByKey('chave-b', T0), null);
  });

  it('pending conta só por menos de 60 segundos (limites em 59 s, 60 s e 61 s)', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    const key = created.idempotencyKey;

    assert.equal(sessions.findActiveByKey(key, T0)?.id, created.id);
    assert.equal(sessions.findActiveByKey(key, at(59 * SECOND))?.id, created.id);
    assert.equal(sessions.findActiveByKey(key, at(60 * SECOND - 1))?.id, created.id);
    // Exatamente 60 s já não é "há menos de 60 segundos".
    assert.equal(sessions.findActiveByKey(key, at(60 * SECOND)), null);
    assert.equal(sessions.findActiveByKey(key, at(61 * SECOND)), null);
  });

  it('created continua viva depois dos 60 s, até expirar', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markCreated(created.id, CREATED_PATCH);
    const key = created.idempotencyKey;

    const found = sessions.findActiveByKey(key, at(61 * SECOND));
    assert.equal(found?.id, created.id);
    assert.equal(found?.status, 'created');
    assert.equal(found?.checkoutUrl, CREATED_PATCH.checkoutUrl);
    assert.equal(sessions.findActiveByKey(key, at(15 * MINUTE - 1))?.id, created.id);
    // expiresAt igual a "agora" já é expirada.
    assert.equal(sessions.findActiveByKey(key, EXPIRES), null);
    assert.equal(sessions.findActiveByKey(key, at(15 * MINUTE + 1)), null);
  });

  it('pending expirada não conta, mesmo dentro dos 60 s', () => {
    const { sessions } = fresh();
    const created = insert(sessions, { expiresAt: at(30 * SECOND) });
    assert.equal(sessions.findActiveByKey(created.idempotencyKey, at(29 * SECOND))?.id, created.id);
    assert.equal(sessions.findActiveByKey(created.idempotencyKey, at(30 * SECOND)), null);
  });

  it('failed nunca conta', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markFailed(created.id, 'upstream_unavailable');
    assert.equal(sessions.findActiveByKey(created.idempotencyKey, T0), null);
    assert.equal(sessions.findActiveByKey(created.idempotencyKey, at(SECOND)), null);
  });

  it('aceita "agora" em formato ISO não canônico sem errar os limites', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    const key = created.idempotencyKey;
    assert.equal(sessions.findActiveByKey(key, '2026-01-01T00:00:59Z')?.id, created.id);
    assert.equal(sessions.findActiveByKey(key, '2026-01-01T00:01:00Z'), null);
    assert.equal(sessions.findActiveByKey(key, '2025-12-31T21:00:59-03:00')?.id, created.id);
    expectBridgeError(() => sessions.findActiveByKey(key, 'já'), 'invalid_request');
  });

  it('entre uma created e uma pending vivas da mesma chave, devolve a created', () => {
    const { sessions } = fresh();
    // A primeira tentativa demorou mais de 60 s; a segunda entrou; depois a primeira concluiu.
    const slow = insert(sessions);
    const second = insert(sessions, { createdAt: at(61 * SECOND) }, at(61 * SECOND));
    sessions.markCreated(slow.id, CREATED_PATCH);

    assert.notEqual(slow.id, second.id);
    assert.equal(sessions.findActiveByKey(slow.idempotencyKey, at(70 * SECOND))?.id, slow.id);
  });
});

describe('insertPending: idempotência', () => {
  it('com pending viva da mesma chave, não insere e devolve a existente', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions);
    const retry = makeSession({ createdAt: at(5 * SECOND), country: 'PT' });
    const result = sessions.insertPending(retry, at(5 * SECOND));

    assert.equal(result.inserted, false);
    assert.deepEqual(result.session, first);
    assert.equal(sessions.get(retry.id), null);
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
  });

  it('limite da pending: aos 59 s devolve a existente, aos 61 s insere outra', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions);

    const at59 = sessions.insertPending(makeSession({ createdAt: at(59 * SECOND) }), at(59 * SECOND));
    assert.equal(at59.inserted, false);
    assert.equal(at59.session.id, first.id);
    assert.equal(tableCount(db, 'checkout_sessions'), 1);

    const retry = makeSession({ createdAt: at(61 * SECOND), expiresAt: at(16 * MINUTE) });
    const at61 = sessions.insertPending(retry, at(61 * SECOND));
    assert.equal(at61.inserted, true);
    assert.equal(at61.session.id, retry.id);
    assert.equal(at61.session.status, 'pending');
    assert.equal(tableCount(db, 'checkout_sessions'), 2);
    // A antiga fica como estava (histórico); a nova passa a ser a viva.
    assert.equal(sessions.get(first.id)?.status, 'pending');
    assert.equal(sessions.findActiveByKey(first.idempotencyKey, at(62 * SECOND))?.id, retry.id);
  });

  it('exatamente aos 60 s a pending antiga já não bloqueia', () => {
    const { sessions } = fresh();
    insert(sessions);
    const retry = makeSession({ createdAt: at(60 * SECOND) });
    assert.equal(sessions.insertPending(retry, at(60 * SECOND)).inserted, true);
  });

  it('com created viva, devolve a existente com a URL de checkout, mesmo muito depois dos 60 s', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions);
    sessions.markCreated(first.id, CREATED_PATCH);

    const result = sessions.insertPending(makeSession({ createdAt: at(10 * MINUTE) }), at(10 * MINUTE));
    assert.equal(result.inserted, false);
    assert.equal(result.session.id, first.id);
    assert.equal(result.session.status, 'created');
    assert.equal(result.session.checkoutUrl, CREATED_PATCH.checkoutUrl);
    assert.equal(result.session.strategy, 'storefront_cart');
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
  });

  it('sessão expirada não bloqueia: no instante da expiração entra uma nova', () => {
    const { sessions } = fresh();
    const first = insert(sessions);
    sessions.markCreated(first.id, CREATED_PATCH);

    const before = sessions.insertPending(makeSession({ createdAt: at(15 * MINUTE - 1) }), at(15 * MINUTE - 1));
    assert.equal(before.inserted, false);

    const retry = makeSession({ createdAt: EXPIRES, expiresAt: at(30 * MINUTE) });
    const after = sessions.insertPending(retry, EXPIRES);
    assert.equal(after.inserted, true);
    assert.equal(after.session.id, retry.id);
    assert.equal(after.session.checkoutUrl, null);
  });

  it('failed não bloqueia uma nova tentativa imediata', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions);
    sessions.markFailed(first.id, 'upstream_rejected');

    const retry = makeSession({ createdAt: at(SECOND) });
    const result = sessions.insertPending(retry, at(SECOND));
    assert.equal(result.inserted, true);
    assert.equal(result.session.id, retry.id);
    assert.equal(tableCount(db, 'checkout_sessions'), 2);

    // A nova tentativa conclui e passa a ser a resposta idempotente; a falha fica no histórico.
    sessions.markCreated(retry.id, CREATED_PATCH);
    assert.equal(sessions.findActiveByKey(retry.idempotencyKey, at(5 * MINUTE))?.id, retry.id);
    assert.equal(sessions.get(first.id)?.status, 'failed');
    assert.equal(sessions.get(first.id)?.errorCode, 'upstream_rejected');
  });

  it('chaves diferentes não interferem entre si', () => {
    const { sessions } = fresh();
    const a = insert(sessions, { idempotencyKey: 'chave-a' });
    const b = insert(sessions, { idempotencyKey: 'chave-b' });
    assert.equal(sessions.insertPending(makeSession({ idempotencyKey: 'chave-a' }), T0).session.id, a.id);
    assert.equal(sessions.insertPending(makeSession({ idempotencyKey: 'chave-b' }), T0).session.id, b.id);
  });

  it('a regra usa o "agora" informado, não o createdAt da sessão nova', () => {
    const { sessions } = fresh();
    insert(sessions);
    // createdAt antigo no objeto novo não muda a decisão: o que vale é now = T0 + 61 s.
    assert.equal(sessions.insertPending(makeSession({ createdAt: T0 }), at(61 * SECOND)).inserted, true);
  });
});

describe('insertPending: atomicidade', () => {
  function fileRepos(): { first: Db; second: Db; a: SessionRepo; b: SessionRepo } {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-sessions-'));
    tempDirs.push(dir);
    const path = join(dir, 'sessions.db');
    const first = openDatabase(path);
    const second = openDatabase(path);
    open.push(first, second);
    migrate(first);
    // Sem espera na segunda conexão, para o teste não ficar parado no busy_timeout.
    second.exec('PRAGMA busy_timeout = 0');
    return { first, second, a: createSessionRepo(first), b: createSessionRepo(second) };
  }

  it('a consulta e o INSERT acontecem dentro de uma única transação do Db', () => {
    const { db } = fresh();
    const calls: string[] = [];
    let inside = 0;
    const tag = (kind: string, sql: string): void => {
      if (sql.includes('checkout_sessions')) calls.push(`${kind}:${inside > 0 ? 'dentro' : 'fora'}`);
    };
    // Espião sobre o Db real: registra se cada acesso à tabela ocorreu dentro de transaction().
    // (test/db-db.test.ts garante que transaction() é BEGIN IMMEDIATE.)
    const spy: Db = {
      exec: (sql) => db.exec(sql),
      run: (sql, params) => {
        tag('run', sql);
        return db.run(sql, params);
      },
      get: <T>(sql: string, params?: Parameters<Db['get']>[1]) => {
        tag('get', sql);
        return db.get<T>(sql, params);
      },
      all: <T>(sql: string, params?: Parameters<Db['all']>[1]) => {
        tag('all', sql);
        return db.all<T>(sql, params);
      },
      transaction: <T>(fn: () => T): T =>
        db.transaction(() => {
          inside += 1;
          try {
            return fn();
          } finally {
            inside -= 1;
          }
        }),
      close: () => db.close(),
    };
    const sessions = createSessionRepo(spy);

    assert.equal(sessions.insertPending(makeSession(), T0).inserted, true);
    assert.ok(calls.includes('get:dentro'), 'a consulta da sessão viva deve ocorrer dentro da transação');
    assert.ok(calls.includes('run:dentro'), 'o INSERT deve ocorrer dentro da transação');
    assert.deepEqual(calls.filter((call) => call.endsWith(':fora')), []);

    calls.length = 0;
    assert.equal(sessions.insertPending(makeSession(), T0).inserted, false);
    assert.deepEqual(calls.filter((call) => call.endsWith(':fora')), []);
    assert.ok(!calls.some((call) => call.startsWith('run:')), 'sem sessão nova não deve haver escrita');
  });

  it('entre conexões: quem chega durante a escrita de outra espera a trava e depois vê a sessão', () => {
    const { first, second, a, b } = fileRepos();
    const mine = makeSession();
    const theirs = makeSession();

    first.transaction(() => {
      assert.equal(a.insertPending(mine, T0).inserted, true);
      // A segunda conexão não chega a decidir "não existe sessão viva" enquanto a primeira
      // não confirma: o BEGIN IMMEDIATE dela falha (aqui sem espera; em produção, aguarda).
      assert.throws(() => b.insertPending(theirs, T0), /locked|busy/i);
    });

    const result = b.insertPending(theirs, at(SECOND));
    assert.equal(result.inserted, false);
    assert.equal(result.session.id, mine.id);
    assert.equal(tableCount(second, 'checkout_sessions'), 1);
  });

  it('dentro de uma transação externa desfeita, nada fica gravado', () => {
    const { sessions, db } = fresh();
    const session = makeSession();
    assert.throws(
      () =>
        db.transaction(() => {
          assert.equal(sessions.insertPending(session, T0).inserted, true);
          throw new Error('falha depois de inserir');
        }),
      /falha depois de inserir/,
    );
    assert.equal(sessions.get(session.id), null);
    assert.equal(sessions.insertPending(session, T0).inserted, true);
  });

  it('falha no INSERT não deixa transação aberta nem linha pela metade', () => {
    const { sessions, db } = fresh();
    const first = insert(sessions, { idempotencyKey: 'chave-a' });
    expectBridgeError(() => sessions.insertPending(makeSession({ id: first.id, idempotencyKey: 'chave-b' }), T0), 'conflict');
    // Se a transação tivesse ficado aberta, este BEGIN falharia.
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    assert.equal(insert(sessions, { idempotencyKey: 'chave-b' }).status, 'pending');
    assert.equal(tableCount(db, 'checkout_sessions'), 2);
  });
});

describe('markCreated / markFailed / get', () => {
  it('markCreated grava o resultado e limpa o código de erro', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markCreated(created.id, CREATED_PATCH);

    assert.deepEqual(sessions.get(created.id), {
      ...created,
      status: 'created',
      strategy: 'storefront_cart',
      checkoutUrl: CREATED_PATCH.checkoutUrl,
      cartId: CREATED_PATCH.cartId,
      subtotal: '79.80',
      currency: 'BRL',
      errorCode: null,
    });
  });

  it('markCreated aceita permalink sem carrinho nem subtotal', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markCreated(created.id, {
      strategy: 'permalink',
      checkoutUrl: 'https://loja.example.com/cart/91:2',
      cartId: null,
      subtotal: null,
      currency: null,
    });
    const stored = sessions.get(created.id);
    assert.equal(stored?.status, 'created');
    assert.equal(stored?.strategy, 'permalink');
    assert.equal(stored?.cartId, null);
    assert.equal(stored?.subtotal, null);
    assert.equal(stored?.currency, null);
  });

  it('markCreated em id desconhecido lança not_found e não mexe nas outras sessões', () => {
    const { sessions } = fresh();
    const other = insert(sessions);
    expectBridgeError(() => sessions.markCreated('cs_nao_existe', CREATED_PATCH), 'not_found');
    assert.deepEqual(sessions.get(other.id), other);
  });

  it('markCreated recusa estratégia inválida e URL vazia sem alterar a sessão', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    const badStrategy = { ...CREATED_PATCH, strategy: 'outra' } as unknown as Parameters<SessionRepo['markCreated']>[1];
    expectBridgeError(() => sessions.markCreated(created.id, badStrategy), 'invalid_request');
    expectBridgeError(() => sessions.markCreated(created.id, { ...CREATED_PATCH, checkoutUrl: '' }), 'invalid_request');
    assert.deepEqual(sessions.get(created.id), created);
  });

  it('markFailed grava status e código de erro', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markFailed(created.id, 'price_divergence');
    assert.deepEqual(sessions.get(created.id), { ...created, status: 'failed', errorCode: 'price_divergence' });
  });

  it('markCreated depois de markFailed deixa a sessão criada e sem código de erro', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    sessions.markFailed(created.id, 'upstream_unavailable');
    sessions.markCreated(created.id, CREATED_PATCH);
    const stored = sessions.get(created.id);
    assert.equal(stored?.status, 'created');
    assert.equal(stored?.errorCode, null);
    assert.deepEqual(sessions.stats(T0).byError, {});
  });

  it('markFailed em id desconhecido lança not_found', () => {
    const { sessions } = fresh();
    const other = insert(sessions);
    expectBridgeError(() => sessions.markFailed('cs_nao_existe', 'internal'), 'not_found');
    assert.deepEqual(sessions.get(other.id), other);
  });

  it('markFailed recusa código de erro vazio sem alterar a sessão', () => {
    const { sessions } = fresh();
    const created = insert(sessions);
    const empty = '' as unknown as BridgeErrorCode;
    expectBridgeError(() => sessions.markFailed(created.id, empty), 'invalid_request');
    assert.deepEqual(sessions.get(created.id), created);
  });

  it('as transições alteram só a sessão indicada', () => {
    const { sessions } = fresh();
    const a = insert(sessions, { idempotencyKey: 'k-a' });
    const b = insert(sessions, { idempotencyKey: 'k-b' });
    const c = insert(sessions, { idempotencyKey: 'k-c' });
    sessions.markCreated(a.id, CREATED_PATCH);
    sessions.markFailed(b.id, 'internal');
    assert.equal(sessions.get(a.id)?.status, 'created');
    assert.equal(sessions.get(b.id)?.status, 'failed');
    assert.equal(sessions.get(b.id)?.checkoutUrl, null);
    assert.deepEqual(sessions.get(c.id), c);
  });

  it('get devolve null para id desconhecido', () => {
    const { sessions } = fresh();
    insert(sessions);
    assert.equal(sessions.get('cs_nao_existe'), null);
    assert.equal(sessions.get(''), null);
  });
});

describe('list', () => {
  function seed(sessions: SessionRepo): { a: CheckoutSession; b: CheckoutSession; c: CheckoutSession; d: CheckoutSession } {
    const a = insert(sessions, { idempotencyKey: 'k-a', vitrineStoreId: 'st_v1', checkoutStoreId: 'st_c1', createdAt: at(1000) });
    const b = insert(sessions, { idempotencyKey: 'k-b', vitrineStoreId: 'st_v1', checkoutStoreId: 'st_c2', createdAt: at(3000) });
    const c = insert(sessions, { idempotencyKey: 'k-c', vitrineStoreId: 'st_v2', checkoutStoreId: 'st_c1', createdAt: at(2000) });
    const d = insert(sessions, { idempotencyKey: 'k-d', vitrineStoreId: 'st_v2', checkoutStoreId: 'st_c2', createdAt: at(4000) });
    sessions.markCreated(a.id, CREATED_PATCH);
    sessions.markFailed(b.id, 'upstream_unavailable');
    sessions.markCreated(d.id, CREATED_PATCH);
    return { a, b, c, d };
  }

  const ids = (rows: CheckoutSession[]): string[] => rows.map((row) => row.id);

  it('devolve as mais novas primeiro, independentemente da ordem de inserção', () => {
    const { sessions } = fresh();
    const { a, b, c, d } = seed(sessions);
    assert.deepEqual(ids(sessions.list({ limit: 10, offset: 0 })), [d.id, b.id, c.id, a.id]);
  });

  it('no mesmo instante, a inserida por último vem primeiro', () => {
    const { sessions } = fresh();
    const first = insert(sessions, { idempotencyKey: 'k-1' });
    const second = insert(sessions, { idempotencyKey: 'k-2' });
    const third = insert(sessions, { idempotencyKey: 'k-3' });
    assert.deepEqual(ids(sessions.list({ limit: 10, offset: 0 })), [third.id, second.id, first.id]);
    // Com filtro o SQLite percorre outro índice; o desempate não pode depender do plano.
    assert.deepEqual(ids(sessions.list({ limit: 10, offset: 0, vitrineStoreId: 'st_vitrine' })), [third.id, second.id, first.id]);
    assert.deepEqual(ids(sessions.list({ limit: 10, offset: 0, status: 'pending' })), [third.id, second.id, first.id]);
    assert.deepEqual(ids(sessions.list({ limit: 2, offset: 1, checkoutStoreId: 'st_checkout' })), [second.id, first.id]);
  });

  it('filtra por vitrine, por checkout, por status e pela combinação', () => {
    const { sessions } = fresh();
    const { a, b, c, d } = seed(sessions);
    const page = { limit: 10, offset: 0 };

    assert.deepEqual(ids(sessions.list({ ...page, vitrineStoreId: 'st_v1' })), [b.id, a.id]);
    assert.deepEqual(ids(sessions.list({ ...page, checkoutStoreId: 'st_c1' })), [c.id, a.id]);
    assert.deepEqual(ids(sessions.list({ ...page, status: 'created' })), [d.id, a.id]);
    assert.deepEqual(ids(sessions.list({ ...page, status: 'failed' })), [b.id]);
    assert.deepEqual(ids(sessions.list({ ...page, status: 'pending' })), [c.id]);
    assert.deepEqual(ids(sessions.list({ ...page, vitrineStoreId: 'st_v2', checkoutStoreId: 'st_c2', status: 'created' })), [d.id]);
    assert.deepEqual(ids(sessions.list({ ...page, vitrineStoreId: 'st_v1', status: 'pending' })), []);
    assert.deepEqual(ids(sessions.list({ ...page, vitrineStoreId: 'st_inexistente' })), []);
  });

  it('pagina com limit e offset', () => {
    const { sessions } = fresh();
    const { a, b, c, d } = seed(sessions);
    assert.deepEqual(ids(sessions.list({ limit: 2, offset: 0 })), [d.id, b.id]);
    assert.deepEqual(ids(sessions.list({ limit: 2, offset: 2 })), [c.id, a.id]);
    assert.deepEqual(ids(sessions.list({ limit: 2, offset: 3 })), [a.id]);
    assert.deepEqual(ids(sessions.list({ limit: 2, offset: 4 })), []);
    assert.deepEqual(ids(sessions.list({ limit: 0, offset: 0 })), []);
    assert.deepEqual(ids(sessions.list({ limit: 1, offset: 1, checkoutStoreId: 'st_c2' })), [b.id]);
  });

  it('saneia limit e offset inválidos em vez de repassá-los ao SQL', () => {
    const { sessions } = fresh();
    const { d } = seed(sessions);
    assert.equal(sessions.list({ limit: -5, offset: -3 }).length, 0);
    assert.equal(sessions.list({ limit: Number.NaN, offset: Number.NaN }).length, 4);
    assert.deepEqual(ids(sessions.list({ limit: 1.9, offset: 0.9 })), [d.id]);
    assert.equal(sessions.list({ limit: 1e9, offset: 0 }).length, 4);
  });

  it('recusa status inválido', () => {
    const { sessions } = fresh();
    const status = "created' OR '1'='1" as unknown as CheckoutSession['status'];
    expectBridgeError(() => sessions.list({ limit: 10, offset: 0, status }), 'invalid_request');
  });

  it('devolve sessões completas, com linhas e resultado', () => {
    const { sessions } = fresh();
    const { a } = seed(sessions);
    const [row] = sessions.list({ limit: 1, offset: 0, checkoutStoreId: 'st_c1', status: 'created' });
    assert.deepEqual(row, sessions.get(a.id));
    assert.equal(row?.checkoutUrl, CREATED_PATCH.checkoutUrl);
    assert.deepEqual(row?.lines, a.lines);
  });
});

describe('stats', () => {
  let keySeq = 0;

  function add(
    sessions: SessionRepo,
    outcome: 'created' | 'pending' | BridgeErrorCode,
    overrides: Partial<CheckoutSession> = {},
  ): CheckoutSession {
    keySeq += 1;
    const session = insert(sessions, { idempotencyKey: `stats-${keySeq}`, ...overrides });
    if (outcome === 'created') sessions.markCreated(session.id, CREATED_PATCH);
    else if (outcome !== 'pending') sessions.markFailed(session.id, outcome);
    return session;
  }

  it('sem sessões devolve zeros e mapas vazios', () => {
    const { sessions } = fresh();
    assert.deepEqual(sessions.stats(T0), { since: T0, created: 0, failed: 0, byError: {}, byCheckoutStore: {} });
  });

  it('agrega criadas e falhas, falhas por código e criadas por loja checkout', () => {
    const { sessions } = fresh();
    add(sessions, 'created', { checkoutStoreId: 'st_c1' });
    add(sessions, 'created', { checkoutStoreId: 'st_c1' });
    add(sessions, 'created', { checkoutStoreId: 'st_c2' });
    add(sessions, 'upstream_unavailable', { checkoutStoreId: 'st_c1' });
    add(sessions, 'upstream_unavailable', { checkoutStoreId: 'st_c2' });
    add(sessions, 'price_divergence', { checkoutStoreId: 'st_c2' });
    add(sessions, 'pending', { checkoutStoreId: 'st_c3' });

    assert.deepEqual(sessions.stats(T0), {
      since: T0,
      created: 3,
      failed: 3,
      byError: { upstream_unavailable: 2, price_divergence: 1 },
      // Só sessões criadas entram por loja: falhas e pendentes não contam como checkout feito.
      byCheckoutStore: { st_c1: 2, st_c2: 1 },
    });
  });

  it('conta a partir de "since", inclusive', () => {
    const { sessions } = fresh();
    add(sessions, 'created', { createdAt: at(-1) });
    add(sessions, 'internal', { createdAt: at(-1) });
    add(sessions, 'created', { createdAt: T0 });
    add(sessions, 'no_route', { createdAt: T0 });
    add(sessions, 'created', { createdAt: at(MINUTE) });

    const stats = sessions.stats(T0);
    assert.equal(stats.created, 2);
    assert.equal(stats.failed, 1);
    assert.deepEqual(stats.byError, { no_route: 1 });
    assert.equal(sessions.stats(at(1)).created, 1);
    assert.equal(sessions.stats(at(1)).failed, 0);
    assert.equal(sessions.stats(at(-1)).created, 3);
    assert.equal(sessions.stats(at(-1)).failed, 2);
  });

  it('normaliza "since" e recusa data inválida', () => {
    const { sessions } = fresh();
    add(sessions, 'created');
    const stats = sessions.stats('2026-01-01T00:00:00Z');
    assert.equal(stats.since, T0);
    assert.equal(stats.created, 1);
    expectBridgeError(() => sessions.stats('semana passada'), 'invalid_request');
  });

  it('falha sem código (linha antiga ou escrita à mão) entra como internal', () => {
    const { sessions, db } = fresh();
    const session = add(sessions, 'pending');
    db.run("UPDATE checkout_sessions SET status = 'failed', error_code = NULL WHERE id = ?", [session.id]);
    add(sessions, 'internal');
    assert.deepEqual(sessions.stats(T0).byError, { internal: 2 });
  });

  it('chaves vindas do banco não alcançam o protótipo dos contadores', () => {
    const { sessions } = fresh();
    add(sessions, 'created', { checkoutStoreId: '__proto__' });
    add(sessions, 'created', { checkoutStoreId: 'constructor' });
    add(sessions, 'created', { checkoutStoreId: 'toString' });
    add(sessions, 'created', { checkoutStoreId: 'toString' });

    const stats = sessions.stats(T0);
    assert.equal(stats.created, 4);
    assert.equal(Object.getPrototypeOf(stats.byCheckoutStore), Object.prototype);
    assert.equal(stats.byCheckoutStore['constructor'], 1);
    assert.equal(stats.byCheckoutStore['toString'], 2);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

describe('purgeExpired', () => {
  it('remove só as sessões que expiraram antes da data e devolve quantas removeu', () => {
    const { sessions, db } = fresh();
    const old = insert(sessions, { idempotencyKey: 'k-1', expiresAt: at(MINUTE) });
    const oldFailed = insert(sessions, { idempotencyKey: 'k-2', expiresAt: at(2 * MINUTE) });
    sessions.markFailed(oldFailed.id, 'internal');
    const edge = insert(sessions, { idempotencyKey: 'k-3', expiresAt: at(5 * MINUTE) });
    const recent = insert(sessions, { idempotencyKey: 'k-4', expiresAt: at(10 * MINUTE) });
    sessions.markCreated(recent.id, CREATED_PATCH);

    // Limite: expires_at igual à data de corte fica.
    assert.equal(sessions.purgeExpired(at(5 * MINUTE)), 2);
    assert.equal(sessions.get(old.id), null);
    assert.equal(sessions.get(oldFailed.id), null);
    assert.equal(sessions.get(edge.id)?.id, edge.id);
    assert.equal(sessions.get(recent.id)?.status, 'created');
    assert.equal(tableCount(db, 'checkout_sessions'), 2);

    assert.equal(sessions.purgeExpired(at(5 * MINUTE)), 0);
    assert.equal(sessions.purgeExpired('2026-01-01T00:05:00.001Z'), 1);
    assert.equal(sessions.purgeExpired(at(60 * MINUTE)), 1);
    assert.equal(tableCount(db, 'checkout_sessions'), 0);
  });

  it('recusa data inválida sem apagar nada', () => {
    const { sessions, db } = fresh();
    insert(sessions);
    expectBridgeError(() => sessions.purgeExpired(''), 'invalid_request');
    expectBridgeError(() => sessions.purgeExpired('tudo'), 'invalid_request');
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
  });
});

describe('scrubExpired', () => {
  it('apaga URL e id do carrinho só das sessões criadas que já expiraram, mantendo o resto', () => {
    const { sessions } = fresh();
    const expiredCreated = insert(sessions, { idempotencyKey: 'k-1', expiresAt: at(MINUTE) });
    sessions.markCreated(expiredCreated.id, CREATED_PATCH);
    const liveCreated = insert(sessions, { idempotencyKey: 'k-2', expiresAt: at(10 * MINUTE) });
    sessions.markCreated(liveCreated.id, CREATED_PATCH);
    const expiredPending = insert(sessions, { idempotencyKey: 'k-3', expiresAt: at(MINUTE) });
    const expiredFailed = insert(sessions, { idempotencyKey: 'k-4', expiresAt: at(MINUTE) });
    sessions.markFailed(expiredFailed.id, 'price_divergence');
    const edge = insert(sessions, { idempotencyKey: 'k-5', expiresAt: at(5 * MINUTE) });
    sessions.markCreated(edge.id, CREATED_PATCH);

    // Limite: expires_at igual ao agora não conta como expirada.
    assert.equal(sessions.scrubExpired(at(5 * MINUTE)), 1);

    const scrubbed = sessions.get(expiredCreated.id);
    assert.ok(scrubbed);
    assert.equal(scrubbed.status, 'created');
    assert.equal(scrubbed.checkoutUrl, null);
    assert.equal(scrubbed.cartId, null);
    assert.equal(scrubbed.subtotal, CREATED_PATCH.subtotal, 'subtotal fica para o histórico');
    assert.equal(scrubbed.currency, CREATED_PATCH.currency);
    assert.equal(scrubbed.strategy, CREATED_PATCH.strategy);
    assert.deepEqual(scrubbed.lines, expiredCreated.lines);

    assert.equal(sessions.get(liveCreated.id)?.checkoutUrl, CREATED_PATCH.checkoutUrl, 'sessão viva mantém a URL');
    assert.equal(sessions.get(edge.id)?.checkoutUrl, CREATED_PATCH.checkoutUrl);
    assert.equal(sessions.get(expiredPending.id)?.status, 'pending');
    assert.equal(sessions.get(expiredFailed.id)?.errorCode, 'price_divergence');

    // Idempotente: a segunda passada não encontra mais nada; passado o tempo, limpa as demais.
    assert.equal(sessions.scrubExpired(at(5 * MINUTE)), 0);
    assert.equal(sessions.scrubExpired(at(5 * MINUTE + 1)), 1);
    assert.equal(sessions.scrubExpired(at(60 * MINUTE)), 1);
    assert.equal(sessions.get(liveCreated.id)?.checkoutUrl, null);
  });

  it('não interfere na reutilização da sessão viva pela idempotência', () => {
    const { sessions } = fresh();
    const live = insert(sessions, { idempotencyKey: 'k-live', expiresAt: at(10 * MINUTE) });
    sessions.markCreated(live.id, CREATED_PATCH);
    assert.equal(sessions.scrubExpired(at(MINUTE)), 0);
    assert.equal(sessions.findActiveByKey('k-live', at(MINUTE))?.checkoutUrl, CREATED_PATCH.checkoutUrl);
  });

  it('recusa data inválida sem alterar nada', () => {
    const { sessions } = fresh();
    const s = insert(sessions, { expiresAt: at(MINUTE) });
    sessions.markCreated(s.id, CREATED_PATCH);
    expectBridgeError(() => sessions.scrubExpired(''), 'invalid_request');
    expectBridgeError(() => sessions.scrubExpired('tudo'), 'invalid_request');
    assert.equal(sessions.get(s.id)?.checkoutUrl, CREATED_PATCH.checkoutUrl);
  });
});

describe('histórico independente das lojas', () => {
  it('as sessões sobrevivem à exclusão das lojas e da rota a que se referem', () => {
    const { sessions, repos, db } = fresh();
    const vitrine = makeStore(repos, 'vitrine');
    const checkout = makeStore(repos, 'checkout');
    const link = repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const done = insert(sessions, {
      idempotencyKey: 'k-1',
      vitrineStoreId: vitrine.id,
      checkoutStoreId: checkout.id,
      linkId: link.id,
    });
    sessions.markCreated(done.id, CREATED_PATCH);
    const failed = insert(sessions, {
      idempotencyKey: 'k-2',
      vitrineStoreId: vitrine.id,
      checkoutStoreId: checkout.id,
      linkId: link.id,
    });
    sessions.markFailed(failed.id, 'upstream_rejected');
    const before = sessions.get(done.id);

    repos.stores.delete(vitrine.id);
    repos.stores.delete(checkout.id);

    assert.equal(tableCount(db, 'stores'), 0);
    assert.equal(tableCount(db, 'links'), 0);
    assert.equal(tableCount(db, 'checkout_sessions'), 2);
    assert.deepEqual(sessions.get(done.id), before);
    assert.equal(sessions.list({ limit: 10, offset: 0, checkoutStoreId: checkout.id }).length, 2);
    assert.deepEqual(sessions.stats(T0).byCheckoutStore, { [checkout.id]: 1 });
    // E continuam valendo para a idempotência.
    assert.equal(sessions.findActiveByKey('k-1', at(MINUTE))?.id, done.id);
  });

  it('aceita ids de loja e de rota que nunca existiram (não há chave estrangeira)', () => {
    const { sessions } = fresh();
    const created = insert(sessions, { vitrineStoreId: 'st_fantasma', checkoutStoreId: 'st_fantasma_2', linkId: 'ln_fantasma' });
    assert.equal(sessions.get(created.id)?.vitrineStoreId, 'st_fantasma');
  });
});
