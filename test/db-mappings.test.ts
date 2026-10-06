import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Divergence, MappingListOptions, MappingStatus, VariantMapping } from '../src/types.ts';
import { at, expectBridgeError, makeMapping, makeStore, makeVariant, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/**
 * Testes do MappingRepo sobre SQLite em memória, com o repositório real.
 * Cada contexto tem duas vitrines e dois checkouts, para provar o isolamento por par.
 */

const open: TestContext[] = [];

interface Ctx extends TestContext {
  v1: string;
  v2: string;
  c1: string;
  c2: string;
}

function ctx(): Ctx {
  const c = setup();
  open.push(c);
  return {
    ...c,
    v1: makeStore(c.repos, 'vitrine').id,
    v2: makeStore(c.repos, 'vitrine').id,
    c1: makeStore(c.repos, 'checkout').id,
    c2: makeStore(c.repos, 'checkout').id,
  };
}

afterEach(() => {
  for (const c of open.splice(0)) c.db.close();
});

const PRICE: Divergence = { kind: 'price', vitrine: '39.90', checkout: '44.90' };
const TITLE: Divergence = { kind: 'title', vitrine: 'Camiseta', checkout: 'T-Shirt' };

function range(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(start + i));
}

function vids(rows: VariantMapping[]): string[] {
  return rows.map((row) => row.vitrineVariantId);
}

