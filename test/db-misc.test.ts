import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createAdminSessionRepo, createAuditRepo, createWebhookEventRepo } from '../src/db/misc-repos.ts';
import { migrate } from '../src/db/schema.ts';
import { fakeClock } from '../src/lib/clock.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import type { AdminSession, AuditEntry, NewAuditEntry } from '../src/types.ts';
import { at, expectBridgeError, makeStore, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/** AuditRepo, WebhookEventRepo e AdminSessionRepo sobre um banco em memória migrado. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const open: Db[] = [];
const tempDirs: string[] = [];

function fresh(): TestContext {
  const ctx = setup();
  open.push(ctx.db);
  return ctx;
}

/** Duas conexões para o mesmo arquivo, como dois processos do serviço. */
function twoConnections(): { first: Db; second: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-misc-'));
  tempDirs.push(dir);
  const path = join(dir, 'misc.db');
  const first = openDatabase(path);
  const second = openDatabase(path);
  open.push(first, second);
  migrate(first);
  // Sem espera na segunda conexão, para o teste não ficar parado no busy_timeout.
  second.exec('PRAGMA busy_timeout = 0');
  return { first, second };
}

function entry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return { actor: 'admin', action: 'store.update', targetType: 'store', targetId: 'st_1', detail: {}, ...overrides };
}

