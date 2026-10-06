import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareVariantIds, createMatchService, matchCatalogs, MAX_CONFLICT_CANDIDATES } from '../src/catalog/match.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import type { CatalogVariant, NewLink, VariantMapping } from '../src/types.ts';
import { at, makeMapping, makeStore, makeVariant, setup, T0 } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

const V = 'st_vitrine';
const C = 'st_checkout';
const NOW = '2026-03-01T12:00:00.000Z';

/**
 * Variantes "neutras": sem SKU nem código de barras e com handle e título próprios de cada
 * id, para que nenhuma regra case por acaso. Cada teste liga só a regra que quer exercitar.
 */
function vit(id: string, over: Partial<CatalogVariant> = {}): CatalogVariant {
  return makeVariant(V, id, { sku: null, barcode: null, productHandle: `v-${id}`, productTitle: `Vitrine ${id}`, ...over });
}

function chk(id: string, over: Partial<CatalogVariant> = {}): CatalogVariant {
  return makeVariant(C, id, { sku: null, barcode: null, productHandle: `c-${id}`, productTitle: `Checkout ${id}`, ...over });
}

function run(vitrine: CatalogVariant[], checkout: CatalogVariant[], priceToleranceBps = 0): VariantMapping[] {
  return matchCatalogs({ vitrineStoreId: V, checkoutStoreId: C, vitrine, checkout, priceToleranceBps, now: NOW });
}

function one(vitrine: CatalogVariant, checkout: CatalogVariant[], priceToleranceBps = 0): VariantMapping {
  const result = run([vitrine], checkout, priceToleranceBps);
  assert.equal(result.length, 1);
  const first = result[0];
  assert.ok(first);
  return first;
}

const SIZE_M = [{ name: 'Tamanho', value: 'M' }];
const SIZE_G = [{ name: 'Tamanho', value: 'G' }];

describe('matchCatalogs: SKU', () => {
  test('SKU com um único candidato ativa o mapeamento', () => {
    const mapping = one(vit('1', { sku: 'ABC-1' }), [chk('91', { sku: 'ABC-1' }), chk('92', { sku: 'ABC-2' })]);
    assert.deepEqual(mapping, {
      vitrineStoreId: V,
      checkoutStoreId: C,
      vitrineVariantId: '1',
      checkoutVariantId: '91',
      status: 'active',
      method: 'sku',
      candidates: [],
      divergences: [{ kind: 'title', vitrine: 'Vitrine 1', checkout: 'Checkout 91' }],
      locked: false,
      updatedAt: NOW,
    });
  });

  test('candidato único casa mesmo com opções diferentes (vira divergência)', () => {
    const mapping = one(vit('1', { sku: 'ABC', options: SIZE_M }), [chk('91', { sku: 'ABC', options: SIZE_G })]);
    assert.equal(mapping.status, 'active');
    assert.equal(mapping.checkoutVariantId, '91');
    assert.ok(mapping.divergences.some((d) => d.kind === 'options'));
  });

  test('exato e sensível a maiúsculas; as pontas são aparadas; vazio não conta', () => {
    assert.equal(one(vit('1', { sku: 'abc' }), [chk('91', { sku: 'ABC' })]).status, 'unmapped');
    assert.equal(one(vit('1', { sku: ' ABC ' }), [chk('91', { sku: 'ABC\t' })]).method, 'sku');
    assert.equal(one(vit('1', { sku: 'A B' }), [chk('91', { sku: 'A  B' })]).status, 'unmapped');
    assert.equal(one(vit('1', { sku: '' }), [chk('91', { sku: '' })]).status, 'unmapped');
    assert.equal(one(vit('1', { sku: '   ' }), [chk('91', { sku: ' ' })]).status, 'unmapped');
  });

  test('vários candidatos: as opções desempatam', () => {
    const checkout = [chk('91', { sku: 'ABC', options: SIZE_G }), chk('92', { sku: 'ABC', options: SIZE_M })];
    const mapping = one(vit('1', { sku: 'ABC', options: [{ name: 'tamanho', value: ' m' }] }), checkout);
    assert.equal(mapping.status, 'active');
    assert.equal(mapping.method, 'sku');
    assert.equal(mapping.checkoutVariantId, '92');
  });

  test('vários candidatos e nenhuma opção igual: conflito com todos', () => {
    const checkout = [chk('93', { sku: 'ABC', options: SIZE_G }), chk('91', { sku: 'ABC', options: SIZE_G })];
    const mapping = one(vit('1', { sku: 'ABC', options: SIZE_M }), checkout);
    assert.equal(mapping.status, 'conflict');
    assert.equal(mapping.method, 'sku');
    assert.equal(mapping.checkoutVariantId, null);
    assert.deepEqual(mapping.candidates, ['91', '93']);
    assert.deepEqual(mapping.divergences, []);
  });

  test('vários candidatos com a mesma opção: conflito só entre eles', () => {
    const checkout = [
      chk('93', { sku: 'ABC', options: SIZE_M }),
      chk('92', { sku: 'ABC', options: SIZE_G }),
      chk('91', { sku: 'ABC', options: SIZE_M }),
    ];
    const mapping = one(vit('1', { sku: 'ABC', options: SIZE_M }), checkout);
    assert.equal(mapping.status, 'conflict');
    assert.deepEqual(mapping.candidates, ['91', '93']);
  });

  test('conflito guarda no máximo 20 candidatos, em ordem numérica', () => {
    const checkout: CatalogVariant[] = [];
    for (let i = 30; i >= 1; i -= 1) checkout.push(chk(String(i * 7), { sku: 'ABC', options: SIZE_G }));
    const mapping = one(vit('1', { sku: 'ABC', options: SIZE_M }), checkout);
    assert.equal(mapping.candidates.length, MAX_CONFLICT_CANDIDATES);
    const expected = Array.from({ length: 20 }, (_, i) => String((i + 1) * 7));
    assert.deepEqual(mapping.candidates, expected);
  });

  test('conflito de SKU não desce para as regras seguintes', () => {
    const checkout = [
      chk('91', { sku: 'ABC', options: SIZE_G }),
      chk('92', { sku: 'ABC', options: SIZE_G }),
      chk('93', { barcode: '789', productHandle: 'mesmo', options: SIZE_M }),
    ];
    const mapping = one(vit('1', { sku: 'ABC', barcode: '789', productHandle: 'mesmo', options: SIZE_M }), checkout);
    assert.equal(mapping.status, 'conflict');
    assert.equal(mapping.method, 'sku');
  });
});