describe('MappingRepo.upsertAuto', () => {
  it('insere e devolve todos os campos', () => {
    const { repos, v1, c1 } = ctx();
    const conflict = makeMapping(v1, c1, '1', {
      checkoutVariantId: null,
      status: 'conflict',
      method: null,
      candidates: ['901', '902'],
      divergences: [],
      updatedAt: at(10),
    });
    const active = makeMapping(v1, c1, '2', {
      checkoutVariantId: '777',
      status: 'active',
      method: 'handle_options',
      divergences: [PRICE, TITLE],
      updatedAt: at(20),
    });
    repos.mappings.upsertAuto([conflict, active]);

    assert.deepEqual(repos.mappings.get(v1, c1, '1'), conflict);
    assert.deepEqual(repos.mappings.get(v1, c1, '2'), active);
    assert.equal(repos.mappings.get(v1, c1, '3'), null);
  });

  it('linha existente sem trava é substituída por inteiro', () => {
    const { repos, db, v1, c1 } = ctx();
    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', {
        checkoutVariantId: null,
        status: 'conflict',
        method: null,
        candidates: ['901', '902'],
        divergences: [PRICE],
      }),
    ]);
    const next = makeMapping(v1, c1, '1', {
      checkoutVariantId: '901',
      status: 'suggested',
      method: 'title_options',
      candidates: [],
      divergences: [],
      updatedAt: at(60_000),
    });
    repos.mappings.upsertAuto([next]);

    assert.deepEqual(repos.mappings.get(v1, c1, '1'), next);
    assert.equal(tableCount(db, 'variant_mappings'), 1);
  });

  it('linha travada mantém destino, status, método, candidatos e trava; só divergências e data mudam', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.setManual(
      makeMapping(v1, c1, '1', {
        checkoutVariantId: '555',
        status: 'disabled',
        method: 'manual',
        candidates: ['555', '556'],
        divergences: [TITLE],
        updatedAt: at(0),
      }),
    );

    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', {
        checkoutVariantId: '999',
        status: 'active',
        method: 'sku',
        candidates: ['1', '2', '3'],
        divergences: [PRICE],
        locked: false,
        updatedAt: at(5000),
      }),
    ]);

    assert.deepEqual(repos.mappings.get(v1, c1, '1'), {
      vitrineStoreId: v1,
      checkoutStoreId: c1,
      vitrineVariantId: '1',
      checkoutVariantId: '555',
      status: 'disabled',
      method: 'manual',
      candidates: ['555', '556'],
      divergences: [PRICE],
      locked: true,
      updatedAt: at(5000),
    });
  });

  it('a trava resiste a várias rodadas e a um resultado "sem candidato"', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.setManual(makeMapping(v1, c1, '1', { checkoutVariantId: '555', method: 'manual', divergences: [PRICE] }));

    for (let round = 1; round <= 3; round += 1) {
      repos.mappings.upsertAuto([
        makeMapping(v1, c1, '1', {
          checkoutVariantId: null,
          status: 'unmapped',
          method: null,
          divergences: [],
          updatedAt: at(round * 1000),
        }),
      ]);
    }

    const row = repos.mappings.get(v1, c1, '1');
    assert.equal(row?.checkoutVariantId, '555');
    assert.equal(row?.status, 'active');
    assert.equal(row?.method, 'manual');
    assert.equal(row?.locked, true);
    // As divergências acompanham o último cálculo, inclusive quando ficam vazias.
    assert.deepEqual(row?.divergences, []);
    assert.equal(row?.updatedAt, at(3000));
  });

  it('no mesmo lote, trata cada linha conforme a própria trava', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.setManual(makeMapping(v1, c1, '1', { checkoutVariantId: '111', method: 'manual' }));
    repos.mappings.upsertAuto([makeMapping(v1, c1, '2', { checkoutVariantId: '222' })]);

    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', { checkoutVariantId: '8881', divergences: [PRICE] }),
      makeMapping(v1, c1, '2', { checkoutVariantId: '8882', divergences: [PRICE] }),
      makeMapping(v1, c1, '3', { checkoutVariantId: '8883', divergences: [PRICE] }),
    ]);

    assert.equal(repos.mappings.get(v1, c1, '1')?.checkoutVariantId, '111');
    assert.equal(repos.mappings.get(v1, c1, '2')?.checkoutVariantId, '8882');
    assert.equal(repos.mappings.get(v1, c1, '3')?.checkoutVariantId, '8883');
    assert.deepEqual(
      repos.mappings.listAll(v1, c1).map((row) => row.locked),
      [true, false, false],
    );
    for (const row of repos.mappings.listAll(v1, c1)) assert.deepEqual(row.divergences, [PRICE]);
  });

  it('a trava vale por par: a mesma variante em outro par segue livre', () => {
    const { repos, v1, c1, c2 } = ctx();
    repos.mappings.setManual(makeMapping(v1, c1, '1', { checkoutVariantId: '111' }));
    repos.mappings.upsertAuto([makeMapping(v1, c2, '1', { checkoutVariantId: '222' })]);

    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', { checkoutVariantId: '333' }),
      makeMapping(v1, c2, '1', { checkoutVariantId: '333' }),
    ]);

    assert.equal(repos.mappings.get(v1, c1, '1')?.checkoutVariantId, '111');
    assert.equal(repos.mappings.get(v1, c2, '1')?.checkoutVariantId, '333');
  });

  it('é transacional: entrada inválida no meio desfaz o lote inteiro', () => {
    const { repos, db, v1, c1 } = ctx();
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1', { checkoutVariantId: '111' })]);

    expectBridgeError(
      () =>
        repos.mappings.upsertAuto([
          makeMapping(v1, c1, '1', { checkoutVariantId: '999' }),
          makeMapping(v1, c1, '2'),
          makeMapping(v1, c1, '3', { status: 'aprovado' as MappingStatus }),
          makeMapping(v1, c1, '4'),
        ]),
      'invalid_request',
    );
    expectBridgeError(
      () => repos.mappings.upsertAuto([makeMapping(v1, c1, '5'), makeMapping('st_fantasma', c1, '6')]),
      'store_not_found',
    );
    expectBridgeError(() => repos.mappings.upsertAuto([makeMapping(v1, 'st_fantasma', '7')]), 'store_not_found');

    assert.equal(tableCount(db, 'variant_mappings'), 1);
    assert.equal(repos.mappings.get(v1, c1, '1')?.checkoutVariantId, '111');
  });

  it('lista vazia não faz nada; candidatos repetidos ou não textuais são limpos', () => {
    const { repos, db, v1, c1 } = ctx();
    repos.mappings.upsertAuto([]);
    assert.equal(tableCount(db, 'variant_mappings'), 0);

    const candidates = ['901', '902', '901', 7, null] as unknown as string[];
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1', { status: 'conflict', checkoutVariantId: null, method: null, candidates })]);
    assert.deepEqual(repos.mappings.get(v1, c1, '1')?.candidates, ['901', '902']);
  });

  it('updatedAt: normaliza o formato e usa o relógio quando a data é ilegível ou fora da faixa', () => {
    const { repos, clock, v1, c1 } = ctx();
    clock.set(at(42_000));
    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', { updatedAt: '2026-01-01T00:00:00Z' }),
      makeMapping(v1, c1, '2', { updatedAt: 'ontem' }),
      makeMapping(v1, c1, '3', { updatedAt: '' }),
      makeMapping(v1, c1, '4', { updatedAt: '+275000-01-01T00:00:00.000Z' }),
    ]);
    assert.equal(repos.mappings.get(v1, c1, '1')?.updatedAt, T0);
    for (const id of ['2', '3', '4']) assert.equal(repos.mappings.get(v1, c1, id)?.updatedAt, at(42_000), id);
  });
});