const actions = (rows: AuditEntry[]): string[] => rows.map((row) => row.action);
const ALL = { limit: 100, offset: 0 };

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AuditRepo.record', () => {
  it('carimba "at" com o relógio injetado', () => {
    const { repos, clock } = fresh();
    clock.set('2026-03-10T12:34:56.789Z');
    repos.audit.record(entry({ action: 'primeira' }));
    clock.advance(1500);
    repos.audit.record(entry({ action: 'segunda' }));

    const [second, first] = repos.audit.list(ALL);
    assert.equal(first?.at, '2026-03-10T12:34:56.789Z');
    assert.equal(second?.at, '2026-03-10T12:34:58.289Z');
  });

  it('ignora "at" e "id" que venham de carona no objeto', () => {
    const { repos } = fresh();
    const smuggled = { ...entry(), at: '1999-01-01T00:00:00.000Z', id: 999 };
    repos.audit.record(smuggled);
    const [row] = repos.audit.list(ALL);
    assert.equal(row?.at, T0);
    assert.equal(row?.id, 1);
  });

  it('devolve a entrada completa, com ids crescentes', () => {
    const { repos } = fresh();
    repos.audit.record(entry({ actor: 'webhook', action: 'product.update', targetType: 'product', targetId: '123' }));
    repos.audit.record(entry({ actor: 'system', action: 'sync.finish' }));

    const [newer, older] = repos.audit.list(ALL);
    assert.deepEqual(older, {
      id: 1,
      at: T0,
      actor: 'webhook',
      action: 'product.update',
      targetType: 'product',
      targetId: '123',
      detail: {},
    });
    assert.equal(newer?.id, 2);
    assert.equal(typeof newer?.id, 'number');
  });

  it('alvo nulo faz ida e volta como null', () => {
    const { repos } = fresh();
    repos.audit.record(entry({ targetType: null, targetId: null }));
    const [row] = repos.audit.list(ALL);
    assert.equal(row?.targetType, null);
    assert.equal(row?.targetId, null);
  });

  it('detail faz ida e volta como JSON', () => {
    const { repos, db } = fresh();
    const detail = {
      before: { name: 'Loja A', enabled: true, countries: ['BR', 'PT'] },
      after: { name: 'Loja "B" — ação', enabled: false, countries: [] },
      count: 42,
      ratio: 0.25,
      nothing: null,
      nested: { deep: { deeper: [1, 'dois', { tres: 3 }] } },
      variantId: '50123456789012345678',
    };
    repos.audit.record(entry({ detail }));

    assert.deepEqual(repos.audit.list(ALL)[0]?.detail, detail);
    const raw = db.get<{ detail: string }>('SELECT detail FROM audit_log')?.detail;
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(String(raw)), detail);
  });

  it('censura chaves sensíveis em qualquer profundidade, sem depender de maiúsculas', () => {
    const { repos, db } = fresh();
    repos.audit.record(
      entry({
        detail: {
          name: 'Loja A',
          clientSecret: 'shpss_abc',
          nested: { access_token: 'shpat_xyz', list: [{ PASSWORD: 'hunter2' }, { ok: 1 }] },
          Authorization: 'Bearer zzz',
          buyerIp: '203.0.113.9',
        },
      }),
    );

    const raw = String(db.get<{ detail: string }>('SELECT detail FROM audit_log')?.detail);
    for (const secret of ['shpss_abc', 'shpat_xyz', 'hunter2', 'Bearer zzz', '203.0.113.9']) {
      assert.ok(!raw.includes(secret), `o segredo ${secret} não pode ser gravado`);
    }
    const stored = repos.audit.list(ALL)[0]?.detail as Record<string, unknown>;
    assert.equal(stored['name'], 'Loja A');
    assert.notEqual(stored['clientSecret'], undefined);
    assert.deepEqual((stored['nested'] as Record<string, unknown>)['list'], [
      { PASSWORD: stored['clientSecret'] },
      { ok: 1 },
    ]);
  });

  it('detail que não é objeto, circular ou grande demais não impede o registro', () => {
    const { repos } = fresh();
    const circular: Record<string, unknown> = { name: 'a' };
    circular['self'] = circular;
    repos.audit.record(entry({ action: 'nao-objeto', detail: 'texto' as unknown as Record<string, unknown> }));
    repos.audit.record(entry({ action: 'lista', detail: [1, 2] as unknown as Record<string, unknown> }));
    repos.audit.record(entry({ action: 'nulo', detail: null as unknown as Record<string, unknown> }));
    repos.audit.record(entry({ action: 'circular', detail: circular }));
    repos.audit.record(entry({ action: 'enorme', detail: { blob: 'x'.repeat(20_000) } }));
    repos.audit.record(entry({ action: 'bigint', detail: { n: 2n ** 70n } as unknown as Record<string, unknown> }));

    const byAction = new Map(repos.audit.list(ALL).map((row) => [row.action, row.detail]));
    assert.deepEqual(byAction.get('nao-objeto'), {});
    assert.deepEqual(byAction.get('lista'), {});
    assert.deepEqual(byAction.get('nulo'), {});
    assert.deepEqual(byAction.get('circular'), { unserializable: true });
    assert.deepEqual(byAction.get('enorme'), { truncated: true });
    assert.deepEqual(byAction.get('bigint'), { n: (2n ** 70n).toString() });
  });

  it('coluna detail corrompida no banco vira objeto vazio na leitura', () => {
    const { repos, db } = fresh();
    repos.audit.record(entry());
    db.run('UPDATE audit_log SET detail = ?', ['{quebrado']);
    assert.deepEqual(repos.audit.list(ALL)[0]?.detail, {});
    db.run('UPDATE audit_log SET detail = ?', ['[1,2]']);
    assert.deepEqual(repos.audit.list(ALL)[0]?.detail, {});
  });

  it('exige ator e ação', () => {
    const { repos, db } = fresh();
    expectBridgeError(() => repos.audit.record(entry({ actor: '' })), 'invalid_request');
    expectBridgeError(() => repos.audit.record(entry({ action: '   ' })), 'invalid_request');
    expectBridgeError(() => repos.audit.record(entry({ actor: undefined as unknown as string })), 'invalid_request');
    assert.equal(tableCount(db, 'audit_log'), 0);
  });

  it('valores hostis entram como dado, nunca como SQL', () => {
    const { repos, db } = fresh();
    const hostile = "x'); DROP TABLE audit_log; --";
    repos.audit.record(entry({ action: hostile, targetType: hostile, targetId: hostile, detail: { note: hostile } }));
    const [row] = repos.audit.list({ ...ALL, targetType: hostile, targetId: hostile });
    assert.equal(row?.action, hostile);
    assert.deepEqual(row?.detail, { note: hostile });
    assert.deepEqual(repos.audit.list({ ...ALL, targetType: "x' OR '1'='1" }), []);
    assert.equal(tableCount(db, 'audit_log'), 1);
  });

  it('o registro sobrevive à exclusão da loja a que se refere', () => {
    const { repos } = fresh();
    const store = makeStore(repos, 'vitrine');
    repos.audit.record(entry({ action: 'store.create', targetId: store.id }));
    repos.stores.delete(store.id);
    const rows = repos.audit.list({ ...ALL, targetType: 'store', targetId: store.id });
    assert.ok(actions(rows).includes('store.create'));
  });

  it('participa da transação de quem chama', () => {
    const { repos, db } = fresh();
    assert.throws(
      () =>
        db.transaction(() => {
          repos.audit.record(entry());
          throw new Error('desfaz');
        }),
      /desfaz/,
    );
    assert.equal(tableCount(db, 'audit_log'), 0);
  });
});

