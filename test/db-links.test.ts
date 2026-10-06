import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Db, SqlParams } from '../src/db/db.ts';
import { createLinkRepo } from '../src/db/link-repo.ts';
import { isBridgeError } from '../src/types.ts';
import type { BridgeErrorCode, Link, LinkPatch, NewLink, Store } from '../src/types.ts';
import { at, expectBridgeError, makeStore, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

interface Fixture extends TestContext {
  v1: Store;
  v2: Store;
  c1: Store;
  c2: Store;
}

const open: TestContext[] = [];

/** Banco novo com duas vitrines e duas lojas checkout. */
function ctx(): Fixture {
  const context = setup();
  open.push(context);
  const { repos } = context;
  return {
    ...context,
    v1: makeStore(repos, 'vitrine'),
    v2: makeStore(repos, 'vitrine'),
    c1: makeStore(repos, 'checkout'),
    c2: makeStore(repos, 'checkout'),
  };
}

afterEach(() => {
  for (const context of open.splice(0)) context.db.close();
});

/** Passa um valor de tipo errado por uma assinatura tipada, como chegaria em tempo de execução. */
function unsafe<T>(value: unknown): T {
  return value as T;
}

/** Detalhes internos do BridgeError lançado por fn, conferindo o código. */
function errorDetails(fn: () => unknown, code: BridgeErrorCode): Record<string, unknown> {
  const err = expectBridgeError(fn, code);
  assert.ok(isBridgeError(err));
  return err.details;
}

function rawLink(db: Db, id: string): Record<string, unknown> {
  const row = db.get<Record<string, unknown>>('SELECT * FROM links WHERE id = ?', [id]);
  assert.ok(row, 'linha da rota não encontrada');
  return row;
}

const INJECTIONS = [
  "'; DROP TABLE links; --",
  "' OR '1'='1",
  '" OR ""="',
  "x'); DELETE FROM stores; --",
  "1; UPDATE links SET enabled = 1",
  "' UNION SELECT id FROM stores --",
  '%',
  '_',
  '\\',
];

describe('LinkRepo.create', () => {
  it('cria rota default com os valores padrão', () => {
    const { repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    assert.match(link.id, /^ln_[0-9a-f]{24}$/);
    assert.deepEqual(link, {
      id: link.id,
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'default',
      countries: [],
      enabled: true,
      parityPolicy: 'block',
      priceToleranceBps: 0,
      maxQuantityPerLine: 50,
      maxLines: 100,
      strategy: 'storefront_cart',
      allowPermalinkFallback: true,
      createdAt: T0,
      updatedAt: T0,
    });
    assert.deepEqual(repos.links.get(link.id), link);
  });

  it('grava os valores informados explicitamente', () => {
    const { db, repos, v1, c1 } = ctx();
    const link = repos.links.create({
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'country',
      countries: ['PT'],
      enabled: false,
      parityPolicy: 'warn',
      priceToleranceBps: 250,
      maxQuantityPerLine: 3,
      maxLines: 7,
      strategy: 'permalink',
      allowPermalinkFallback: false,
    });
    assert.equal(link.kind, 'country');
    assert.deepEqual(link.countries, ['PT']);
    assert.equal(link.enabled, false);
    assert.equal(link.parityPolicy, 'warn');
    assert.equal(link.priceToleranceBps, 250);
    assert.equal(link.maxQuantityPerLine, 3);
    assert.equal(link.maxLines, 7);
    assert.equal(link.strategy, 'permalink');
    assert.equal(link.allowPermalinkFallback, false);
    const row = rawLink(db, link.id);
    assert.equal(row.countries, '["PT"]');
    assert.equal(row.enabled, 0);
    assert.equal(row.allow_permalink_fallback, 0);
    assert.equal(repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', parityPolicy: 'off' }).parityPolicy, 'off');
  });

  it('gera um id diferente para cada rota', () => {
    const { repos, v1, c1 } = ctx();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      ids.add(repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false }).id);
    }
    assert.equal(ids.size, 20);
  });

  it('exige vitrine em vitrineStoreId e checkout em checkoutStoreId', () => {
    const { db, repos, v1, v2, c1, c2 } = ctx();
    const pairs: Array<[unknown, unknown]> = [
      [c1.id, c2.id],
      [v1.id, v2.id],
      [c1.id, v1.id],
      [v1.id, v1.id],
      [c1.id, c1.id],
      ['st_nao_existe', c1.id],
      [v1.id, 'st_nao_existe'],
      ['', c1.id],
      [v1.id, ''],
      [v1.shopDomain, c1.id],
      [v1.id, c1.shopDomain],
      [null, c1.id],
      [v1.id, null],
      [undefined, undefined],
      [1, 2],
      [{ id: v1.id }, c1.id],
      [v1.id, [c1.id]],
      [`${v1.id}' OR '1'='1`, c1.id],
      [v1.id, "' OR role = 'checkout' --"],
      [`${v1.id} `, c1.id],
      [v1.id.toUpperCase(), c1.id],
    ];
    for (const [vitrineStoreId, checkoutStoreId] of pairs) {
      const details = errorDetails(
        () => repos.links.create(unsafe<NewLink>({ vitrineStoreId, checkoutStoreId, kind: 'default' })),
        'invalid_request',
      );
      assert.ok(details.field === 'vitrineStoreId' || details.field === 'checkoutStoreId');
    }
    assert.equal(tableCount(db, 'links'), 0);
  });

  it("rota 'default' não aceita países", () => {
    const { db, repos, v1, c1 } = ctx();
    for (const countries of [['BR'], ['BR', 'US'], [''], [null], 'BR', {}, 0, true]) {
      expectBridgeError(
        () => repos.links.create(unsafe<NewLink>({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false, countries })),
        'invalid_request',
      );
    }
    assert.equal(tableCount(db, 'links'), 0);
    for (const countries of [undefined, null, []]) {
      const link = repos.links.create(unsafe<NewLink>({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false, countries }));
      assert.deepEqual(link.countries, []);
      assert.equal(rawLink(db, link.id).countries, '[]');
    }
  });

  it("rota 'country' exige pelo menos um código ISO alpha-2 válido", () => {
    const { db, repos, v1, c1 } = ctx();
    const bad: unknown[] = [
      undefined,
      null,
      [],
      'BR',
      { 0: 'BR', length: 1 },
      ['BRA'],
      ['B'],
      [''],
      ['  '],
      ['B1'],
      ['12'],
      ['B R'],
      ['ß'],
      ['ÉÉ'],
      ['BK'],
      ['BR', 'XYZ'],
      ['BR', null],
      ['BR', 55],
      [['BR']],
      [{ code: 'BR' }],
      ["BR'; DROP TABLE links; --"],
      ["' OR '1'='1"],
      ['BR,US'],
      ['B'.repeat(100_000)],
      Array.from({ length: 301 }, () => 'BR'),
    ];
    for (const countries of bad) {
      const details = errorDetails(
        () => repos.links.create(unsafe<NewLink>({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries })),
        'invalid_request',
      );
      assert.equal(details.field, 'countries');
    }
    assert.equal(tableCount(db, 'links'), 0);
  });

  it('países saem em maiúsculas, sem repetição e ordenados', () => {
    const { db, repos, v1, c1 } = ctx();
    const link = repos.links.create({
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'country',
      countries: ['us', ' br ', 'US', 'Ar', 'BR', 'pt', 'uS'],
    });
    assert.deepEqual(link.countries, ['AR', 'BR', 'PT', 'US']);
    assert.equal(rawLink(db, link.id).countries, '["AR","BR","PT","US"]');
    assert.deepEqual(repos.links.get(link.id)?.countries, ['AR', 'BR', 'PT', 'US']);
  });

  it('aceita lista grande de países repetidos dentro do limite', () => {
    const { repos, v1, c1 } = ctx();
    const link = repos.links.create({
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'country',
      countries: Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 'br' : 'AR')),
    });
    assert.deepEqual(link.countries, ['AR', 'BR']);
  });

  it('respeita os limites numéricos nas duas pontas', () => {
    const { repos, v1, c1 } = ctx();
    const base = { vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' as const, enabled: false };
    const low = repos.links.create({ ...base, priceToleranceBps: 0, maxQuantityPerLine: 1, maxLines: 1 });
    assert.deepEqual([low.priceToleranceBps, low.maxQuantityPerLine, low.maxLines], [0, 1, 1]);
    const high = repos.links.create({ ...base, priceToleranceBps: 10000, maxQuantityPerLine: 10000, maxLines: 250 });
    assert.deepEqual([high.priceToleranceBps, high.maxQuantityPerLine, high.maxLines], [10000, 10000, 250]);
  });

  it('recusa números fora do intervalo, não inteiros ou de outro tipo', () => {
    const { db, repos, v1, c1 } = ctx();
    const base = { vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false };
    const junk: unknown[] = [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', '', null, true, [5], {}, 5n, 1e21];
    const cases: Array<[string, unknown[]]> = [
      ['priceToleranceBps', [-1, 10001, ...junk]],
      ['maxQuantityPerLine', [0, -1, 10001, ...junk]],
      ['maxLines', [0, -1, 251, 10000, ...junk]],
    ];
    for (const [field, values] of cases) {
      for (const value of values) {
        const details = errorDetails(() => repos.links.create(unsafe<NewLink>({ ...base, [field]: value })), 'invalid_request');
        assert.equal(details.field, field);
      }
    }
    assert.equal(tableCount(db, 'links'), 0);
  });

  it('recusa kind, parityPolicy, strategy e booleanos inválidos', () => {
    const { db, repos, v1, c1 } = ctx();
    const base = { vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false };
    const bad: Array<Record<string, unknown>> = [
      { kind: 'fallback' },
      { kind: 'DEFAULT' },
      { kind: '' },
      { kind: null },
      { kind: undefined },
      { kind: 0 },
      { kind: ['default'] },
      { parityPolicy: 'ignore' },
      { parityPolicy: 'BLOCK' },
      { parityPolicy: null },
      { parityPolicy: false },
      { strategy: 'checkout_api' },
      { strategy: 'storefront' },
      { strategy: 'round_robin' },
      { strategy: 'failover' },
      { strategy: '' },
      { strategy: null },
      { strategy: 1 },
      { enabled: 1 },
      { enabled: 0 },
      { enabled: 'true' },
      { enabled: 'false' },
      { enabled: null },
      { allowPermalinkFallback: 1 },
      { allowPermalinkFallback: 'on' },
      { allowPermalinkFallback: null },
    ];
    for (const overrides of bad) {
      expectBridgeError(() => repos.links.create(unsafe<NewLink>({ ...base, ...overrides })), 'invalid_request');
    }
    assert.equal(tableCount(db, 'links'), 0);
  });

  it('recusa entrada que não é objeto com invalid_request, não com TypeError', () => {
    const { db, repos } = ctx();
    for (const value of [null, undefined, 'default', 3, true, [], [{}]]) {
      expectBridgeError(() => repos.links.create(unsafe<NewLink>(value)), 'invalid_request');
    }
    assert.equal(tableCount(db, 'links'), 0);
  });
});