describe('MappingRepo.setManual / unlock', () => {
  it('setManual sempre grava locked = true, mesmo recebendo locked = false', () => {
    const { repos, v1, c1 } = ctx();
    const manual = makeMapping(v1, c1, '1', {
      checkoutVariantId: '555',
      status: 'active',
      method: 'manual',
      divergences: [PRICE],
      locked: false,
      updatedAt: at(100),
    });
    repos.mappings.setManual(manual);
    assert.deepEqual(repos.mappings.get(v1, c1, '1'), { ...manual, locked: true });
  });

  it('setManual substitui por inteiro uma linha automática e também uma linha já travada', () => {
    const { repos, db, v1, c1 } = ctx();
    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', { status: 'conflict', checkoutVariantId: null, method: null, candidates: ['901', '902'] }),
    ]);

    const first = makeMapping(v1, c1, '1', { checkoutVariantId: '902', method: 'manual', updatedAt: at(1) });
    repos.mappings.setManual(first);
    assert.deepEqual(repos.mappings.get(v1, c1, '1'), { ...first, locked: true });

    const second = makeMapping(v1, c1, '1', {
      checkoutVariantId: null,
      status: 'disabled',
      method: 'manual',
      divergences: [TITLE],
      updatedAt: at(2),
    });
    repos.mappings.setManual(second);
    assert.deepEqual(repos.mappings.get(v1, c1, '1'), { ...second, locked: true });
    assert.equal(tableCount(db, 'variant_mappings'), 1);
  });

  it('setManual valida a entrada e não grava nada quando ela é inválida', () => {
    const { repos, db, v1, c1 } = ctx();
    const bad: Array<Partial<VariantMapping>> = [
      { status: `active' OR '1'='1` as MappingStatus },
      { status: '' as MappingStatus },
      { method: 'chute' as VariantMapping['method'] },
      { vitrineVariantId: '' },
      { checkoutVariantId: '' },
      { vitrineStoreId: '' },
    ];
    for (const overrides of bad) {
      expectBridgeError(() => repos.mappings.setManual(makeMapping(v1, c1, '1', overrides)), 'invalid_request');
    }
    expectBridgeError(() => repos.mappings.setManual(makeMapping('st_fantasma', c1, '1')), 'store_not_found');
    assert.equal(tableCount(db, 'variant_mappings'), 0);
  });

  it('unlock tira a trava e não mexe em mais nada', () => {
    const { repos, clock, v1, c1 } = ctx();
    const manual = makeMapping(v1, c1, '1', {
      checkoutVariantId: '555',
      status: 'disabled',
      method: 'manual',
      candidates: ['555', '556'],
      divergences: [PRICE],
      updatedAt: at(100),
    });
    repos.mappings.setManual(manual);
    repos.mappings.setManual(makeMapping(v1, c1, '2', { checkoutVariantId: '666' }));
    clock.advance(3_600_000);

    repos.mappings.unlock(v1, c1, '1');

    assert.deepEqual(repos.mappings.get(v1, c1, '1'), { ...manual, locked: false });
    // A outra linha do par continua travada.
    assert.equal(repos.mappings.get(v1, c1, '2')?.locked, true);
  });

  it('unlock em linha destravada, inexistente ou de outro par não altera nada', () => {
    const { repos, v1, v2, c1, c2 } = ctx();
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1')]);
    repos.mappings.setManual(makeMapping(v1, c2, '1'));
    repos.mappings.setManual(makeMapping(v2, c1, '1'));
    const before = [repos.mappings.listAll(v1, c1), repos.mappings.listAll(v1, c2), repos.mappings.listAll(v2, c1)];

    repos.mappings.unlock(v1, c1, '1');
    repos.mappings.unlock(v1, c1, '404');
    repos.mappings.unlock(v2, c2, '1');
    repos.mappings.unlock(v1, c1, `1' OR '1'='1`);

    assert.deepEqual(
      [repos.mappings.listAll(v1, c1), repos.mappings.listAll(v1, c2), repos.mappings.listAll(v2, c1)],
      before,
    );
  });

  it('depois do unlock, o casamento automático volta a decidir pela linha', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.setManual(makeMapping(v1, c1, '1', { checkoutVariantId: '555', method: 'manual' }));
    repos.mappings.unlock(v1, c1, '1');

    const auto = makeMapping(v1, c1, '1', { checkoutVariantId: '999', method: 'barcode', updatedAt: at(9) });
    repos.mappings.upsertAuto([auto]);
    assert.deepEqual(repos.mappings.get(v1, c1, '1'), auto);
  });
});