describe('AuditRepo.list', () => {
  function seed(ctx: TestContext): void {
    const { repos, clock } = ctx;
    const rows: Array<[string, string | null, string | null]> = [
      ['a1', 'store', 'st_1'],
      ['a2', 'store', 'st_2'],
      ['a3', 'link', 'ln_1'],
      ['a4', 'store', 'st_1'],
      ['a5', null, null],
      ['a6', 'link', 'st_1'],
    ];
    for (const [action, targetType, targetId] of rows) {
      repos.audit.record(entry({ action, targetType, targetId }));
      clock.advance(SECOND);
    }
  }

  it('devolve as mais novas primeiro', () => {
    const ctx = fresh();
    seed(ctx);
    const rows = ctx.repos.audit.list(ALL);
    assert.deepEqual(actions(rows), ['a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
    assert.deepEqual(rows.map((row) => row.at), [5, 4, 3, 2, 1, 0].map((s) => at(s * SECOND)));
  });

  it('no mesmo milissegundo, a gravada por último vem primeiro', () => {
    const { repos } = fresh();
    for (const action of ['x1', 'x2', 'x3']) repos.audit.record(entry({ action }));
    assert.deepEqual(actions(repos.audit.list(ALL)), ['x3', 'x2', 'x1']);
    // Com filtro o SQLite percorre outro índice; o desempate não pode depender do plano.
    assert.deepEqual(actions(repos.audit.list({ ...ALL, targetType: 'store' })), ['x3', 'x2', 'x1']);
    assert.deepEqual(actions(repos.audit.list({ limit: 2, offset: 1, targetId: 'st_1' })), ['x2', 'x1']);
  });

  it('"mais nova" é a gravada por último, mesmo que o relógio do servidor tenha recuado', () => {
    const { repos, clock } = fresh();
    clock.set(at(10 * SECOND));
    repos.audit.record(entry({ action: 'antes-do-ajuste' }));
    clock.set(T0);
    repos.audit.record(entry({ action: 'depois-do-ajuste' }));
    assert.deepEqual(actions(repos.audit.list(ALL)), ['depois-do-ajuste', 'antes-do-ajuste']);
  });

  it('filtra por targetType, por targetId e pelos dois juntos', () => {
    const ctx = fresh();
    seed(ctx);
    const { audit } = ctx.repos;
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'store' })), ['a4', 'a2', 'a1']);
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'link' })), ['a6', 'a3']);
    assert.deepEqual(actions(audit.list({ ...ALL, targetId: 'st_1' })), ['a6', 'a4', 'a1']);
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'store', targetId: 'st_1' })), ['a4', 'a1']);
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'link', targetId: 'st_1' })), ['a6']);
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'store', targetId: 'ln_1' })), []);
    assert.deepEqual(actions(audit.list({ ...ALL, targetType: 'produto' })), []);
  });

  it('pagina com limit e offset, também junto com filtro', () => {
    const ctx = fresh();
    seed(ctx);
    const { audit } = ctx.repos;
    assert.deepEqual(actions(audit.list({ limit: 2, offset: 0 })), ['a6', 'a5']);
    assert.deepEqual(actions(audit.list({ limit: 2, offset: 2 })), ['a4', 'a3']);
    assert.deepEqual(actions(audit.list({ limit: 4, offset: 4 })), ['a2', 'a1']);
    assert.deepEqual(actions(audit.list({ limit: 2, offset: 6 })), []);
    assert.deepEqual(actions(audit.list({ limit: 0, offset: 0 })), []);
    assert.deepEqual(actions(audit.list({ limit: 1, offset: 1, targetType: 'store' })), ['a2']);
    assert.deepEqual(actions(audit.list({ limit: 2, offset: 2, targetType: 'store' })), ['a1']);
  });

  it('saneia limit e offset inválidos', () => {
    const ctx = fresh();
    seed(ctx);
    const { audit } = ctx.repos;
    assert.equal(audit.list({ limit: -1, offset: -1 }).length, 0);
    assert.equal(audit.list({ limit: Number.NaN, offset: Number.NaN }).length, 6);
    assert.deepEqual(actions(audit.list({ limit: 1.9, offset: 1.9 })), ['a5']);
    assert.equal(audit.list({ limit: 1e12, offset: 0 }).length, 6);
  });
});