describe('LinkRepo: unicidade de rota entre as rotas ativas de uma vitrine', () => {
  it('no máximo uma rota default ativa por vitrine', () => {
    const { db, repos, v1, v2, c1, c2 } = ctx();
    const first = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    // Mesmo destino ou outro destino: a segunda default ativa da mesma vitrine é conflito.
    for (const checkoutStoreId of [c1.id, c2.id]) {
      const details = errorDetails(() => repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId, kind: 'default' }), 'conflict');
      assert.equal(details.conflictingLinkId, first.id);
    }
    assert.equal(tableCount(db, 'links'), 1);
    // Outra vitrine tem a sua própria default, inclusive para o mesmo checkout.
    repos.links.create({ vitrineStoreId: v2.id, checkoutStoreId: c1.id, kind: 'default' });
    assert.equal(tableCount(db, 'links'), 2);
  });

  it('rotas default desativadas não participam da regra', () => {
    const { repos, v1, c1, c2 } = ctx();
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default', enabled: false });
    const active = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default', enabled: false });
    assert.deepEqual(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true }).map((l) => l.id), [active.id]);
    assert.equal(repos.links.list({ vitrineStoreId: v1.id }).length, 4);
  });

  it('default e country convivem na mesma vitrine', () => {
    const { repos, v1, c1, c2 } = ctx();
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR'] });
    assert.equal(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true }).length, 3);
  });

  it('um país aparece em no máximo uma rota country ativa da vitrine', () => {
    const { db, repos, v1, v2, c1, c2 } = ctx();
    const first = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR', 'AR'] });
    const clashes: string[][] = [['AR'], ['BR'], ['ar', 'CL'], ['CL', 'UY', ' br '], ['AR', 'BR']];
    for (const countries of clashes) {
      for (const checkoutStoreId of [c1.id, c2.id]) {
        const details = errorDetails(
          () => repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId, kind: 'country', countries }),
          'conflict',
        );
        assert.equal(details.conflictingLinkId, first.id);
        assert.ok(details.country === 'AR' || details.country === 'BR');
      }
    }
    assert.equal(tableCount(db, 'links'), 1);
    // Países disjuntos, rota desativada com os mesmos países e outra vitrine: tudo permitido.
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['CL', 'UY'] });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['AR', 'BR'], enabled: false });
    repos.links.create({ vitrineStoreId: v2.id, checkoutStoreId: c1.id, kind: 'country', countries: ['AR', 'BR'] });
    assert.equal(tableCount(db, 'links'), 4);
  });

  it('o conflito de país olha todas as rotas ativas, não só a primeira', () => {
    const { repos, v1, c1, c2 } = ctx();
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['AR'] });
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR'] });
    const third = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['CL', 'MX'] });
    const details = errorDetails(
      () => repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['PT', 'MX'] }),
      'conflict',
    );
    assert.equal(details.conflictingLinkId, third.id);
    assert.equal(details.country, 'MX');
  });

  it('update: reativar, trocar países ou trocar o tipo passam pela mesma regra', () => {
    const { clock, repos, v1, c1, c2 } = ctx();
    const def = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const br = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR'] });
    const us = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] });
    const off = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['BR', 'US'], enabled: false });
    clock.advance(1000);

    expectBridgeError(() => repos.links.update(off.id, { enabled: true }), 'conflict');
    expectBridgeError(() => repos.links.update(us.id, { countries: ['US', 'br'] }), 'conflict');
    expectBridgeError(() => repos.links.update(us.id, { kind: 'default' }), 'conflict');
    expectBridgeError(() => repos.links.update(us.id, { kind: 'default', countries: [] }), 'conflict');
    expectBridgeError(() => repos.links.update(def.id, { kind: 'country', countries: ['US'] }), 'conflict');
    expectBridgeError(() => repos.links.update(off.id, { enabled: true, countries: ['PT', 'US'] }), 'conflict');
    // Nenhuma tentativa recusada deixou rastro.
    assert.deepEqual(repos.links.get(def.id), def);
    assert.deepEqual(repos.links.get(br.id), br);
    assert.deepEqual(repos.links.get(us.id), us);
    assert.deepEqual(repos.links.get(off.id), off);

    // A rota não conflita consigo mesma, e mudanças sem sobreposição passam.
    assert.deepEqual(repos.links.update(br.id, { countries: ['BR'] }).countries, ['BR']);
    assert.deepEqual(repos.links.update(br.id, { countries: ['BR', 'PT'] }).countries, ['BR', 'PT']);
    assert.equal(repos.links.update(def.id, { enabled: true, parityPolicy: 'warn' }).parityPolicy, 'warn');
    assert.deepEqual(repos.links.update(off.id, { enabled: true, countries: ['MX'] }).countries, ['MX']);
    // Desativada, a rota pode guardar países que outra rota ativa já atende.
    assert.deepEqual(repos.links.update(off.id, { enabled: false, countries: ['BR', 'US'] }).countries, ['BR', 'US']);
    assert.deepEqual(repos.links.update(off.id, { countries: ['BR', 'PT', 'US'] }).countries, ['BR', 'PT', 'US']);
  });

  it('sequência default: cria A, desativa A, cria B, reativar A é conflito', () => {
    const { repos, v1, c1, c2 } = ctx();
    const a = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    assert.equal(repos.links.update(a.id, { enabled: false }).enabled, false);
    const b = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default' });

    const details = errorDetails(() => repos.links.update(a.id, { enabled: true }), 'conflict');
    assert.equal(details.conflictingLinkId, b.id);
    assert.equal(repos.links.get(a.id)?.enabled, false);
    assert.equal(repos.links.get(b.id)?.enabled, true);
    assert.deepEqual(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true }).map((l) => l.id), [b.id]);

    // Troca explícita feita pelo lojista: desativa B, reativa A; aí B é que não volta.
    repos.links.update(b.id, { enabled: false });
    assert.equal(repos.links.update(a.id, { enabled: true }).enabled, true);
    expectBridgeError(() => repos.links.update(b.id, { enabled: true }), 'conflict');
    assert.deepEqual(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true }).map((l) => l.id), [a.id]);

    // Apagar A libera a vaga.
    repos.links.delete(a.id);
    assert.equal(repos.links.update(b.id, { enabled: true }).enabled, true);
  });

  it('sequência country: cria A, desativa A, cria B com o mesmo país, reativar A é conflito', () => {
    const { repos, v1, c1, c2 } = ctx();
    const a = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR', 'PT'] });
    repos.links.update(a.id, { enabled: false });
    const b = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['PT', 'ES'] });

    const details = errorDetails(() => repos.links.update(a.id, { enabled: true }), 'conflict');
    assert.equal(details.conflictingLinkId, b.id);
    assert.equal(details.country, 'PT');
    assert.equal(repos.links.get(a.id)?.enabled, false);

    // Reativar tirando o país disputado funciona; devolver o país depois, não.
    assert.deepEqual(repos.links.update(a.id, { enabled: true, countries: ['BR'] }).countries, ['BR']);
    expectBridgeError(() => repos.links.update(a.id, { countries: ['BR', 'PT'] }), 'conflict');
    expectBridgeError(() => repos.links.update(b.id, { countries: ['BR'] }), 'conflict');
    repos.links.update(b.id, { countries: ['ES'] });
    assert.deepEqual(repos.links.update(a.id, { countries: ['BR', 'PT'] }).countries, ['BR', 'PT']);
  });

  it('em nenhum momento a vitrine fica com duas rotas ativas para o mesmo destino lógico', () => {
    const { db, repos, v1, c1, c2 } = ctx();
    const ids: string[] = [];
    const attempt = (fn: () => Link): void => {
      try {
        ids.push(fn().id);
      } catch (err) {
        assert.ok(isBridgeError(err) && err.code === 'conflict');
      }
    };
    // Mistura determinística de criações e reativações disputando default, BR e US.
    for (let i = 0; i < 40; i += 1) {
      const checkoutStoreId = i % 2 === 0 ? c1.id : c2.id;
      const enabled = i % 3 !== 0;
      if (i % 4 === 0) attempt(() => repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId, kind: 'default', enabled }));
      else attempt(() => repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId, kind: 'country', countries: i % 4 === 1 ? ['BR'] : ['US', 'BR'], enabled }));
      const target = ids[(i * 7) % Math.max(1, ids.length)];
      if (target !== undefined) attempt(() => repos.links.update(target, { enabled: i % 5 !== 0 }));

      const active = repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true });
      assert.ok(active.filter((l) => l.kind === 'default').length <= 1);
      const seen = active.filter((l) => l.kind === 'country').flatMap((l) => l.countries);
      assert.equal(new Set(seen).size, seen.length, `país repetido entre rotas ativas: ${seen.join(',')}`);
    }
    assert.ok(tableCount(db, 'links') > 5);
  });
});