describe('MappingRepo.get / getMany / listAll', () => {
  it('linhas são isoladas por par (vitrine, checkout)', () => {
    const { repos, v1, v2, c1, c2 } = ctx();
    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1', { checkoutVariantId: '11' }),
      makeMapping(v1, c2, '1', { checkoutVariantId: '12' }),
      makeMapping(v2, c1, '1', { checkoutVariantId: '21' }),
    ]);

    assert.equal(repos.mappings.get(v1, c1, '1')?.checkoutVariantId, '11');
    assert.equal(repos.mappings.get(v1, c2, '1')?.checkoutVariantId, '12');
    assert.equal(repos.mappings.get(v2, c1, '1')?.checkoutVariantId, '21');
    assert.equal(repos.mappings.get(v2, c2, '1'), null);
    // Papéis trocados não são o mesmo par.
    assert.equal(repos.mappings.get(c1, v1, '1'), null);

    assert.deepEqual(vids(repos.mappings.listAll(v1, c1)), ['1']);
    assert.deepEqual(repos.mappings.listAll(v2, c2), []);
    assert.equal(repos.mappings.getMany(v1, c2, ['1']).get('1')?.checkoutVariantId, '12');
    assert.equal(repos.mappings.getMany(v2, c2, ['1']).size, 0);
  });

  it('getMany devolve um Map só com o que existe, ignorando repetidos e ids hostis', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1'), makeMapping(v1, c1, '2'), makeMapping(v1, c1, '3')]);

    const found = repos.mappings.getMany(v1, c1, ['3', '1', '1', '404', `1') OR ('1'='1`, '%', '']);
    assert.ok(found instanceof Map);
    assert.deepEqual([...found.keys()].sort(), ['1', '3']);
    assert.equal(found.get('3')?.checkoutVariantId, '93');
    assert.equal(repos.mappings.getMany(v1, c1, []).size, 0);
  });

  it('getMany divide listas grandes em lotes (5000 ids)', () => {
    const { repos, v1, c1, c2 } = ctx();
    const all = range(200_000, 5000);
    repos.mappings.upsertAuto(all.map((id) => makeMapping(v1, c1, id)));
    repos.mappings.upsertAuto([makeMapping(v1, c2, '200000', { checkoutVariantId: '1' })]);

    const found = repos.mappings.getMany(v1, c1, all);
    assert.equal(found.size, 5000);
    for (const id of all) assert.equal(found.get(id)?.checkoutVariantId, `9${id}`);

    const partial = repos.mappings.getMany(v1, c1, [...range(204_000, 5000), ...range(204_000, 5000)]);
    assert.deepEqual([...partial.keys()].sort(), range(204_000, 1000));
  });

  it('JSON corrompido em candidates e divergences não derruba leituras nem contagens', () => {
    const { repos, db, v1, c1 } = ctx();
    const corrupt: Array<[string, string]> = [
      ['1', 'não é json'],
      ['2', ''],
      ['3', '{"kind":"price"}'],
      ['4', 'null'],
      ['5', '[{"kind":"price",'],
    ];
    repos.mappings.upsertAuto(corrupt.map(([id]) => makeMapping(v1, c1, id, { divergences: [PRICE], candidates: ['1'] })));
    for (const [id, raw] of corrupt) {
      db.run('UPDATE variant_mappings SET candidates = ?, divergences = ? WHERE vitrine_variant_id = ?', [raw, raw, id]);
    }

    for (const [id] of corrupt) {
      const row = repos.mappings.get(v1, c1, id);
      assert.deepEqual(row?.candidates, [], id);
      assert.deepEqual(row?.divergences, [], id);
    }
    assert.equal(repos.mappings.listAll(v1, c1).length, 5);
    assert.equal(repos.mappings.getMany(v1, c1, ['1', '2', '3', '4', '5']).size, 5);
    assert.equal(repos.mappings.list(v1, c1, { limit: 50, offset: 0 }).total, 5);
    // Conteúdo ilegível conta como "sem divergência", igual ao que a leitura devolve.
    assert.deepEqual(repos.mappings.list(v1, c1, { divergentOnly: true, limit: 50, offset: 0 }), { rows: [], total: 0 });
    assert.equal(repos.mappings.counts(v1, c1).divergent, 0);
    assert.equal(repos.mappings.counts(v1, c1).total, 5);
  });

  it('array válido com itens fora do formato mantém só os itens bem formados', () => {
    const { repos, db, v1, c1 } = ctx();
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1')]);
    db.run('UPDATE variant_mappings SET candidates = ?, divergences = ?', [
      '["901", 902, null, {"id":"903"}, "904"]',
      '[1, null, {"vitrine":"a"}, {"kind":"price","vitrine":"1.00","checkout":"2.00","extra":1}, {"kind":"title"}]',
    ]);
    const row = repos.mappings.get(v1, c1, '1');
    assert.deepEqual(row?.candidates, ['901', '904']);
    assert.deepEqual(row?.divergences, [
      { kind: 'price', vitrine: '1.00', checkout: '2.00' },
      { kind: 'title', vitrine: '', checkout: '' },
    ]);
  });
});

/**
 * Par (v1, c1) com seis mapeamentos cobrindo todos os status; a variante 6 não tem linha no
 * catálogo da vitrine (mapeamento órfão). Os pares (v1, c2) e (v2, c1) têm uma linha cada.
 */