describe('AuditRepo.purge', () => {
  it('remove as entradas anteriores à data e devolve quantas removeu', () => {
    const { repos, clock, db } = fresh();
    for (const action of ['d0', 'd1', 'd2', 'd3']) {
      repos.audit.record(entry({ action }));
      clock.advance(DAY);
    }

    // Limite: entrada com "at" igual à data de corte fica.
    assert.equal(repos.audit.purge(at(2 * DAY)), 2);
    assert.deepEqual(actions(repos.audit.list(ALL)), ['d3', 'd2']);
    assert.equal(repos.audit.purge(at(2 * DAY)), 0);
    assert.equal(repos.audit.purge('2026-01-03T00:00:00.001Z'), 1);
    assert.equal(repos.audit.purge(at(365 * DAY)), 1);
    assert.equal(tableCount(db, 'audit_log'), 0);
  });

  it('compara pelo instante, mesmo com a data de corte em formato não canônico', () => {
    const { repos, clock } = fresh();
    repos.audit.record(entry({ action: 'meia-noite' }));
    clock.advance(500);
    repos.audit.record(entry({ action: 'meio-segundo' }));
    // Como texto, "…00:00:00Z" ficaria depois de "…00:00:00.500Z"; como instante, antes.
    assert.equal(repos.audit.purge('2026-01-01T00:00:00Z'), 0);
    assert.equal(repos.audit.purge('2025-12-31T21:00:00.500-03:00'), 1);
    assert.deepEqual(actions(repos.audit.list(ALL)), ['meio-segundo']);
  });

  it('recusa data inválida sem apagar nada', () => {
    const { repos, db } = fresh();
    repos.audit.record(entry());
    expectBridgeError(() => repos.audit.purge(''), 'invalid_request');
    expectBridgeError(() => repos.audit.purge('sempre'), 'invalid_request');
    assert.equal(tableCount(db, 'audit_log'), 1);
  });

  it('ids não são reaproveitados depois da limpeza', () => {
    const { repos } = fresh();
    repos.audit.record(entry({ action: 'antiga' }));
    repos.audit.record(entry({ action: 'antiga-2' }));
    assert.equal(repos.audit.purge(at(DAY)), 2);
    repos.audit.record(entry({ action: 'nova' }));
    assert.equal(repos.audit.list(ALL)[0]?.id, 3);
  });

  it('usa o relógio recebido na criação do repositório', () => {
    const { db } = fresh();
    const clock = fakeClock('2030-06-01T08:00:00.000Z');
    const audit = createAuditRepo(db, { clock });
    audit.record(entry());
    assert.equal(audit.list(ALL)[0]?.at, '2030-06-01T08:00:00.000Z');
  });
});