/** Db com respostas trocadas em consultas escolhidas: simula outro processo no meio do caminho. */
function intercept(db: Db, overrides: { get?: (sql: string) => unknown; all?: (sql: string) => unknown[] | undefined }): Db {
  return {
    ...db,
    get<T>(sql: string, params?: SqlParams): T | undefined {
      const forced = overrides.get?.(sql);
      return forced !== undefined ? (forced as T) : db.get<T>(sql, params);
    },
    all<T>(sql: string, params?: SqlParams): T[] {
      const forced = overrides.all?.(sql);
      return forced !== undefined ? (forced as T[]) : db.all<T>(sql, params);
    },
  };
}

describe('LinkRepo: segunda barreira no esquema', () => {
  it('o índice único parcial impede duas default ativas mesmo por SQL direto', () => {
    const { db, repos, v1, c1, c2 } = ctx();
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const insert = (id: string, enabled: number): void => {
      db.run(
        `INSERT INTO links (id, vitrine_store_id, checkout_store_id, kind, enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'default', ?, ?, ?)`,
        [id, v1.id, c2.id, enabled, T0, T0],
      );
    };
    assert.throws(() => insert('ln_direto_1', 1), /UNIQUE|constraint/i);
    insert('ln_direto_2', 0);
    assert.throws(() => db.run('UPDATE links SET enabled = 1 WHERE id = ?', ['ln_direto_2']), /UNIQUE|constraint/i);
    assert.equal(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true }).length, 1);
  });

  it('violação do índice vira conflict no create e no update (corrida entre processos)', () => {
    const { db, clock, repos, v1, c1, c2 } = ctx();
    repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const off = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default', enabled: false });
    // A checagem do repositório "não vê" a rota concorrente; sobra o índice do esquema.
    const racing = createLinkRepo(intercept(db, { all: (sql) => (/FROM links WHERE vitrine_store_id = \? AND kind = \?/.test(sql) ? [] : undefined) }), { clock });
    expectBridgeError(() => racing.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default' }), 'conflict');
    expectBridgeError(() => racing.update(off.id, { enabled: true }), 'conflict');
    assert.equal(tableCount(db, 'links'), 2);
    assert.equal(repos.links.get(off.id)?.enabled, false);
  });

  it('loja removida entre a checagem e a gravação vira invalid_request (chave estrangeira)', () => {
    const { db, clock, repos, v1 } = ctx();
    const racing = createLinkRepo(
      intercept(db, { get: (sql) => (/SELECT role FROM stores/.test(sql) ? { role: 'checkout' } : undefined) }),
      { clock },
    );
    // Com a checagem de papel "enganada", st_fantasma passa como checkout e o INSERT esbarra na FK.
    expectBridgeError(() => racing.create({ vitrineStoreId: v1.id, checkoutStoreId: 'st_fantasma', kind: 'default' }), 'invalid_request');
    assert.equal(tableCount(db, 'links'), 0);
    assert.deepEqual(repos.links.list(), []);
  });

  it('as restrições CHECK do esquema recusam valores fora do contrato por SQL direto', () => {
    const { db, repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const updates = [
      "kind = 'fallback'",
      'enabled = 2',
      "parity_policy = 'x'",
      'price_tolerance_bps = 10001',
      'price_tolerance_bps = -1',
      'max_quantity_per_line = 0',
      'max_lines = 251',
      "strategy = 'round_robin'",
      'allow_permalink_fallback = 5',
    ];
    for (const set of updates) {
      // Fragmentos fixos do próprio teste; nada aqui vem de dado externo.
      assert.throws(() => db.run(`UPDATE links SET ${set} WHERE id = ?`, [link.id]), /CHECK|constraint/i);
    }
    assert.deepEqual(repos.links.get(link.id), link);
  });
});