describe('matchCatalogs: precedência das regras', () => {
  // Cada variante do checkout satisfaz uma regra diferente para a mesma variante da vitrine.
  const bySku = chk('91', { sku: 'ABC' });
  const byBarcode = chk('92', { barcode: '7891234567895' });
  const byHandle = chk('93', { productHandle: 'camiseta-azul', options: SIZE_M });
  const byTitle = chk('94', { productTitle: 'CAMISETA  azul', options: SIZE_M });
  const source = vit('1', {
    sku: 'ABC',
    barcode: '7891234567895',
    productHandle: 'camiseta-azul',
    productTitle: 'Camiseta Azul',
    options: SIZE_M,
  });

  test('SKU > código de barras > handle > título > sem mapeamento', () => {
    const sku = one(source, [byTitle, byHandle, byBarcode, bySku]);
    assert.deepEqual([sku.status, sku.method, sku.checkoutVariantId], ['active', 'sku', '91']);
    const barcode = one(source, [byTitle, byHandle, byBarcode]);
    assert.deepEqual([barcode.status, barcode.method, barcode.checkoutVariantId], ['active', 'barcode', '92']);
    const handle = one(source, [byTitle, byHandle]);
    assert.deepEqual([handle.status, handle.method, handle.checkoutVariantId], ['active', 'handle_options', '93']);
    const title = one(source, [byTitle]);
    assert.deepEqual([title.status, title.method, title.checkoutVariantId], ['suggested', 'title_options', '94']);
    const none = one(source, [chk('95')]);
    assert.deepEqual([none.status, none.method, none.checkoutVariantId, none.candidates], ['unmapped', null, null, []]);
  });

  test('SKU sem candidato não impede as regras seguintes', () => {
    const mapping = one(vit('1', { sku: 'NAO-EXISTE', barcode: '789' }), [chk('91', { barcode: '789' })]);
    assert.deepEqual([mapping.status, mapping.method, mapping.checkoutVariantId], ['active', 'barcode', '91']);
  });

  test('código de barras: mesmas regras de desempate e conflito do SKU', () => {
    const checkout = [chk('91', { barcode: '789', options: SIZE_G }), chk('92', { barcode: '789', options: SIZE_M })];
    const narrowed = one(vit('1', { barcode: ' 789', options: SIZE_M }), checkout);
    assert.deepEqual([narrowed.status, narrowed.method, narrowed.checkoutVariantId], ['active', 'barcode', '92']);
    const conflict = one(vit('1', { barcode: '789', options: [{ name: 'Tamanho', value: 'P' }] }), checkout);
    assert.deepEqual([conflict.status, conflict.method, conflict.candidates], ['conflict', 'barcode', ['91', '92']]);
    // SKU e código de barras não se cruzam.
    assert.equal(one(vit('1', { sku: '789' }), [chk('91', { barcode: '789' })]).status, 'unmapped');
  });

  test('handle exige opções iguais; título igual com opções diferentes não sugere', () => {
    const sameHandleOtherSize = chk('91', { productHandle: 'camiseta', productTitle: 'Camiseta', options: SIZE_G });
    const mapping = one(vit('1', { productHandle: 'camiseta', productTitle: 'Camiseta', options: SIZE_M }), [sameHandleOtherSize]);
    assert.equal(mapping.status, 'unmapped');
  });

  test('título repetido em dois produtos do checkout: conflito, nunca escolha silenciosa', () => {
    const checkout = [
      chk('92', { productTitle: 'Camiseta', options: SIZE_M }),
      chk('91', { productTitle: 'camiseta ', options: SIZE_M }),
    ];
    const mapping = one(vit('1', { productTitle: 'Camiseta', options: SIZE_M }), checkout);
    assert.deepEqual(
      [mapping.status, mapping.method, mapping.checkoutVariantId, mapping.candidates],
      ['conflict', 'title_options', null, ['91', '92']],
    );
  });
});