describe('WebhookEventRepo', () => {
  it('markSeen devolve false na primeira vez e true nas repetições', () => {
    const { repos, db } = fresh();
    assert.equal(repos.webhookEvents.markSeen('evt-1', T0), false);
    assert.equal(repos.webhookEvents.markSeen('evt-1', at(SECOND)), true);
    assert.equal(repos.webhookEvents.markSeen('evt-1', at(HOUR)), true);
    assert.equal(tableCount(db, 'webhook_events'), 1);
  });

  it('ids diferentes são independentes (sem normalização de maiúsculas ou espaços)', () => {
    const { repos, db } = fresh();
    assert.equal(repos.webhookEvents.markSeen('evt-1', T0), false);
    assert.equal(repos.webhookEvents.markSeen('evt-2', T0), false);
    assert.equal(repos.webhookEvents.markSeen('EVT-1', T0), false);
    assert.equal(repos.webhookEvents.markSeen('evt-1 ', T0), false);
    assert.equal(repos.webhookEvents.markSeen('evt-2', T0), true);
    assert.equal(tableCount(db, 'webhook_events'), 4);
  });

  it('a repetição não altera a data da primeira entrega', () => {
    const { repos, db } = fresh();
    repos.webhookEvents.markSeen('evt-1', T0);
    repos.webhookEvents.markSeen('evt-1', at(DAY));
    assert.equal(db.get<{ seen_at: string }>('SELECT seen_at FROM webhook_events WHERE event_id = ?', ['evt-1'])?.seen_at, T0);
    // Por isso a limpeza usa a primeira entrega como referência.
    assert.equal(repos.webhookEvents.purge(at(HOUR)), 1);
  });

  it('valida o id e a data', () => {
    const { repos, db } = fresh();
    expectBridgeError(() => repos.webhookEvents.markSeen('', T0), 'invalid_request');
    expectBridgeError(() => repos.webhookEvents.markSeen(undefined as unknown as string, T0), 'invalid_request');
    expectBridgeError(() => repos.webhookEvents.markSeen('evt-1', 'hoje'), 'invalid_request');
    assert.equal(tableCount(db, 'webhook_events'), 0);
  });

  it('id hostil entra como dado', () => {
    const { repos, db } = fresh();
    const hostile = "a'; DELETE FROM webhook_events; --";
    assert.equal(repos.webhookEvents.markSeen('evt-1', T0), false);
    assert.equal(repos.webhookEvents.markSeen(hostile, T0), false);
    assert.equal(repos.webhookEvents.markSeen(hostile, T0), true);
    assert.equal(tableCount(db, 'webhook_events'), 2);
  });

  it('purge remove os eventos anteriores à data; depois disso o id volta a ser novo', () => {
    const { repos, db } = fresh();
    repos.webhookEvents.markSeen('velho', T0);
    repos.webhookEvents.markSeen('limite', at(DAY));
    repos.webhookEvents.markSeen('novo', at(2 * DAY));

    // Limite: seen_at igual à data de corte fica.
    assert.equal(repos.webhookEvents.purge(at(DAY)), 1);
    assert.equal(tableCount(db, 'webhook_events'), 2);
    assert.equal(repos.webhookEvents.markSeen('limite', at(3 * DAY)), true);
    assert.equal(repos.webhookEvents.markSeen('novo', at(3 * DAY)), true);
    assert.equal(repos.webhookEvents.markSeen('velho', at(3 * DAY)), false);
    assert.equal(repos.webhookEvents.purge(at(DAY)), 0);
    expectBridgeError(() => repos.webhookEvents.purge('nunca'), 'invalid_request');
  });

  it('markSeen desfeito junto com a transação de quem chama deixa o evento como novo', () => {
    const { repos, db } = fresh();
    assert.throws(
      () =>
        db.transaction(() => {
          assert.equal(repos.webhookEvents.markSeen('evt-1', T0), false);
          assert.equal(repos.webhookEvents.markSeen('evt-1', T0), true);
          throw new Error('processamento falhou');
        }),
      /processamento falhou/,
    );
    assert.equal(repos.webhookEvents.markSeen('evt-1', T0), false);
  });

  it('entre conexões: só uma entrega do mesmo evento é tratada como nova', () => {
    const { first, second } = twoConnections();
    const a = createWebhookEventRepo(first);
    const b = createWebhookEventRepo(second);

    assert.equal(a.markSeen('evt-1', T0), false);
    assert.equal(b.markSeen('evt-1', T0), true);
    assert.equal(b.markSeen('evt-2', T0), false);
    assert.equal(a.markSeen('evt-2', T0), true);

    first.transaction(() => {
      assert.equal(a.markSeen('evt-3', T0), false);
      // Enquanto a primeira não confirma, a segunda não consegue responder "novo": a
      // decisão é do próprio INSERT, que precisa da trava de escrita.
      assert.throws(() => b.markSeen('evt-3', T0), /locked|busy/i);
    });
    assert.equal(b.markSeen('evt-3', T0), true);
    assert.equal(tableCount(first, 'webhook_events'), 3);
  });
});