describe('LinkRepo.update', () => {
  it('altera cada campo do patch e avança updatedAt', () => {
    const { clock, repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    clock.advance(3000);
    const updated = repos.links.update(link.id, {
      kind: 'country',
      countries: ['us', 'br'],
      enabled: false,
      parityPolicy: 'off',
      priceToleranceBps: 10000,
      maxQuantityPerLine: 10000,
      maxLines: 250,
      strategy: 'permalink',
      allowPermalinkFallback: false,
    });
    assert.deepEqual(updated, {
      id: link.id,
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'country',
      countries: ['BR', 'US'],
      enabled: false,
      parityPolicy: 'off',
      priceToleranceBps: 10000,
      maxQuantityPerLine: 10000,
      maxLines: 250,
      strategy: 'permalink',
      allowPermalinkFallback: false,
      createdAt: T0,
      updatedAt: at(3000),
    });
    assert.deepEqual(repos.links.get(link.id), updated);
  });

  it('patch parcial preserva os demais campos', () => {
    const { repos, v1, c1 } = ctx();
    const link = repos.links.create({
      vitrineStoreId: v1.id,
      checkoutStoreId: c1.id,
      kind: 'country',
      countries: ['BR'],
      parityPolicy: 'warn',
      priceToleranceBps: 50,
      maxQuantityPerLine: 9,
      maxLines: 20,
      strategy: 'permalink',
      allowPermalinkFallback: false,
    });
    const updated = repos.links.update(link.id, { maxLines: 21 });
    assert.deepEqual({ ...updated, updatedAt: '' }, { ...link, maxLines: 21, updatedAt: '' });
    assert.deepEqual({ ...repos.links.update(link.id, {}), updatedAt: '' }, { ...updated, updatedAt: '' });
    assert.deepEqual({ ...repos.links.update(link.id, { kind: undefined, enabled: undefined }), updatedAt: '' }, { ...updated, updatedAt: '' });
  });

  it('troca de tipo: default exige lista vazia, country exige países', () => {
    const { repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    expectBridgeError(() => repos.links.update(link.id, { kind: 'country' }), 'invalid_request');
    expectBridgeError(() => repos.links.update(link.id, { kind: 'country', countries: [] }), 'invalid_request');
    expectBridgeError(() => repos.links.update(link.id, { countries: ['BR'] }), 'invalid_request');
    assert.deepEqual(repos.links.get(link.id), link);

    const country = repos.links.update(link.id, { kind: 'country', countries: ['br'] });
    assert.deepEqual([country.kind, country.countries], ['country', ['BR']]);
    expectBridgeError(() => repos.links.update(link.id, { countries: [] }), 'invalid_request');
    expectBridgeError(() => repos.links.update(link.id, { countries: unsafe<string[]>(null) }), 'invalid_request');
    expectBridgeError(() => repos.links.update(link.id, { kind: 'default', countries: ['BR'] }), 'invalid_request');
    assert.deepEqual(repos.links.get(link.id)?.countries, ['BR']);

    // Voltar para default sem informar países limpa a lista.
    const back = repos.links.update(link.id, { kind: 'default' });
    assert.deepEqual([back.kind, back.countries], ['default', []]);
  });

  it('recusa valores inválidos e não grava nada do patch (tudo ou nada)', () => {
    const { clock, repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'country', countries: ['BR'] });
    clock.advance(1000);
    const bad: Array<Record<string, unknown>> = [
      { kind: 'fallback' },
      { kind: null },
      { countries: ['BRA'] },
      { countries: 'BR' },
      { countries: ["BR'; --"] },
      { enabled: 'false' },
      { enabled: 0 },
      { enabled: null },
      { parityPolicy: 'never' },
      { parityPolicy: null },
      { priceToleranceBps: -1 },
      { priceToleranceBps: 10001 },
      { priceToleranceBps: 0.5 },
      { priceToleranceBps: '10' },
      { priceToleranceBps: null },
      { maxQuantityPerLine: 0 },
      { maxQuantityPerLine: 10001 },
      { maxQuantityPerLine: Number.NaN },
      { maxLines: 0 },
      { maxLines: 251 },
      { maxLines: Number.POSITIVE_INFINITY },
      { strategy: 'least_loaded' },
      { strategy: null },
      { allowPermalinkFallback: 'yes' },
      { allowPermalinkFallback: null },
    ];
    for (const patch of bad) {
      // O campo válido vem junto de propósito: se o inválido falha, o válido não pode ficar.
      expectBridgeError(() => repos.links.update(link.id, unsafe<LinkPatch>({ maxLines: 33, parityPolicy: 'off', ...patch })), 'invalid_request');
      assert.deepEqual(repos.links.get(link.id), link);
    }
    for (const patch of [null, 'enabled', 1, [], [{ enabled: false }]]) {
      expectBridgeError(() => repos.links.update(link.id, unsafe<LinkPatch>(patch)), 'invalid_request');
    }
    assert.deepEqual(repos.links.get(link.id), link);
  });

  it('as lojas da rota não mudam por update, nem com chaves extras no patch', () => {
    const { db, repos, v1, v2, c1, c2 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const hostilePatch = {
      vitrineStoreId: v2.id,
      checkoutStoreId: c2.id,
      vitrine_store_id: v2.id,
      checkout_store_id: c2.id,
      id: 'ln_outro',
      createdAt: '1999-01-01T00:00:00.000Z',
      "enabled = 0, checkout_store_id": c2.id,
      maxLines: 5,
    };
    const updated = repos.links.update(link.id, unsafe<LinkPatch>(hostilePatch));
    assert.equal(updated.id, link.id);
    assert.equal(updated.vitrineStoreId, v1.id);
    assert.equal(updated.checkoutStoreId, c1.id);
    assert.equal(updated.createdAt, T0);
    assert.equal(updated.enabled, true);
    assert.equal(updated.maxLines, 5);
    const row = rawLink(db, link.id);
    assert.equal(row.vitrine_store_id, v1.id);
    assert.equal(row.checkout_store_id, c1.id);
    assert.equal(repos.links.get('ln_outro'), null);
  });

  it('id desconhecido ou de outro tipo dá not_found', () => {
    const { repos, v1, c1 } = ctx();
    const link = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const ids: unknown[] = ['ln_nao_existe', '', '%', `${link.id}' OR '1'='1`, "' OR 1=1 --", null, undefined, 0, {}, [link.id]];
    for (const id of ids) {
      expectBridgeError(() => repos.links.update(unsafe<string>(id), { enabled: false }), 'not_found');
      expectBridgeError(() => repos.links.update(unsafe<string>(id), unsafe<LinkPatch>(null)), 'not_found');
    }
    assert.deepEqual(repos.links.get(link.id), link);
  });
});

describe('LinkRepo: leitura e remoção', () => {
  /** Cinco rotas criadas em instantes distintos, para a ordem de list() ser previsível. */
  function seed(f: Fixture): { a: Link; b: Link; c: Link; d: Link; e: Link } {
    const { clock, repos, v1, v2, c1, c2 } = f;
    const make = (input: NewLink): Link => {
      clock.advance(1000);
      return repos.links.create(input);
    };
    return {
      a: make({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' }),
      b: make({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] }),
      c: make({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'default', enabled: false }),
      d: make({ vitrineStoreId: v2.id, checkoutStoreId: c1.id, kind: 'default', enabled: false }),
      e: make({ vitrineStoreId: v2.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] }),
    };
  }

  const ids = (links: Link[]): string[] => links.map((l) => l.id);

  it('list ordena por criação e aplica os filtros, sozinhos e combinados', () => {
    const f = ctx();
    const { repos, v1, v2, c1, c2 } = f;
    const { a, b, c, d, e } = seed(f);
    assert.deepEqual(ids(repos.links.list()), [a.id, b.id, c.id, d.id, e.id]);
    assert.deepEqual(ids(repos.links.list({})), [a.id, b.id, c.id, d.id, e.id]);
    assert.deepEqual(ids(repos.links.list({ enabledOnly: false })), [a.id, b.id, c.id, d.id, e.id]);
    assert.deepEqual(ids(repos.links.list({ enabledOnly: true })), [a.id, b.id, e.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id })), [a.id, b.id, c.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v2.id })), [d.id, e.id]);
    assert.deepEqual(ids(repos.links.list({ checkoutStoreId: c1.id })), [a.id, d.id]);
    assert.deepEqual(ids(repos.links.list({ checkoutStoreId: c2.id })), [b.id, c.id, e.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true })), [a.id, b.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v2.id, enabledOnly: true })), [e.id]);
    assert.deepEqual(ids(repos.links.list({ checkoutStoreId: c1.id, enabledOnly: true })), [a.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id, checkoutStoreId: c2.id })), [b.id, c.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, enabledOnly: true })), [b.id]);
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v2.id, checkoutStoreId: c1.id, enabledOnly: true })), []);
    // Papéis trocados no filtro não casam com nada.
    assert.deepEqual(repos.links.list({ vitrineStoreId: c1.id }), []);
    assert.deepEqual(repos.links.list({ checkoutStoreId: v1.id }), []);
    assert.deepEqual(repos.links.list({ vitrineStoreId: 'st_nao_existe' }), []);
  });

  it('list reflete desativação e reativação', () => {
    const f = ctx();
    const { repos, v1 } = f;
    const { a, b } = seed(f);
    repos.links.update(a.id, { enabled: false });
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true })), [b.id]);
    repos.links.update(a.id, { enabled: true });
    assert.deepEqual(ids(repos.links.list({ vitrineStoreId: v1.id, enabledOnly: true })), [a.id, b.id]);
  });

  it('list com filtro hostil ou de outro tipo não devolve rota alheia nem desativada', () => {
    const f = ctx();
    const { db, repos, v1 } = f;
    const { a, b, e } = seed(f);
    const hostile: unknown[] = [...INJECTIONS, `${v1.id}' OR '1'='1`, `${v1.id}%`, '', 0, 1, true, {}, [v1.id], { id: v1.id }];
    for (const value of hostile) {
      assert.deepEqual(repos.links.list({ vitrineStoreId: unsafe<string>(value) }), []);
      assert.deepEqual(repos.links.list({ checkoutStoreId: unsafe<string>(value) }), []);
      assert.deepEqual(repos.links.list({ vitrineStoreId: v1.id, checkoutStoreId: unsafe<string>(value) }), []);
    }
    // enabledOnly "verdadeiro" de outro tipo nunca devolve rota desativada.
    for (const truthy of ['true', 1, 'false', {}, []]) {
      const listed = repos.links.list({ enabledOnly: unsafe<boolean>(truthy) });
      assert.deepEqual(ids(listed), [a.id, b.id, e.id]);
      assert.ok(listed.every((l) => l.enabled));
    }
    assert.equal(repos.links.list(unsafe<{ enabledOnly?: boolean }>(null)).length, 5);
    assert.equal(repos.links.list({ vitrineStoreId: unsafe<string>(null), checkoutStoreId: unsafe<string>(undefined) }).length, 5);
    assert.equal(tableCount(db, 'links'), 5);
  });

  it('get devolve null para id desconhecido ou de outro tipo', () => {
    const f = ctx();
    const { a } = seed(f);
    assert.deepEqual(f.repos.links.get(a.id), a);
    for (const id of ['ln_nao_existe', '', '%', 'ln_%', `${a.id}' OR '1'='1`, a.id.toUpperCase(), ` ${a.id}`, null, undefined, 0, {}, [a.id]]) {
      assert.equal(f.repos.links.get(unsafe<string>(id)), null);
    }
  });

  it('delete remove só a rota pedida; desconhecida dá not_found', () => {
    const f = ctx();
    const { db, repos } = f;
    const { a, b, c, d, e } = seed(f);
    repos.links.delete(b.id);
    assert.equal(repos.links.get(b.id), null);
    assert.deepEqual(ids(repos.links.list()), [a.id, c.id, d.id, e.id]);
    expectBridgeError(() => repos.links.delete(b.id), 'not_found');
    const hostile: unknown[] = ['ln_nao_existe', '', '%', 'ln_%', ...INJECTIONS, `${a.id}' OR '1'='1`, null, undefined, 0, {}, [a.id]];
    for (const id of hostile) expectBridgeError(() => repos.links.delete(unsafe<string>(id)), 'not_found');
    assert.equal(tableCount(db, 'links'), 4);
    assert.equal(tableCount(db, 'stores'), 4);
  });

  it('apagar a rota não apaga as lojas; apagar uma loja leva as rotas dela', () => {
    const f = ctx();
    const { db, repos, v1, c2 } = f;
    const { a, d, e } = seed(f);
    repos.links.delete(a.id);
    assert.equal(tableCount(db, 'stores'), 4);
    repos.stores.delete(v1.id);
    assert.deepEqual(ids(repos.links.list()), [d.id, e.id]);
    repos.stores.delete(c2.id);
    assert.deepEqual(ids(repos.links.list()), [d.id]);
  });

  it('leitura defensiva: países corrompidos no banco viram lista vazia, sem lançar', () => {
    const f = ctx();
    const { db, repos } = f;
    const { b } = seed(f);
    for (const corrupt of ['', 'não é json', '{"BR":true}', '"BR"', '[1,null,"br","BRA"]', '42']) {
      db.run('UPDATE links SET countries = ? WHERE id = ?', [corrupt, b.id]);
      assert.deepEqual(repos.links.get(b.id)?.countries, []);
    }
    db.run('UPDATE links SET countries = ? WHERE id = ?', ['["US",7,"xx","PT"]', b.id]);
    assert.deepEqual(repos.links.get(b.id)?.countries, ['US', 'PT']);
  });
});