function seededList(): Ctx & { page: (opts?: Partial<MappingListOptions>) => { ids: string[]; total: number } } {
  const c = ctx();
  const { repos, v1, v2, c1, c2 } = c;
  repos.catalog.upsertVariants([
    makeVariant(v1, '1', { productId: '10', productTitle: 'Camiseta Básica', variantTitle: 'P / Preto', sku: 'CAM-P' }),
    makeVariant(v1, '2', { productId: '10', productTitle: 'Camiseta Básica', variantTitle: 'G / Branco', sku: 'CAM_G' }),
    makeVariant(v1, '3', { productId: '20', productTitle: 'Boné 100% Algodão', variantTitle: 'Único', sku: 'BONE-01' }),
    makeVariant(v1, '4', { productId: '30', productTitle: 'Água de Coco 👕', variantTitle: '50_ml', sku: null }),
    makeVariant(v1, '5', { productId: '40', productTitle: 'Tênis', variantTitle: 'c\\42', sku: 'TN-42' }),
    // Catálogo do checkout e de outra vitrine: nunca devem influenciar a busca do par (v1, c1).
    makeVariant(c1, '91', { productTitle: 'Zzcheckout Exclusivo', variantTitle: 'Lado checkout', sku: 'CHK-ONLY' }),
    makeVariant(c1, '6', { productTitle: 'Órfão Fantasma', variantTitle: 'Fantasma', sku: 'FANTASMA' }),
    makeVariant(v2, '1', { productTitle: 'Sandália', variantTitle: 'Par', sku: 'SAND-1' }),
    makeVariant(v2, '6', { productTitle: 'Sandália Fantasma', variantTitle: 'Par', sku: 'SAND-6' }),
  ]);
  repos.mappings.upsertAuto([
    makeMapping(v1, c1, '1', { status: 'active', divergences: [PRICE] }),
    makeMapping(v1, c1, '2', { status: 'active' }),
    makeMapping(v1, c1, '3', { status: 'suggested', method: 'title_options', divergences: [TITLE] }),
    makeMapping(v1, c1, '4', { status: 'conflict', checkoutVariantId: null, method: null, candidates: ['941', '942'] }),
    makeMapping(v1, c1, '5', { status: 'unmapped', checkoutVariantId: null, method: null }),
    makeMapping(v1, c1, '6', { status: 'disabled', divergences: [PRICE, TITLE] }),
    makeMapping(v1, c2, '1', { status: 'active', divergences: [PRICE] }),
    makeMapping(v2, c1, '1', { status: 'suggested' }),
  ]);
  const page = (opts: Partial<MappingListOptions> = {}): { ids: string[]; total: number } => {
    const result = repos.mappings.list(v1, c1, { limit: 50, offset: 0, ...opts });
    return { ids: vids(result.rows), total: result.total };
  };
  return { ...c, page };
}