describe('matchCatalogs: normalização, status e forma do resultado', () => {
  test('produto sem opções: "Title = Default Title" casa com outro igual', () => {
    const def = [{ name: 'Title', value: 'Default Title' }];
    const byHandle = one(vit('1', { productHandle: 'caneca', options: def }), [
      chk('91', { productHandle: 'caneca', options: [{ name: 'title', value: 'default title' }] }),
    ]);
    assert.deepEqual([byHandle.status, byHandle.method, byHandle.checkoutVariantId], ['active', 'handle_options', '91']);
    assert.ok(!byHandle.divergences.some((d) => d.kind === 'options'));
  });

  test('título: NFKC, caixa e espaços; opções em qualquer ordem', () => {
    const options = [
      { name: 'Cor', value: 'Azul' },
      { name: 'Tamanho', value: 'M' },
    ];
    const mapping = one(vit('1', { productTitle: 'Ｃamiseta  BÁSICA', options }), [
      chk('91', { productTitle: 'camiseta básica', options: [...options].reverse() }),
      chk('92', { productTitle: 'camiseta básica', options: [{ name: 'Cor', value: 'Verde' }, { name: 'Tamanho', value: 'M' }] }),
    ]);
    assert.deepEqual([mapping.status, mapping.method, mapping.checkoutVariantId], ['suggested', 'title_options', '91']);
    assert.deepEqual(mapping.divergences, []);
  });

  test('só produtos ACTIVE e UNLISTED da vitrine recebem linha', () => {
    const checkout = [chk('91', { sku: 'A' }), chk('92', { sku: 'B' }), chk('93', { sku: 'C' }), chk('94', { sku: 'D' })];
    const result = run(
      [
        vit('1', { sku: 'A', productStatus: 'ACTIVE' }),
        vit('2', { sku: 'B', productStatus: 'DRAFT' }),
        vit('3', { sku: 'C', productStatus: 'ARCHIVED' }),
        vit('4', { sku: 'D', productStatus: 'UNLISTED' }),
      ],
      checkout,
    );
    assert.deepEqual(result.map((m) => m.vitrineVariantId), ['1', '4']);
    assert.deepEqual(result.map((m) => m.checkoutVariantId), ['91', '94']);
  });

  test('produto do checkout em rascunho continua candidato e fica marcado', () => {
    const mapping = one(vit('1', { sku: 'A' }), [chk('91', { sku: 'A', productStatus: 'DRAFT' })]);
    assert.equal(mapping.status, 'active');
    assert.ok(mapping.divergences.some((d) => d.kind === 'product_status' && d.checkout === 'DRAFT'));
  });

  test('várias variantes da vitrine podem apontar para a mesma do checkout', () => {
    const result = run(
      [vit('3', { sku: 'KIT' }), vit('1', { sku: 'KIT' }), vit('2', { barcode: '789' })],
      [chk('91', { sku: 'KIT', barcode: '789' })],
    );
    assert.deepEqual(
      result.map((m) => [m.vitrineVariantId, m.checkoutVariantId, m.status, m.method]),
      [
        ['1', '91', 'active', 'sku'],
        ['2', '91', 'active', 'barcode'],
        ['3', '91', 'active', 'sku'],
      ],
    );
  });

  test('divergências acompanham o mapeamento e respeitam a tolerância', () => {
    const checkout = [chk('91', { sku: 'A', price: '101.00' })];
    const strict = one(vit('1', { sku: 'A', price: '100.00' }), checkout, 99);
    assert.deepEqual(strict.divergences[0], { kind: 'price', vitrine: '100.00', checkout: '101.00' });
    const loose = one(vit('1', { sku: 'A', price: '100.00' }), checkout, 100);
    assert.ok(!loose.divergences.some((d) => d.kind === 'price'));
  });

  test('saída ordenada pelo id da vitrine (ordem numérica) e independente da ordem de entrada', () => {
    const vitrine = ['100', '9', '25', '1000', '3'].map((id) => vit(id, { sku: `S${id}` }));
    const checkout = ['9100', '909', '9025', '91000', '903'].map((id, i) => chk(id, { sku: `S${vitrine[i]?.variantId}` }));
    const result = run(vitrine, checkout);
    assert.deepEqual(result.map((m) => m.vitrineVariantId), ['3', '9', '25', '100', '1000']);
    const shuffled = run([...vitrine].reverse(), [...checkout].reverse());
    assert.deepEqual(shuffled, result);
    assert.ok(result.every((m) => m.locked === false && m.updatedAt === NOW));
    assert.ok(compareVariantIds('9', '10') < 0 && compareVariantIds('10', '9') > 0 && compareVariantIds('7', '7') === 0);
  });

  test('entradas repetidas não fabricam conflito nem linha duplicada', () => {
    const target = chk('91', { sku: 'A' });
    const result = run([vit('1', { sku: 'A' }), vit('1', { sku: 'A' })], [target, { ...target }]);
    assert.equal(result.length, 1);
    assert.deepEqual([result[0]?.status, result[0]?.checkoutVariantId], ['active', '91']);
  });

  test('catálogos vazios', () => {
    assert.deepEqual(run([], [chk('91')]), []);
    assert.equal(one(vit('1', { sku: 'A' }), []).status, 'unmapped');
  });

  test('desempenho: 50.000 x 50.000 variantes em bem menos de um segundo', () => {
    const size = 50_000;
    const sizes = ['P', 'M', 'G', 'GG', 'XG'];
    const vitrine: CatalogVariant[] = [];
    const checkout: CatalogVariant[] = [];
    for (let i = 0; i < size; i += 1) {
      const product = Math.floor(i / 5);
      const options = [
        { name: 'Tamanho', value: sizes[i % 5] ?? 'U' },
        { name: 'Cor', value: `Cor ${product % 7}` },
      ];
      const rule = i % 10;
      const base = { productId: String(product + 1), options, variantTitle: `${options[0]?.value} / ${options[1]?.value}` };
      vitrine.push(
        vit(String(1_000_000 + i), {
          ...base,
          sku: rule < 4 ? `SKU-${i}` : rule === 9 ? `SO-VITRINE-${i}` : null,
          barcode: rule >= 4 && rule < 6 ? `789${i}` : null,
          productHandle: rule < 8 ? `produto-${product}` : `vitrine-${product}`,
          productTitle: rule < 9 ? `Produto Básico ${product}` : `Só na vitrine ${product}`,
        }),
      );
      checkout.push(
        chk(String(5_000_000 + i), {
          ...base,
          sku: rule < 4 ? `SKU-${i}` : null,
          barcode: rule >= 4 && rule < 6 ? `789${i}` : null,
          productHandle: rule < 8 ? `produto-${product}` : `checkout-${product}`,
          productTitle: `PRODUTO  básico ${product}`,
        }),
      );
    }
    const started = performance.now();
    const result = run(vitrine, checkout, 50);
    const elapsedMs = performance.now() - started;

    assert.equal(result.length, size);
    const byMethod = new Map<string, number>();
    for (const mapping of result) {
      const key = `${mapping.status}/${mapping.method ?? '-'}`;
      byMethod.set(key, (byMethod.get(key) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(byMethod), {
      'active/sku': 20_000,
      'active/barcode': 10_000,
      'active/handle_options': 10_000,
      'suggested/title_options': 5_000,
      'unmapped/-': 5_000,
    });
    // Um algoritmo quadrático levaria minutos; a folga cobre máquinas de CI lentas.
    assert.ok(elapsedMs < 1000, `matchCatalogs levou ${elapsedMs.toFixed(0)} ms`);
  });
});

// ---------------------------------------------------------------------------
// Serviço, com banco em memória e repositórios reais
// ---------------------------------------------------------------------------

interface Fixture extends TestContext {
  vitrineId: string;
  checkoutId: string;
  service: ReturnType<typeof createMatchService>;
  metrics: ReturnType<typeof createMetrics>;
  link(over?: Partial<NewLink>): void;
  rows(): VariantMapping[];
  row(vitrineVariantId: string): VariantMapping | null;
}

function fixture(): Fixture {
  const ctx = setup();
  const vitrineId = makeStore(ctx.repos, 'vitrine').id;
  const checkoutId = makeStore(ctx.repos, 'checkout').id;
  const metrics = createMetrics();
  const service = createMatchService({
    repos: ctx.repos,
    logger: createLogger({ level: 'silent', env: 'test' }),
    metrics,
    clock: ctx.clock,
  });
  return {
    ...ctx,
    vitrineId,
    checkoutId,
    service,
    metrics,
    link: (over = {}) => {
      ctx.repos.links.create({ vitrineStoreId: vitrineId, checkoutStoreId: checkoutId, kind: 'default', ...over });
    },
    rows: () => ctx.repos.mappings.listAll(vitrineId, checkoutId),
    row: (id) => ctx.repos.mappings.get(vitrineId, checkoutId, id),
  };
}

/** Variante neutra gravada no catálogo de uma loja real do banco. */
function stored(storeId: string, id: string, over: Partial<CatalogVariant> = {}): CatalogVariant {
  return makeVariant(storeId, id, {
    sku: null,
    barcode: null,
    productId: id,
    productHandle: `h-${storeId}-${id}`,
    productTitle: `Produto ${storeId} ${id}`,
    ...over,
  });
}

describe('createMatchService.rematchPair', () => {
  test('grava o resultado do casamento e devolve as contagens', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([
      stored(f.vitrineId, '1', { sku: 'A' }),
      stored(f.vitrineId, '2', { productTitle: 'Caneca', productHandle: 'caneca-v' }),
      stored(f.vitrineId, '3', { sku: 'DUP' }),
      stored(f.vitrineId, '4'),
      stored(f.vitrineId, '5', { sku: 'RASCUNHO', productStatus: 'DRAFT' }),
    ]);
    f.repos.catalog.upsertVariants([
      stored(f.checkoutId, '91', { sku: 'A', productTitle: `Produto ${f.vitrineId} 1` }),
      stored(f.checkoutId, '92', { productTitle: 'caneca', productHandle: 'caneca-c' }),
      stored(f.checkoutId, '93', { sku: 'DUP', options: [{ name: 'Tamanho', value: 'G' }] }),
      stored(f.checkoutId, '94', { sku: 'DUP', options: [{ name: 'Tamanho', value: 'P' }] }),
      stored(f.checkoutId, '95', { sku: 'RASCUNHO' }),
    ]);
    f.clock.set(at(5000));

    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);

    assert.deepEqual(summary, {
      vitrineStoreId: f.vitrineId,
      checkoutStoreId: f.checkoutId,
      counts: { active: 1, suggested: 1, conflict: 1, unmapped: 1, disabled: 0, divergent: 0, total: 4 },
    });
    assert.deepEqual(
      f.rows().map((m) => [m.vitrineVariantId, m.status, m.method, m.checkoutVariantId, m.candidates, m.locked, m.updatedAt]),
      [
        ['1', 'active', 'sku', '91', [], false, at(5000)],
        ['2', 'suggested', 'title_options', '92', [], false, at(5000)],
        ['3', 'conflict', 'sku', null, ['93', '94'], false, at(5000)],
        ['4', 'unmapped', null, null, [], false, at(5000)],
      ],
    );
    assert.match(f.metrics.render(), /bridge_match_runs_total 1/);
    assert.match(f.metrics.render(), /bridge_mappings\{[^}]*status="active"[^}]*\} 1/);
  });

  test('tolerância: a menor entre as rotas do par, inclusive as desativadas; sem rota, zero', () => {
    const f = fixture();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A', price: '100.00', productTitle: 'X' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A', price: '100.01', productTitle: 'X' })]);
    const priceDiverges = (): boolean => f.row('1')?.divergences.some((d) => d.kind === 'price') ?? false;

    // Sem rota: tolerância 0, um centavo já diverge.
    assert.equal(f.service.rematchPair(f.vitrineId, f.checkoutId).counts.divergent, 1);
    assert.equal(priceDiverges(), true);

    f.link({ priceToleranceBps: 500 });
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.equal(priceDiverges(), false);

    // Uma rota por país mais restritiva (e desativada) puxa a tolerância do par para 0.
    f.link({ kind: 'country', countries: ['US'], priceToleranceBps: 0, enabled: false });
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.equal(priceDiverges(), true);
    assert.equal(f.repos.mappings.counts(f.vitrineId, f.checkoutId).divergent, 1);
  });

  test('linha travada: destino preservado e divergências recalculadas contra o destino dela', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A', productTitle: 'X', price: '50.00' })]);
    f.repos.catalog.upsertVariants([
      stored(f.checkoutId, '91', { sku: 'A', productTitle: 'X', price: '50.00' }),
      stored(f.checkoutId, '99', { productTitle: 'X', price: '70.00' }),
    ]);
    // Decisão manual: o lojista escolheu 99, embora o SKU aponte para 91.
    f.repos.mappings.setManual(
      makeMapping(f.vitrineId, f.checkoutId, '1', { checkoutVariantId: '99', method: 'manual', divergences: [] }),
    );
    f.clock.set(at(1000));

    f.service.rematchPair(f.vitrineId, f.checkoutId);

    const first = f.row('1');
    assert.deepEqual(
      [first?.checkoutVariantId, first?.status, first?.method, first?.locked, first?.updatedAt],
      ['99', 'active', 'manual', true, at(1000)],
    );
    assert.deepEqual(first?.divergences, [{ kind: 'price', vitrine: '50.00', checkout: '70.00' }]);

    // O preço do destino travado é corrigido: a divergência some no próximo recálculo.
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '99', { productTitle: 'X', price: '50.00' })]);
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.deepEqual(f.row('1')?.divergences, []);
    assert.equal(f.row('1')?.checkoutVariantId, '99');
  });

  test('linha travada cujo destino sumiu do checkout: divergência "ausente", destino mantido', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' })]);
    f.repos.mappings.setManual(makeMapping(f.vitrineId, f.checkoutId, '1', { checkoutVariantId: '777', method: 'manual' }));

    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);

    const first = f.row('1');
    assert.deepEqual([first?.checkoutVariantId, first?.method, first?.locked], ['777', 'manual', true]);
    assert.deepEqual(first?.divergences, [{ kind: 'product_status', vitrine: 'ACTIVE', checkout: 'ausente' }]);
    assert.equal(summary.counts.divergent, 1);
  });

  test('linha desligada manualmente (sem destino) continua desligada e sem divergências', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A', price: '1.00' })]);
    f.repos.mappings.setManual(
      makeMapping(f.vitrineId, f.checkoutId, '1', {
        checkoutVariantId: null,
        status: 'disabled',
        method: 'manual',
        divergences: [{ kind: 'price', vitrine: '1.00', checkout: '2.00' }],
      }),
    );

    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);

    const first = f.row('1');
    assert.deepEqual([first?.status, first?.checkoutVariantId, first?.locked, first?.divergences], ['disabled', null, true, []]);
    assert.deepEqual([summary.counts.disabled, summary.counts.active, summary.counts.total], [1, 0, 1]);
  });

  test('destravar devolve a decisão ao casamento automático', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' }), stored(f.checkoutId, '99')]);
    f.repos.mappings.setManual(makeMapping(f.vitrineId, f.checkoutId, '1', { checkoutVariantId: '99', method: 'manual' }));
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.equal(f.row('1')?.checkoutVariantId, '99');

    f.repos.mappings.unlock(f.vitrineId, f.checkoutId, '1');
    f.service.rematchPair(f.vitrineId, f.checkoutId);

    const first = f.row('1');
    assert.deepEqual([first?.checkoutVariantId, first?.method, first?.locked], ['91', 'sku', false]);
  });
});