describe('LinkRepo: injeção de SQL e entradas enormes', () => {
  it('SQL em qualquer campo de texto é recusado como valor inválido, sem efeito colateral', () => {
    const { db, repos, v1, c1 } = ctx();
    const kept = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const base = { vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false };
    for (const payload of INJECTIONS) {
      for (const field of ['vitrineStoreId', 'checkoutStoreId', 'kind', 'parityPolicy', 'strategy', 'enabled', 'priceToleranceBps', 'maxLines']) {
        expectBridgeError(() => repos.links.create(unsafe<NewLink>({ ...base, [field]: payload })), 'invalid_request');
      }
      expectBridgeError(() => repos.links.create(unsafe<NewLink>({ ...base, kind: 'country', countries: [payload] })), 'invalid_request');
      for (const field of ['kind', 'parityPolicy', 'strategy', 'enabled', 'allowPermalinkFallback', 'maxQuantityPerLine']) {
        expectBridgeError(() => repos.links.update(kept.id, unsafe<LinkPatch>({ [field]: payload })), 'invalid_request');
      }
      expectBridgeError(() => repos.links.update(payload, { enabled: false }), 'not_found');
      expectBridgeError(() => repos.links.delete(payload), 'not_found');
      assert.equal(repos.links.get(payload), null);
    }
    assert.equal(tableCount(db, 'links'), 1);
    assert.equal(tableCount(db, 'stores'), 4);
    assert.deepEqual(repos.links.get(kept.id), kept);
    assert.equal(repos.stores.get(v1.id)?.role, 'vitrine');
  });

  it('entradas enormes são recusadas sem derrubar nada', () => {
    const { db, repos, v1, c1 } = ctx();
    const kept = repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
    const huge = 'x'.repeat(2_000_000);
    const base = { vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default', enabled: false };
    for (const field of ['vitrineStoreId', 'checkoutStoreId', 'kind', 'parityPolicy', 'strategy']) {
      expectBridgeError(() => repos.links.create(unsafe<NewLink>({ ...base, [field]: huge })), 'invalid_request');
    }
    const manyCountries = Array.from({ length: 50_000 }, () => 'BR');
    expectBridgeError(() => repos.links.create({ ...base, kind: 'country', countries: manyCountries }), 'invalid_request');
    expectBridgeError(() => repos.links.create({ ...base, kind: 'country', countries: [huge] }), 'invalid_request');
    expectBridgeError(() => repos.links.update(kept.id, { kind: 'country', countries: manyCountries }), 'invalid_request');
    expectBridgeError(() => repos.links.update(kept.id, { priceToleranceBps: Number.MAX_SAFE_INTEGER }), 'invalid_request');
    expectBridgeError(() => repos.links.update(huge, {}), 'not_found');
    expectBridgeError(() => repos.links.delete(huge), 'not_found');
    assert.equal(repos.links.get(huge), null);
    assert.deepEqual(repos.links.list({ vitrineStoreId: huge }), []);
    assert.equal(tableCount(db, 'links'), 1);
    assert.deepEqual(repos.links.get(kept.id), kept);
  });
});