describe('AdminSessionRepo', () => {
  let seq = 0;

  /** Sessão com token próprio; o repositório só recebe o hash do token. */
  function makeAdminSession(overrides: Partial<AdminSession> = {}): { session: AdminSession; token: string; tokenHash: string } {
    seq += 1;
    const token = `token-em-claro-${seq}-${'t'.repeat(20)}`;
    const session: AdminSession = {
      id: `as_${seq}`,
      csrfToken: `csrf-${seq}`,
      createdAt: T0,
      expiresAt: at(8 * HOUR),
      ...overrides,
    };
    return { session, token, tokenHash: sha256Hex(token) };
  }

  it('create + findByTokenHash devolvem a sessão exatamente como no contrato', () => {
    const { repos } = fresh();
    const { session, tokenHash } = makeAdminSession();
    repos.adminSessions.create(session, tokenHash);
    assert.deepEqual(repos.adminSessions.findByTokenHash(tokenHash, T0), session);
  });

  it('guarda só o hash do token: o token em claro não aparece em coluna nenhuma', () => {
    const { repos, db } = fresh();
    const { session, token, tokenHash } = makeAdminSession();
    repos.adminSessions.create(session, tokenHash);

    const row = db.get<Record<string, unknown>>('SELECT * FROM admin_sessions');
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'csrf_token', 'expires_at', 'id', 'token_hash']);
    assert.equal(row['token_hash'], tokenHash);
    for (const value of Object.values(row)) assert.ok(!String(value).includes(token));
    // O hash não vaza pela sessão devolvida, e o token em claro não serve de chave de busca.
    const found = repos.adminSessions.findByTokenHash(tokenHash, T0);
    assert.deepEqual(Object.keys(found ?? {}).sort(), ['createdAt', 'csrfToken', 'expiresAt', 'id']);
    assert.equal(repos.adminSessions.findByTokenHash(token, T0), null);
  });

  it('findByTokenHash devolve null para hash desconhecido, vazio ou parcial', () => {
    const { repos } = fresh();
    const { session, tokenHash } = makeAdminSession();
    repos.adminSessions.create(session, tokenHash);
    assert.equal(repos.adminSessions.findByTokenHash(sha256Hex('outro'), T0), null);
    assert.equal(repos.adminSessions.findByTokenHash('', T0), null);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash.slice(0, 32), T0), null);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash.toUpperCase(), T0), null);
    assert.equal(repos.adminSessions.findByTokenHash('%', T0), null);
    assert.equal(repos.adminSessions.findByTokenHash("' OR '1'='1", T0), null);
  });

  it('ignora sessão expirada (expiresAt igual a "agora" já não vale)', () => {
    const { repos, db } = fresh();
    const { session, tokenHash } = makeAdminSession({ expiresAt: at(HOUR) });
    repos.adminSessions.create(session, tokenHash);

    assert.equal(repos.adminSessions.findByTokenHash(tokenHash, at(HOUR - 1))?.id, session.id);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash, at(HOUR)), null);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash, at(HOUR + 1)), null);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash, '2026-01-01T00:59:59Z')?.id, session.id);
    assert.equal(repos.adminSessions.findByTokenHash(tokenHash, '2026-01-01T01:00:00Z'), null);
    // Ignorar não é apagar: a linha fica até a limpeza.
    assert.equal(tableCount(db, 'admin_sessions'), 1);
    expectBridgeError(() => repos.adminSessions.findByTokenHash(tokenHash, 'agora'), 'invalid_request');
  });

  it('normaliza as datas gravadas', () => {
    const { repos } = fresh();
    const { session, tokenHash } = makeAdminSession({ createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T05:00:00-03:00' });
    repos.adminSessions.create(session, tokenHash);
    const found = repos.adminSessions.findByTokenHash(tokenHash, T0);
    assert.equal(found?.createdAt, T0);
    assert.equal(found?.expiresAt, at(8 * HOUR));
  });

  it('recusa id ou hash repetidos e campos obrigatórios vazios', () => {
    const { repos, db } = fresh();
    const first = makeAdminSession();
    const other = makeAdminSession();
    repos.adminSessions.create(first.session, first.tokenHash);

    expectBridgeError(() => repos.adminSessions.create(first.session, other.tokenHash), 'conflict');
    expectBridgeError(() => repos.adminSessions.create(other.session, first.tokenHash), 'conflict');
    expectBridgeError(() => repos.adminSessions.create({ ...other.session, id: '' }, other.tokenHash), 'invalid_request');
    expectBridgeError(() => repos.adminSessions.create(other.session, ''), 'invalid_request');
    expectBridgeError(() => repos.adminSessions.create({ ...other.session, csrfToken: '' }, other.tokenHash), 'invalid_request');
    expectBridgeError(() => repos.adminSessions.create({ ...other.session, expiresAt: 'amanhã' }, other.tokenHash), 'invalid_request');
    assert.equal(tableCount(db, 'admin_sessions'), 1);
    assert.deepEqual(repos.adminSessions.findByTokenHash(first.tokenHash, T0), first.session);
    assert.equal(repos.adminSessions.findByTokenHash(other.tokenHash, T0), null);
  });

  it('delete encerra só a sessão indicada; id desconhecido não faz nada', () => {
    const { repos, db } = fresh();
    const a = makeAdminSession();
    const b = makeAdminSession();
    repos.adminSessions.create(a.session, a.tokenHash);
    repos.adminSessions.create(b.session, b.tokenHash);

    repos.adminSessions.delete(a.session.id);
    assert.equal(repos.adminSessions.findByTokenHash(a.tokenHash, T0), null);
    assert.deepEqual(repos.adminSessions.findByTokenHash(b.tokenHash, T0), b.session);
    repos.adminSessions.delete(a.session.id);
    repos.adminSessions.delete('as_nao_existe');
    // O hash do token não serve de id: quem só conhece o hash não encerra a sessão.
    repos.adminSessions.delete(b.tokenHash);
    assert.equal(tableCount(db, 'admin_sessions'), 1);

    // Depois do logout o mesmo hash pode ser criado de novo sem conflito.
    repos.adminSessions.create(a.session, a.tokenHash);
    assert.deepEqual(repos.adminSessions.findByTokenHash(a.tokenHash, T0), a.session);
  });

  it('purgeExpired remove as sessões que expiraram antes da data e devolve quantas removeu', () => {
    const { repos, db } = fresh();
    const old = makeAdminSession({ expiresAt: at(HOUR) });
    const edge = makeAdminSession({ expiresAt: at(2 * HOUR) });
    const live = makeAdminSession({ expiresAt: at(8 * HOUR) });
    for (const item of [old, edge, live]) repos.adminSessions.create(item.session, item.tokenHash);

    // Limite: expires_at igual à data de corte fica (findByTokenHash já a ignora).
    assert.equal(repos.adminSessions.purgeExpired(at(2 * HOUR)), 1);
    assert.equal(tableCount(db, 'admin_sessions'), 2);
    assert.equal(repos.adminSessions.findByTokenHash(live.tokenHash, at(2 * HOUR))?.id, live.session.id);
    assert.equal(repos.adminSessions.purgeExpired(at(2 * HOUR)), 0);
    assert.equal(repos.adminSessions.purgeExpired(at(2 * HOUR + 1)), 1);
    assert.equal(repos.adminSessions.purgeExpired(at(30 * DAY)), 1);
    assert.equal(tableCount(db, 'admin_sessions'), 0);
    expectBridgeError(() => repos.adminSessions.purgeExpired('tudo'), 'invalid_request');
  });

  it('funciona sobre o repositório criado direto da conexão', () => {
    const { db } = fresh();
    const adminSessions = createAdminSessionRepo(db);
    const { session, tokenHash } = makeAdminSession();
    adminSessions.create(session, tokenHash);
    assert.deepEqual(adminSessions.findByTokenHash(tokenHash, at(MINUTE)), session);
  });
});