describe('MappingRepo.list', () => {
  it('sem filtro devolve o par inteiro (órfão incluído), ordenado pelo catálogo da vitrine', () => {
    const { page, repos, v1, v2, c1, c2 } = seededList();
    // Órfão primeiro (sem título), depois Boné, Camiseta (G antes de P), Tênis e Água.
    assert.deepEqual(page(), { ids: ['6', '3', '2', '1', '5', '4'], total: 6 });
    assert.equal(repos.mappings.list(v1, c2, { limit: 50, offset: 0 }).total, 1);
    assert.equal(repos.mappings.list(v2, c1, { limit: 50, offset: 0 }).total, 1);
    assert.deepEqual(repos.mappings.list(v2, c2, { limit: 50, offset: 0 }), { rows: [], total: 0 });
  });

  it('devolve as linhas completas, não só os ids', () => {
    const { repos, v1, c1 } = seededList();
    const { rows } = repos.mappings.list(v1, c1, { status: 'conflict', limit: 50, offset: 0 });
    assert.deepEqual(rows, [repos.mappings.get(v1, c1, '4')]);
    assert.deepEqual(rows[0]?.candidates, ['941', '942']);
  });

  it('filtra por status', () => {
    const { page } = seededList();
    assert.deepEqual(page({ status: 'active' }), { ids: ['2', '1'], total: 2 });
    assert.deepEqual(page({ status: 'suggested' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ status: 'conflict' }), { ids: ['4'], total: 1 });
    assert.deepEqual(page({ status: 'unmapped' }), { ids: ['5'], total: 1 });
    assert.deepEqual(page({ status: 'disabled' }), { ids: ['6'], total: 1 });
  });

  it('divergentOnly traz só linhas com divergências, e combina com status', () => {
    const { page } = seededList();
    assert.deepEqual(page({ divergentOnly: true }), { ids: ['6', '3', '1'], total: 3 });
    assert.deepEqual(page({ divergentOnly: false }).total, 6);
    assert.deepEqual(page({ divergentOnly: true, status: 'active' }), { ids: ['1'], total: 1 });
    assert.deepEqual(page({ divergentOnly: true, status: 'conflict' }), { ids: [], total: 0 });
  });

  it('busca por título do produto, título da variante ou SKU da variante da VITRINE', () => {
    const { page, repos, v2, c1 } = seededList();
    assert.deepEqual(page({ search: 'camiseta' }), { ids: ['2', '1'], total: 2 });
    assert.deepEqual(page({ search: 'Preto' }), { ids: ['1'], total: 1 });
    assert.deepEqual(page({ search: 'bone-01' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ search: '  Tênis  ' }), { ids: ['5'], total: 1 });
    assert.deepEqual(page({ search: 'não existe' }), { ids: [], total: 0 });
    // Vazio ou só espaços é o mesmo que não buscar.
    assert.equal(page({ search: '' }).total, 6);
    assert.equal(page({ search: '   ' }).total, 6);

    // O catálogo do checkout não entra: nem pela variante de destino, nem por um id igual.
    assert.equal(page({ search: 'Exclusivo' }).total, 0);
    assert.equal(page({ search: 'CHK-ONLY' }).total, 0);
    assert.equal(page({ search: 'Fantasma' }).total, 0);
    // O catálogo de outra vitrine também não, mesmo com o mesmo id de variante.
    assert.equal(page({ search: 'Sandália' }).total, 0);
    const other = repos.mappings.list(v2, c1, { search: 'Sandália', limit: 50, offset: 0 });
    assert.deepEqual([vids(other.rows), other.total], [['1'], 1]);
  });

  it('busca combina com status e divergentOnly, e o total acompanha o mesmo filtro', () => {
    const { page } = seededList();
    assert.deepEqual(page({ search: 'camiseta', status: 'active' }), { ids: ['2', '1'], total: 2 });
    assert.deepEqual(page({ search: 'camiseta', divergentOnly: true }), { ids: ['1'], total: 1 });
    assert.deepEqual(page({ search: 'camiseta', status: 'suggested' }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: 'camiseta', limit: 1, offset: 1 }), { ids: ['1'], total: 2 });
    // Mapeamento órfão não tem texto para casar: some de qualquer busca.
    assert.deepEqual(page({ search: 'a', status: 'disabled' }), { ids: [], total: 0 });
  });

  it('pagina com limit/offset e devolve o total do filtro, não o da página', () => {
    const { page } = seededList();
    assert.deepEqual(page({ limit: 2, offset: 0 }), { ids: ['6', '3'], total: 6 });
    assert.deepEqual(page({ limit: 2, offset: 2 }), { ids: ['2', '1'], total: 6 });
    assert.deepEqual(page({ limit: 2, offset: 4 }), { ids: ['5', '4'], total: 6 });
    assert.deepEqual(page({ limit: 2, offset: 6 }), { ids: [], total: 6 });
    assert.deepEqual(page({ limit: 0 }), { ids: [], total: 6 });
    assert.deepEqual(page({ limit: -1, offset: -10 }), { ids: [], total: 6 });
    assert.deepEqual(page({ limit: 2.9, offset: 4.9 }), { ids: ['5', '4'], total: 6 });
    assert.deepEqual(page({ status: 'active', limit: 1, offset: 1 }), { ids: ['1'], total: 2 });
  });

  it('limite absurdo é cortado no teto; inválido cai no padrão', () => {
    const { repos, v2, c2 } = ctx();
    repos.mappings.upsertAuto(range(1, 1100).map((id) => makeMapping(v2, c2, id)));
    const size = (limit: number): { rows: number; total: number } => {
      const result = repos.mappings.list(v2, c2, { limit, offset: 0 });
      return { rows: result.rows.length, total: result.total };
    };
    assert.deepEqual(size(1_000_000_000), { rows: 1000, total: 1100 });
    assert.deepEqual(size(Number.POSITIVE_INFINITY), { rows: 50, total: 1100 });
    assert.deepEqual(size(Number.NaN), { rows: 50, total: 1100 });
  });

  it('neutraliza curingas do LIKE e o caractere NUL na busca', () => {
    const { page } = seededList();
    assert.deepEqual(page({ search: '%' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ search: '100%' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ search: '_' }), { ids: ['2', '4'], total: 2 });
    assert.deepEqual(page({ search: 'CAM_G' }), { ids: ['2'], total: 1 });
    assert.deepEqual(page({ search: 'CAM_P' }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: 'B%n' }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: '\\' }), { ids: ['5'], total: 1 });
    assert.deepEqual(page({ search: 'c\\42' }), { ids: ['5'], total: 1 });
    assert.deepEqual(page({ search: '\\%' }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: 'Boné\u0000zzz' }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: '\u0000Boné' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ search: '\u0000' }), page());
  });

  it('unicode na busca: acentos e emoji casam; texto enorme não quebra', () => {
    const { page } = seededList();
    assert.deepEqual(page({ search: 'Básica' }), { ids: ['2', '1'], total: 2 });
    assert.deepEqual(page({ search: 'Água' }), { ids: ['4'], total: 1 });
    assert.deepEqual(page({ search: '👕' }), { ids: ['4'], total: 1 });
    assert.deepEqual(page({ search: 'Único' }), { ids: ['3'], total: 1 });
    assert.deepEqual(page({ search: 'x'.repeat(100_000) }), { ids: [], total: 0 });
    assert.deepEqual(page({ search: `a${'👕'.repeat(150)}` }), { ids: [], total: 0 });
  });

  it('SQL na busca é só texto; status fora da lista é recusado antes de chegar ao banco', () => {
    const { page, db } = seededList();
    const attacks = [
      `' OR '1'='1`,
      `%' OR 1=1 --`,
      `x'; DROP TABLE variant_mappings; --`,
      `') OR ('1'='1`,
      `' UNION SELECT * FROM stores --`,
      `\\' OR 1=1 --`,
      '?',
      ':status',
    ];
    for (const search of attacks) assert.deepEqual(page({ search }), { ids: [], total: 0 }, search);

    const badStatuses = [`active' OR '1'='1`, `active'; DROP TABLE variant_mappings; --`, 'ACTIVE', '', '%', 'toString'];
    for (const status of badStatuses) {
      expectBridgeError(() => page({ status: status as MappingStatus }), 'invalid_request');
    }
    expectBridgeError(() => page({ status: null as unknown as MappingStatus }), 'invalid_request');

    assert.equal(tableCount(db, 'variant_mappings'), 8);
    assert.equal(tableCount(db, 'stores'), 4);
  });
});