describe('createMatchService.rematchPair: limpeza', () => {
  test('variante que saiu do catálogo da vitrine perde a linha, travada ou não', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([
      stored(f.vitrineId, '1', { sku: 'A' }),
      stored(f.vitrineId, '2', { sku: 'B' }),
      stored(f.vitrineId, '3', { sku: 'C' }),
    ]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' }), stored(f.checkoutId, '92', { sku: 'B' })]);
    f.repos.mappings.setManual(makeMapping(f.vitrineId, f.checkoutId, '3', { checkoutVariantId: '92', method: 'manual' }));
    assert.equal(f.service.rematchPair(f.vitrineId, f.checkoutId).counts.total, 3);

    f.repos.catalog.deleteProduct(f.vitrineId, '2');
    f.repos.catalog.deleteProduct(f.vitrineId, '3');
    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);

    assert.deepEqual(f.rows().map((m) => m.vitrineVariantId), ['1']);
    assert.equal(summary.counts.total, 1);
  });

  test('produto da vitrine que vira rascunho: linha automática sai, decisão manual fica', () => {
    const f = fixture();
    f.link();
    const auto = stored(f.vitrineId, '1', { sku: 'A' });
    const manual = stored(f.vitrineId, '2', { sku: 'B', price: '10.00' });
    f.repos.catalog.upsertVariants([auto, manual]);
    f.repos.catalog.upsertVariants([
      stored(f.checkoutId, '91', { sku: 'A' }),
      stored(f.checkoutId, '92', { sku: 'B', price: '10.00', productTitle: manual.productTitle }),
    ]);
    f.repos.mappings.setManual(makeMapping(f.vitrineId, f.checkoutId, '2', { checkoutVariantId: '92', method: 'manual' }));
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.deepEqual(f.rows().map((m) => m.vitrineVariantId), ['1', '2']);

    f.repos.catalog.upsertVariants([{ ...auto, productStatus: 'DRAFT' }, { ...manual, productStatus: 'ARCHIVED' }]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '92', { sku: 'B', price: '12.00', productTitle: manual.productTitle })]);
    f.service.rematchPair(f.vitrineId, f.checkoutId);

    const kept = f.rows();
    assert.deepEqual(kept.map((m) => m.vitrineVariantId), ['2']);
    assert.deepEqual([kept[0]?.checkoutVariantId, kept[0]?.locked], ['92', true]);
    // Mesmo fora do ar, a linha travada continua com as divergências em dia.
    assert.deepEqual(kept[0]?.divergences, [{ kind: 'price', vitrine: '10.00', checkout: '12.00' }]);

    // De volta ao ar, a linha automática é recriada.
    f.repos.catalog.upsertVariants([auto]);
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.deepEqual(f.rows().map((m) => [m.vitrineVariantId, m.method]), [['1', 'sku'], ['2', 'manual']]);
  });

  test('catálogo da vitrine vazio: só limpa quando uma sincronização concluída confirma', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' }), stored(f.vitrineId, '2', { sku: 'B' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' })]);
    f.repos.mappings.setManual(makeMapping(f.vitrineId, f.checkoutId, '2', { checkoutVariantId: '91', method: 'manual' }));
    f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.equal(f.rows().length, 2);

    // Catálogo apagado sem sincronização concluída (nunca sincronizou, depois falhou).
    f.repos.catalog.deleteStore(f.vitrineId);
    assert.equal(f.service.rematchPair(f.vitrineId, f.checkoutId).counts.total, 2);
    f.repos.stores.markSynced(f.vitrineId, { at: T0, ok: false, detail: 'falhou' });
    assert.equal(f.service.rematchPair(f.vitrineId, f.checkoutId).counts.total, 2);
    assert.equal(f.row('2')?.locked, true);

    // Sincronização concluída com a loja realmente vazia: agora as linhas saem.
    f.repos.stores.markSynced(f.vitrineId, { at: T0, ok: true, detail: null });
    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);
    assert.equal(summary.counts.total, 0);
    assert.deepEqual(f.rows(), []);
  });

  test('catálogo do checkout vazio: tudo fica sem mapeamento, nada é apagado', () => {
    const f = fixture();
    f.link();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' })]);
    assert.equal(f.service.rematchPair(f.vitrineId, f.checkoutId).counts.active, 1);

    f.repos.catalog.deleteStore(f.checkoutId);
    const summary = f.service.rematchPair(f.vitrineId, f.checkoutId);

    assert.deepEqual([summary.counts.unmapped, summary.counts.total], [1, 1]);
    assert.deepEqual([f.row('1')?.status, f.row('1')?.checkoutVariantId, f.row('1')?.method], ['unmapped', null, null]);
  });

  test('recalcular duas vezes dá o mesmo resultado e não mexe em outro par', () => {
    const f = fixture();
    f.link();
    const otherCheckout = makeStore(f.repos, 'checkout').id;
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' }), stored(f.vitrineId, '2')]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' })]);
    f.repos.mappings.upsertAuto([makeMapping(f.vitrineId, otherCheckout, '555', { checkoutVariantId: '1' })]);

    const first = f.service.rematchPair(f.vitrineId, f.checkoutId);
    const snapshot = f.rows();
    const second = f.service.rematchPair(f.vitrineId, f.checkoutId);

    assert.deepEqual(second, first);
    assert.deepEqual(f.rows(), snapshot);
    // A linha do outro par tem uma variante que nem existe na vitrine e continua lá.
    assert.equal(f.repos.mappings.listAll(f.vitrineId, otherCheckout).length, 1);
  });

  test('lojas inexistentes: não lança e devolve contagens zeradas', () => {
    const f = fixture();
    const summary = f.service.rematchPair('st_nao_existe', 'st_tambem_nao');
    assert.equal(summary.counts.total, 0);
  });
});