describe('JobRunRepo', () => {
  it('guarda e substitui o instante da última execução, por tarefa', () => {
    const { repos } = fresh();
    assert.equal(repos.jobRuns.getLastRunAt('catalog_resync'), null);
    repos.jobRuns.setLastRunAt('catalog_resync', at(0));
    assert.equal(repos.jobRuns.getLastRunAt('catalog_resync'), at(0));
    repos.jobRuns.setLastRunAt('catalog_resync', at(HOUR));
    assert.equal(repos.jobRuns.getLastRunAt('catalog_resync'), at(HOUR));
    // Tarefas distintas não se misturam.
    repos.jobRuns.setLastRunAt('outra', at(DAY));
    assert.equal(repos.jobRuns.getLastRunAt('catalog_resync'), at(HOUR));
    assert.equal(repos.jobRuns.getLastRunAt('outra'), at(DAY));
  });

  it('normaliza a data e recusa nome ou data inválidos', () => {
    const { repos } = fresh();
    repos.jobRuns.setLastRunAt('x', '2026-01-01T00:00:00Z');
    assert.equal(repos.jobRuns.getLastRunAt('x'), at(0));
    assert.throws(() => repos.jobRuns.setLastRunAt('x', 'ontem'));
    assert.throws(() => repos.jobRuns.setLastRunAt('', at(0)));
    assert.equal(repos.jobRuns.getLastRunAt('x'), at(0));
  });
});