describe('MappingRepo.counts', () => {
  it('devolve todos os status, mais divergentes e total, por par', () => {
    const { repos, v1, v2, c1, c2 } = seededList();
    assert.deepEqual(repos.mappings.counts(v1, c1), {
      active: 2,
      suggested: 1,
      conflict: 1,
      unmapped: 1,
      disabled: 1,
      divergent: 3,
      total: 6,
    });
    assert.deepEqual(repos.mappings.counts(v1, c2), {
      active: 1,
      suggested: 0,
      conflict: 0,
      unmapped: 0,
      disabled: 0,
      divergent: 1,
      total: 1,
    });
    assert.equal(repos.mappings.counts(v2, c1).suggested, 1);
    assert.equal(repos.mappings.counts(v2, c1).divergent, 0);
  });

  it('par sem linhas devolve zero em todas as chaves (nenhuma ausente)', () => {
    const { repos, v2, c2 } = seededList();
    const zeros = { active: 0, suggested: 0, conflict: 0, unmapped: 0, disabled: 0, divergent: 0, total: 0 };
    assert.deepEqual(repos.mappings.counts(v2, c2), zeros);
    assert.deepEqual(repos.mappings.counts(`x' OR '1'='1`, `x' OR '1'='1`), zeros);
  });

  it('bate com list: mesmo total por status e mesmos divergentes', () => {
    const { repos, v1, c1 } = seededList();
    const counts = repos.mappings.counts(v1, c1);
    const statuses: MappingStatus[] = ['active', 'suggested', 'conflict', 'unmapped', 'disabled'];
    let sum = 0;
    for (const status of statuses) {
      assert.equal(repos.mappings.list(v1, c1, { status, limit: 1, offset: 0 }).total, counts[status], status);
      sum += counts[status];
    }
    assert.equal(sum, counts.total);
    assert.equal(repos.mappings.list(v1, c1, { divergentOnly: true, limit: 1, offset: 0 }).total, counts.divergent);
  });

  it('acompanha as gravações', () => {
    const { repos, v1, c1 } = seededList();
    repos.mappings.setManual(makeMapping(v1, c1, '5', { status: 'active', method: 'manual', divergences: [PRICE] }));
    repos.mappings.upsertAuto([makeMapping(v1, c1, '1', { status: 'active', divergences: [] })]);
    const counts = repos.mappings.counts(v1, c1);
    assert.equal(counts.active, 3);
    assert.equal(counts.unmapped, 0);
    assert.equal(counts.divergent, 3);
    assert.equal(counts.total, 6);
  });
});