describe('createMatchService.rematchStore', () => {
  test('recalcula cada par distinto com rota, pelo lado da vitrine ou do checkout', () => {
    const f = fixture();
    const secondCheckout = makeStore(f.repos, 'checkout').id;
    const otherVitrine = makeStore(f.repos, 'vitrine').id;
    // Duas rotas no mesmo par (uma desativada) contam como um par só. O relógio avança
    // entre as criações porque a ordem dos pares segue a ordem de criação das rotas.
    f.link();
    f.clock.advance(1000);
    f.link({ kind: 'country', countries: ['PT'], enabled: false });
    f.clock.advance(1000);
    f.repos.links.create({ vitrineStoreId: f.vitrineId, checkoutStoreId: secondCheckout, kind: 'country', countries: ['US'], enabled: false });
    f.clock.advance(1000);
    f.repos.links.create({ vitrineStoreId: otherVitrine, checkoutStoreId: f.checkoutId, kind: 'default' });
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' }), stored(otherVitrine, '5', { sku: 'A' })]);
    f.repos.catalog.upsertVariants([stored(f.checkoutId, '91', { sku: 'A' })]);

    const fromVitrine = f.service.rematchStore(f.vitrineId);
    assert.deepEqual(
      fromVitrine.map((s) => [s.vitrineStoreId, s.checkoutStoreId, s.counts.active, s.counts.unmapped]),
      [
        [f.vitrineId, f.checkoutId, 1, 0],
        [f.vitrineId, secondCheckout, 0, 1],
      ],
    );
    assert.equal(f.repos.mappings.listAll(otherVitrine, f.checkoutId).length, 0);

    const fromCheckout = f.service.rematchStore(f.checkoutId);
    assert.deepEqual(
      fromCheckout.map((s) => [s.vitrineStoreId, s.checkoutStoreId, s.counts.active]),
      [
        [f.vitrineId, f.checkoutId, 1],
        [otherVitrine, f.checkoutId, 1],
      ],
    );
  });

  test('loja sem rota: nada a recalcular', () => {
    const f = fixture();
    f.repos.catalog.upsertVariants([stored(f.vitrineId, '1', { sku: 'A' })]);
    assert.deepEqual(f.service.rematchStore(f.vitrineId), []);
    assert.deepEqual(f.service.rematchStore('st_nao_existe'), []);
    assert.deepEqual(f.rows(), []);
  });
});