describe('MappingRepo.deleteMissing', () => {
  it('remove as linhas cuja variante da vitrine não está na lista, só naquele par', () => {
    const { repos, db, v1, v2, c1, c2 } = seededList();
    assert.equal(repos.mappings.deleteMissing(v1, c1, ['1', '3', '3', '404']), 4);

    assert.deepEqual(vids(repos.mappings.listAll(v1, c1)), ['1', '3']);
    assert.equal(repos.mappings.listAll(v1, c2).length, 1);
    assert.equal(repos.mappings.listAll(v2, c1).length, 1);
    assert.equal(tableCount(db, 'variant_mappings'), 4);
    // Repetir não remove mais nada.
    assert.equal(repos.mappings.deleteMissing(v1, c1, ['1', '3']), 0);
  });

  it('lista vazia remove todas as linhas do par, e só dele', () => {
    const { repos, db, v1, v2, c1, c2 } = seededList();
    assert.equal(repos.mappings.deleteMissing(v1, c1, []), 6);

    assert.deepEqual(repos.mappings.listAll(v1, c1), []);
    assert.equal(repos.mappings.listAll(v1, c2).length, 1);
    assert.equal(repos.mappings.listAll(v2, c1).length, 1);
    assert.equal(tableCount(db, 'variant_mappings'), 2);
    assert.equal(repos.mappings.deleteMissing(v1, c1, []), 0);
    assert.equal(repos.mappings.deleteMissing(v2, c2, []), 0);
  });

  it('lista só com ids desconhecidos também esvazia o par; linha travada não é poupada', () => {
    const { repos, v1, c1 } = seededList();
    repos.mappings.setManual(makeMapping(v1, c1, '2', { method: 'manual' }));
    assert.equal(repos.mappings.deleteMissing(v1, c1, ['404', '405']), 6);
    assert.equal(repos.mappings.get(v1, c1, '2'), null);
  });

  it('aguenta lista de 5000 ids para manter', () => {
    const { repos, v1, c1, c2 } = ctx();
    const existing = range(300_000, 6000);
    repos.mappings.upsertAuto(existing.map((id) => makeMapping(v1, c1, id)));
    repos.mappings.upsertAuto(existing.slice(0, 10).map((id) => makeMapping(v1, c2, id)));

    // Mantém 4500 existentes (intercalados, para cruzar os limites dos lotes) e 500 que não existem.
    const keepExisting = existing.filter((_, i) => i % 4 !== 0);
    const keep = [...keepExisting, ...range(900_000, 500)];
    assert.equal(keep.length, 5000);

    assert.equal(repos.mappings.deleteMissing(v1, c1, keep), 1500);
    assert.deepEqual(vids(repos.mappings.listAll(v1, c1)), keepExisting);
    assert.equal(repos.mappings.listAll(v1, c2).length, 10);
  });

  it('aguenta remover milhares de linhas de uma vez (exclusão em lotes)', () => {
    const { repos, v1, c1 } = ctx();
    repos.mappings.upsertAuto(range(400_000, 6000).map((id) => makeMapping(v1, c1, id)));
    assert.equal(repos.mappings.deleteMissing(v1, c1, ['400000', '405999']), 5998);
    assert.deepEqual(vids(repos.mappings.listAll(v1, c1)), ['400000', '405999']);
  });

  it('ids hostis na lista são comparados como texto', () => {
    const { repos, v1, c1 } = seededList();
    assert.equal(repos.mappings.deleteMissing(v1, c1, [`1' OR '1'='1`, '%', '_', '1']), 5);
    assert.deepEqual(vids(repos.mappings.listAll(v1, c1)), ['1']);
  });

  it('dentro de uma transação externa que falha, nada é removido', () => {
    const { repos, db, v1, c1 } = seededList();
    assert.throws(() =>
      db.transaction(() => {
        repos.mappings.deleteMissing(v1, c1, ['1']);
        throw new Error('falha depois');
      }),
    );
    assert.equal(repos.mappings.listAll(v1, c1).length, 6);
  });
});

describe('MappingRepo.deleteForStore', () => {
  function seededPairs(): Ctx {
    const c = ctx();
    const { repos, v1, v2, c1, c2 } = c;
    repos.mappings.upsertAuto([
      makeMapping(v1, c1, '1'),
      makeMapping(v1, c1, '2'),
      makeMapping(v1, c2, '1'),
      makeMapping(v2, c1, '1'),
      makeMapping(v2, c2, '1'),
    ]);
    repos.mappings.setManual(makeMapping(v2, c2, '2'));
    return c;
  }

  it('remove as linhas em que a loja é a vitrine', () => {
    const { repos, db, v1, v2, c1, c2 } = seededPairs();
    repos.mappings.deleteForStore(v1);
    assert.deepEqual(repos.mappings.listAll(v1, c1), []);
    assert.deepEqual(repos.mappings.listAll(v1, c2), []);
    assert.equal(repos.mappings.listAll(v2, c1).length, 1);
    assert.equal(repos.mappings.listAll(v2, c2).length, 2);
    assert.equal(tableCount(db, 'variant_mappings'), 3);
    // Só os mapeamentos somem; a loja continua cadastrada.
    assert.notEqual(repos.stores.get(v1), null);
  });

  it('remove as linhas em que a loja é o checkout', () => {
    const { repos, db, v1, v2, c1, c2 } = seededPairs();
    repos.mappings.deleteForStore(c1);
    assert.deepEqual(repos.mappings.listAll(v1, c1), []);
    assert.deepEqual(repos.mappings.listAll(v2, c1), []);
    assert.equal(repos.mappings.listAll(v1, c2).length, 1);
    assert.equal(repos.mappings.listAll(v2, c2).length, 2);
    assert.equal(tableCount(db, 'variant_mappings'), 3);
  });

  it('loja desconhecida ou texto hostil não remove nada', () => {
    const { repos, db } = seededPairs();
    repos.mappings.deleteForStore('st_nao_existe');
    repos.mappings.deleteForStore(`x' OR '1'='1`);
    repos.mappings.deleteForStore('%');
    assert.equal(tableCount(db, 'variant_mappings'), 6);
  });

  it('apagar a loja leva os mapeamentos dos dois lados (ON DELETE CASCADE)', () => {
    const { repos, db, v1, v2, c1, c2 } = seededPairs();
    repos.stores.delete(c2);
    assert.equal(tableCount(db, 'variant_mappings'), 3);
    repos.stores.delete(v1);
    assert.deepEqual(vids(repos.mappings.listAll(v2, c1)), ['1']);
    assert.equal(tableCount(db, 'variant_mappings'), 1);
  });
});

