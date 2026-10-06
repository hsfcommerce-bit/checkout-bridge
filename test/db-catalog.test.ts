import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { CatalogVariant } from '../src/types.ts';
import { at, expectBridgeError, makeStore, makeVariant, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/**
 * Testes do CatalogRepo sobre SQLite em memória, com o repositório real.
 * IDs da Shopify são sempre strings numéricas, como em produção.
 */

const open: TestContext[] = [];

function ctx(): TestContext & { vitrine: string; checkout: string } {
  const c = setup();
  open.push(c);
  const vitrine = makeStore(c.repos, 'vitrine').id;
  const checkout = makeStore(c.repos, 'checkout').id;
  return { ...c, vitrine, checkout };
}

afterEach(() => {
  for (const c of open.splice(0)) c.db.close();
});

function ids(variants: CatalogVariant[]): string[] {
  return variants.map((v) => v.variantId);
}

function sortedIds(variants: CatalogVariant[]): string[] {
  return ids(variants).sort();
}

/** `count` ids numéricos em sequência a partir de `start`. */
function range(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(start + i));
}

describe('CatalogRepo.upsertVariants', () => {
  it('grava e devolve todos os campos, inclusive nulos e booleanos', () => {
    const { repos, vitrine } = ctx();
    const full = makeVariant(vitrine, '101', {
      productId: '2001',
      productTitle: 'Tênis de Corrida',
      productHandle: 'tenis-de-corrida',
      productStatus: 'DRAFT',
      variantTitle: '42 / Azul',
      options: [
        { name: 'Tamanho', value: '42' },
        { name: 'Cor', value: 'Azul' },
      ],
      sku: 'TN-42-AZ',
      barcode: '7891234567895',
      price: '399.90',
      compareAtPrice: '499.00',
      currency: 'BRL',
      availableForSale: false,
      inventoryPolicy: 'CONTINUE',
      inventoryQuantity: 0,
      tracked: false,
      syncedAt: at(1234),
    });
    const sparse = makeVariant(vitrine, '102', {
      sku: null,
      barcode: null,
      compareAtPrice: null,
      inventoryQuantity: null,
      options: [],
    });
    repos.catalog.upsertVariants([full, sparse]);

    assert.deepEqual(repos.catalog.getVariant(vitrine, '101'), full);
    assert.deepEqual(repos.catalog.getVariant(vitrine, '102'), sparse);
    assert.equal(repos.catalog.count(vitrine), 2);
  });

  it('atualiza a linha existente em vez de duplicar', () => {
    const { repos, db, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1', { price: '10.00', sku: 'A', barcode: '111' })]);
    const changed = makeVariant(vitrine, '1', {
      productId: '2002',
      productTitle: 'Outro título',
      productHandle: 'outro',
      productStatus: 'ARCHIVED',
      variantTitle: 'G',
      options: [{ name: 'Tamanho', value: 'G' }],
      sku: null,
      barcode: null,
      price: '12.50',
      compareAtPrice: '20.00',
      currency: 'USD',
      availableForSale: false,
      inventoryPolicy: 'CONTINUE',
      inventoryQuantity: null,
      tracked: false,
      syncedAt: at(5000),
    });
    repos.catalog.upsertVariants([changed]);

    assert.equal(tableCount(db, 'catalog_variants'), 1);
    assert.deepEqual(repos.catalog.getVariant(vitrine, '1'), changed);
  });

  it('a mesma variante repetida no lote fica com o último valor', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { price: '1.00' }),
      makeVariant(vitrine, '1', { price: '2.00' }),
    ]);
    assert.equal(repos.catalog.count(vitrine), 1);
    assert.equal(repos.catalog.getVariant(vitrine, '1')?.price, '2.00');
  });

  it('isola lojas: o mesmo variantId em duas lojas são linhas independentes', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { price: '10.00' }),
      makeVariant(checkout, '1', { price: '99.00' }),
    ]);
    repos.catalog.upsertVariants([makeVariant(vitrine, '1', { price: '11.00' })]);

    assert.equal(repos.catalog.getVariant(vitrine, '1')?.price, '11.00');
    assert.equal(repos.catalog.getVariant(checkout, '1')?.price, '99.00');
  });

  it('lista vazia não faz nada', () => {
    const { repos, db } = ctx();
    repos.catalog.upsertVariants([]);
    assert.equal(tableCount(db, 'catalog_variants'), 0);
  });

  it('é transacional: variante inválida no meio desfaz o lote inteiro', () => {
    const { repos, db, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1', { price: '10.00' })]);

    expectBridgeError(
      () =>
        repos.catalog.upsertVariants([
          makeVariant(vitrine, '1', { price: '55.00' }),
          makeVariant(vitrine, '2'),
          makeVariant(vitrine, '3', { price: '' }),
          makeVariant(vitrine, '4'),
        ]),
      'invalid_request',
    );

    assert.equal(tableCount(db, 'catalog_variants'), 1);
    assert.equal(repos.catalog.getVariant(vitrine, '1')?.price, '10.00');
  });

  it('loja inexistente vira store_not_found e desfaz o lote', () => {
    const { repos, db, vitrine } = ctx();
    expectBridgeError(
      () => repos.catalog.upsertVariants([makeVariant(vitrine, '1'), makeVariant('st_nao_existe', '2')]),
      'store_not_found',
    );
    assert.equal(tableCount(db, 'catalog_variants'), 0);
  });

  it('rejeita campos obrigatórios ausentes e datas inválidas', () => {
    const { repos, db, vitrine } = ctx();
    const bad: Array<Partial<CatalogVariant>> = [
      { variantId: '' },
      { productId: '' },
      { storeId: '' },
      { price: '' },
      { syncedAt: '' },
      { syncedAt: 'ontem' },
      { syncedAt: '+275000-01-01T00:00:00.000Z' },
    ];
    for (const overrides of bad) {
      expectBridgeError(() => repos.catalog.upsertVariants([makeVariant(vitrine, '1', overrides)]), 'invalid_request');
    }
    assert.equal(tableCount(db, 'catalog_variants'), 0);
  });

  it('normaliza syncedAt para o formato canônico de largura fixa', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { syncedAt: '2026-01-01T00:00:00Z' }),
      makeVariant(vitrine, '2', { syncedAt: '2026-01-01T03:00:00+03:00' }),
    ]);
    assert.equal(repos.catalog.getVariant(vitrine, '1')?.syncedAt, T0);
    assert.equal(repos.catalog.getVariant(vitrine, '2')?.syncedAt, T0);
  });

  it('estoque: trunca fração e grava null para valores que não são inteiros seguros', () => {
    const { repos, vitrine } = ctx();
    const cases: Array<[string, number | null, number | null]> = [
      ['1', 7.9, 7],
      ['2', -3.7, -3],
      ['3', -0.5, 0],
      ['4', Number.NaN, null],
      ['5', Number.POSITIVE_INFINITY, null],
      ['6', 2 ** 60, null],
      ['7', 1e300, null],
      ['8', -(2 ** 60), null],
      ['9', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ['10', null, null],
    ];
    repos.catalog.upsertVariants(cases.map(([id, quantity]) => makeVariant(vitrine, id, { inventoryQuantity: quantity })));

    // Antes da correção, um inteiro acima de 2^53 gravado fazia TODA leitura da loja lançar.
    const all = repos.catalog.getVariants(vitrine, cases.map(([id]) => id));
    for (const [id, , expected] of cases) {
      assert.equal(all.get(id)?.inventoryQuantity, expected, `variante ${id}`);
    }
    assert.equal(repos.catalog.listAll(vitrine).length, cases.length);
    assert.equal(repos.catalog.search(vitrine, { limit: 50, offset: 0 }).length, cases.length);
  });

  it('guarda texto com aspas, SQL e unicode como dado, sem interpretar', () => {
    const { repos, db, vitrine } = ctx();
    const nasty = makeVariant(vitrine, '1', {
      productTitle: `Robert'); DROP TABLE catalog_variants;--`,
      productHandle: 'x" OR "1"="1',
      variantTitle: '日本語 / Ελληνικά / 👕 / São João',
      sku: `'; DELETE FROM stores; --`,
      barcode: '%_\\',
      options: [{ name: 'Cor "especial"', value: `It's <b>azul</b>   \n` }],
    });
    repos.catalog.upsertVariants([nasty]);

    assert.deepEqual(repos.catalog.getVariant(vitrine, '1'), nasty);
    assert.equal(tableCount(db, 'stores'), 2);
  });
});

describe('CatalogRepo.replaceProduct', () => {
  /** Produto 1000 com três variantes na vitrine, produto 2000 na vitrine e produto 1000 no checkout. */
  function seeded(): ReturnType<typeof ctx> {
    const c = ctx();
    c.repos.catalog.upsertVariants([
      makeVariant(c.vitrine, '1', { productId: '1000', price: '10.00' }),
      makeVariant(c.vitrine, '2', { productId: '1000', price: '20.00' }),
      makeVariant(c.vitrine, '3', { productId: '1000', price: '30.00' }),
      makeVariant(c.vitrine, '50', { productId: '2000', price: '50.00' }),
      makeVariant(c.checkout, '1', { productId: '1000', price: '111.00' }),
      makeVariant(c.checkout, '9', { productId: '1000', price: '999.00' }),
    ]);
    return c;
  }

  it('remove as variantes que sumiram, atualiza as que ficaram e inclui as novas', () => {
    const { repos, vitrine } = seeded();
    repos.catalog.replaceProduct(vitrine, '1000', [
      makeVariant(vitrine, '2', { productId: '1000', price: '21.00', syncedAt: at(1000) }),
      makeVariant(vitrine, '4', { productId: '1000', price: '40.00', syncedAt: at(1000) }),
    ]);

    assert.equal(repos.catalog.getVariant(vitrine, '1'), null);
    assert.equal(repos.catalog.getVariant(vitrine, '3'), null);
    assert.equal(repos.catalog.getVariant(vitrine, '2')?.price, '21.00');
    assert.equal(repos.catalog.getVariant(vitrine, '2')?.syncedAt, at(1000));
    assert.equal(repos.catalog.getVariant(vitrine, '4')?.price, '40.00');
  });

  it('não toca em outros produtos nem em outras lojas', () => {
    const { repos, vitrine, checkout } = seeded();
    const otherProduct = repos.catalog.getVariant(vitrine, '50');
    const otherStore = repos.catalog.listAll(checkout);

    repos.catalog.replaceProduct(vitrine, '1000', [makeVariant(vitrine, '2', { productId: '1000' })]);

    assert.deepEqual(repos.catalog.getVariant(vitrine, '50'), otherProduct);
    assert.deepEqual(repos.catalog.listAll(checkout), otherStore);
    assert.deepEqual(sortedIds(repos.catalog.listAll(vitrine)), ['2', '50']);
  });

  it('lista vazia remove o produto inteiro (e só ele)', () => {
    const { repos, vitrine, checkout } = seeded();
    repos.catalog.replaceProduct(vitrine, '1000', []);
    assert.deepEqual(ids(repos.catalog.listAll(vitrine)), ['50']);
    assert.equal(repos.catalog.count(checkout), 2);
  });

  it('produto que ainda não existe é simplesmente inserido', () => {
    const { repos, vitrine } = seeded();
    repos.catalog.replaceProduct(vitrine, '3000', [makeVariant(vitrine, '70', { productId: '3000' })]);
    assert.equal(repos.catalog.count(vitrine), 5);
    assert.equal(repos.catalog.getVariant(vitrine, '70')?.productId, '3000');
  });

  it('rejeita variante de outra loja ou de outro produto sem alterar nada', () => {
    const { repos, vitrine, checkout } = seeded();
    const before = repos.catalog.listAll(vitrine);

    expectBridgeError(
      () =>
        repos.catalog.replaceProduct(vitrine, '1000', [
          makeVariant(vitrine, '2', { productId: '1000' }),
          makeVariant(checkout, '4', { productId: '1000' }),
        ]),
      'invalid_request',
    );
    expectBridgeError(
      () => repos.catalog.replaceProduct(vitrine, '1000', [makeVariant(vitrine, '4', { productId: '2000' })]),
      'invalid_request',
    );

    assert.deepEqual(repos.catalog.listAll(vitrine), before);
  });

  it('é transacional: falha na regravação devolve as variantes antigas', () => {
    const { repos, vitrine } = seeded();
    const before = repos.catalog.listAll(vitrine);

    // A primeira variante é válida e chega a ser gravada depois do DELETE; a segunda falha.
    expectBridgeError(
      () =>
        repos.catalog.replaceProduct(vitrine, '1000', [
          makeVariant(vitrine, '4', { productId: '1000' }),
          makeVariant(vitrine, '5', { productId: '1000', syncedAt: 'data ruim' }),
        ]),
      'invalid_request',
    );

    assert.deepEqual(repos.catalog.listAll(vitrine), before);
  });

  it('dentro de uma transação externa que falha, nada fica gravado', () => {
    const { repos, db, vitrine } = seeded();
    const before = repos.catalog.listAll(vitrine);
    assert.throws(() =>
      db.transaction(() => {
        repos.catalog.replaceProduct(vitrine, '1000', []);
        throw new Error('falha depois');
      }),
    );
    assert.deepEqual(repos.catalog.listAll(vitrine), before);
  });

  it('variante que mudou de produto é movida, sem duplicar', () => {
    const { repos, vitrine } = seeded();
    repos.catalog.replaceProduct(vitrine, '2000', [
      makeVariant(vitrine, '50', { productId: '2000' }),
      makeVariant(vitrine, '3', { productId: '2000' }),
    ]);
    assert.equal(repos.catalog.getVariant(vitrine, '3')?.productId, '2000');
    assert.equal(repos.catalog.count(vitrine), 4);
  });

  it('loja inexistente vira store_not_found', () => {
    const { repos } = seeded();
    expectBridgeError(
      () => repos.catalog.replaceProduct('st_fantasma', '1000', [makeVariant('st_fantasma', '1', { productId: '1000' })]),
      'store_not_found',
    );
  });
});

describe('CatalogRepo.deleteProduct / deleteStale / deleteStore', () => {
  it('deleteProduct remove só o produto daquela loja', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { productId: '1000' }),
      makeVariant(vitrine, '2', { productId: '1000' }),
      makeVariant(vitrine, '3', { productId: '2000' }),
      makeVariant(checkout, '1', { productId: '1000' }),
    ]);
    repos.catalog.deleteProduct(vitrine, '1000');
    repos.catalog.deleteProduct(vitrine, '9999');
    repos.catalog.deleteProduct(vitrine, `1000' OR '1'='1`);

    assert.deepEqual(ids(repos.catalog.listAll(vitrine)), ['3']);
    assert.equal(repos.catalog.count(checkout), 1);
  });

  it('deleteStale remove só o que é estritamente mais antigo e devolve a contagem', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { syncedAt: at(-1) }),
      makeVariant(vitrine, '2', { syncedAt: at(0) }),
      makeVariant(vitrine, '3', { syncedAt: at(1) }),
      makeVariant(vitrine, '4', { syncedAt: at(-86_400_000) }),
      makeVariant(checkout, '1', { syncedAt: at(-1) }),
    ]);

    assert.equal(repos.catalog.deleteStale(vitrine, at(0)), 2);
    assert.deepEqual(sortedIds(repos.catalog.listAll(vitrine)), ['2', '3']);
    // A outra loja tem uma linha antiga e não é afetada.
    assert.equal(repos.catalog.count(checkout), 1);
    assert.equal(repos.catalog.deleteStale(vitrine, at(0)), 0);
  });

  it('deleteStale compara instantes, não textos: aceita o corte em outro formato ISO', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { syncedAt: '2026-01-01T00:00:00Z' }),
      makeVariant(vitrine, '2', { syncedAt: '2025-12-31T23:59:59.999Z' }),
    ]);
    // Como texto, "2026-01-01T00:00:00Z" > "2026-01-01T00:00:00.000Z"; sem normalizar, a
    // variante 1 (mesmo instante do corte) seria apagada.
    assert.equal(repos.catalog.deleteStale(vitrine, '2026-01-01T00:00:00Z'), 1);
    assert.deepEqual(ids(repos.catalog.listAll(vitrine)), ['1']);
  });

  it('deleteStale rejeita corte inválido sem apagar nada', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1')]);
    for (const bad of ['', 'zzzz', `' OR 1=1 --`]) {
      expectBridgeError(() => repos.catalog.deleteStale(vitrine, bad), 'invalid_request');
    }
    assert.equal(repos.catalog.count(vitrine), 1);
  });

  it('deleteStore remove só o catálogo daquela loja', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1'), makeVariant(vitrine, '2'), makeVariant(checkout, '1')]);
    repos.catalog.deleteStore(vitrine);
    repos.catalog.deleteStore('st_nao_existe');

    assert.equal(repos.catalog.count(vitrine), 0);
    assert.equal(repos.catalog.count(checkout), 1);
    // A loja em si continua: só o catálogo foi removido.
    assert.notEqual(repos.stores.get(vitrine), null);
  });

  it('apagar a loja leva o catálogo junto (ON DELETE CASCADE)', () => {
    const { repos, db, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1'), makeVariant(checkout, '1')]);
    repos.stores.delete(vitrine);
    assert.equal(tableCount(db, 'catalog_variants'), 1);
    assert.equal(repos.catalog.count(checkout), 1);
  });
});

describe('CatalogRepo.getVariant / getVariants / listAll / count', () => {
  it('getVariant devolve null para variante desconhecida ou de outra loja', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1')]);
    assert.equal(repos.catalog.getVariant(vitrine, '2'), null);
    assert.equal(repos.catalog.getVariant(checkout, '1'), null);
    assert.equal(repos.catalog.getVariant(vitrine, `1' OR '1'='1`), null);
    assert.equal(repos.catalog.getVariant(`${vitrine}' OR '1'='1`, '1'), null);
  });

  it('getVariants devolve um Map só com o que existe naquela loja', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { price: '1.00' }),
      makeVariant(vitrine, '2', { price: '2.00' }),
      makeVariant(vitrine, '3', { price: '3.00' }),
      makeVariant(checkout, '4', { price: '4.00' }),
    ]);
    const found = repos.catalog.getVariants(vitrine, ['1', '3', '4', '999', '1', '3']);

    assert.ok(found instanceof Map);
    assert.deepEqual([...found.keys()].sort(), ['1', '3']);
    assert.equal(found.get('1')?.price, '1.00');
    assert.equal(found.get('3')?.price, '3.00');
    assert.equal(repos.catalog.getVariants(vitrine, []).size, 0);
    assert.equal(repos.catalog.getVariants('st_nao_existe', ['1']).size, 0);
  });

  it('getVariants divide listas grandes em lotes (5000 ids)', () => {
    const { repos, vitrine, checkout } = ctx();
    const all = range(100_000, 5000);
    repos.catalog.upsertVariants(all.map((id) => makeVariant(vitrine, id, { price: `${id}.00` })));
    repos.catalog.upsertVariants([makeVariant(checkout, '100000')]);

    const found = repos.catalog.getVariants(vitrine, all);
    assert.equal(found.size, 5000);
    for (const id of all) assert.equal(found.get(id)?.price, `${id}.00`);

    // Metade existente, metade não, mais duplicatas: os lotes não perdem nem repetem nada.
    const mixed = [...range(102_500, 5000), ...range(102_500, 5000)];
    const partial = repos.catalog.getVariants(vitrine, mixed);
    assert.equal(partial.size, 2500);
    assert.deepEqual([...partial.keys()].sort(), range(102_500, 2500));
  });

  it('getVariants trata ids hostis como texto comum', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1'), makeVariant(vitrine, '2')]);
    const found = repos.catalog.getVariants(vitrine, [`1') OR ('1'='1`, '?', '%', '', '2']);
    assert.deepEqual([...found.keys()], ['2']);
  });

  it('listAll devolve só a loja pedida, ordenada por título do produto e da variante', () => {
    const { repos, vitrine, checkout } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { productId: '10', productTitle: 'camiseta', variantTitle: 'P' }),
      makeVariant(vitrine, '2', { productId: '20', productTitle: 'Boné', variantTitle: 'Único' }),
      makeVariant(vitrine, '3', { productId: '10', productTitle: 'camiseta', variantTitle: 'G' }),
      makeVariant(vitrine, '4', { productId: '30', productTitle: 'Calça', variantTitle: '40' }),
      makeVariant(checkout, '5', { productTitle: 'Agasalho' }),
    ]);
    // Sem diferenciar maiúsculas: "Boné" < "Calça" < "camiseta"; dentro do produto, "G" < "P".
    assert.deepEqual(ids(repos.catalog.listAll(vitrine)), ['2', '4', '3', '1']);
    assert.deepEqual(repos.catalog.listAll('st_nao_existe'), []);
  });

  it('count conta por loja', () => {
    const { repos, vitrine, checkout } = ctx();
    assert.equal(repos.catalog.count(vitrine), 0);
    repos.catalog.upsertVariants([makeVariant(vitrine, '1'), makeVariant(vitrine, '2'), makeVariant(checkout, '1')]);
    assert.equal(repos.catalog.count(vitrine), 2);
    assert.equal(repos.catalog.count(checkout), 1);
    assert.equal(repos.catalog.count(`x' OR '1'='1`), 0);
  });
});

describe('CatalogRepo: leitura defensiva de colunas', () => {
  it('JSON corrompido na coluna options não derruba nenhuma leitura', () => {
    const { repos, db, vitrine } = ctx();
    const corrupt: Array<[string, string]> = [
      ['1', 'isto não é json'],
      ['2', ''],
      ['3', '{"name":"Cor","value":"Azul"}'],
      ['4', 'null'],
      ['5', '[{"name":"Cor","value":"Azul"},'],
      ['6', '"texto"'],
      ['7', '42'],
    ];
    repos.catalog.upsertVariants(corrupt.map(([id]) => makeVariant(vitrine, id)));
    for (const [id, raw] of corrupt) {
      db.run('UPDATE catalog_variants SET options = ? WHERE store_id = ? AND variant_id = ?', [raw, vitrine, id]);
    }
    const allIds = corrupt.map(([id]) => id);

    for (const id of allIds) assert.deepEqual(repos.catalog.getVariant(vitrine, id)?.options, [], `variante ${id}`);
    const many = repos.catalog.getVariants(vitrine, allIds);
    assert.equal(many.size, corrupt.length);
    for (const variant of many.values()) assert.deepEqual(variant.options, []);
    assert.equal(repos.catalog.listAll(vitrine).length, corrupt.length);
    assert.equal(repos.catalog.search(vitrine, { limit: 50, offset: 0 }).length, corrupt.length);
    assert.equal(repos.catalog.search(vitrine, { query: 'camiseta', limit: 50, offset: 0 }).length, corrupt.length);
  });

  it('array válido com itens fora do formato mantém só os itens bem formados', () => {
    const { repos, db, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1')]);
    db.run('UPDATE catalog_variants SET options = ? WHERE store_id = ?', [
      '[1, null, "x", [], {"name":"Cor"}, {"name":1,"value":"A"}, {"name":"Cor","value":"Azul","extra":true}]',
      vitrine,
    ]);
    assert.deepEqual(repos.catalog.getVariant(vitrine, '1')?.options, [{ name: 'Cor', value: 'Azul' }]);
  });

  it('estoque gravado como texto por fora do repositório vira null', () => {
    const { repos, db, vitrine } = ctx();
    repos.catalog.upsertVariants([makeVariant(vitrine, '1')]);
    db.run(`UPDATE catalog_variants SET inventory_quantity = 'muito' WHERE store_id = ?`, [vitrine]);
    assert.equal(repos.catalog.getVariant(vitrine, '1')?.inventoryQuantity, null);
  });

  it('options que não é array na gravação vira lista vazia', () => {
    const { repos, vitrine } = ctx();
    const broken = { ...makeVariant(vitrine, '1'), options: 'Tamanho=M' } as unknown as CatalogVariant;
    repos.catalog.upsertVariants([broken]);
    assert.deepEqual(repos.catalog.getVariant(vitrine, '1')?.options, []);
  });
});

describe('CatalogRepo.search', () => {
  function seeded(): ReturnType<typeof ctx> & { find: (query: string) => string[] } {
    const c = ctx();
    c.repos.catalog.upsertVariants([
      makeVariant(c.vitrine, '1', { productId: '10', productTitle: 'Camiseta Básica', variantTitle: 'P / Preto', sku: 'CAM-P-PT', barcode: '7890001' }),
      makeVariant(c.vitrine, '2', { productId: '10', productTitle: 'Camiseta Básica', variantTitle: 'G / Branco', sku: 'CAM_G_BR', barcode: '7890002' }),
      makeVariant(c.vitrine, '3', { productId: '20', productTitle: 'Boné 100% Algodão', variantTitle: 'Único', sku: 'BONE-01', barcode: null }),
      makeVariant(c.vitrine, '4', { productId: '30', productTitle: 'Água de Coco', variantTitle: 'Caixa c\\12', sku: null, barcode: '5551234' }),
      makeVariant(c.vitrine, '5', { productId: '40', productTitle: `Kit d'Água 日本語 👕`, variantTitle: '50_ml', sku: 'CAMXGXBR', barcode: null }),
      makeVariant(c.checkout, '6', { productId: '10', productTitle: 'Camiseta Básica', variantTitle: 'P / Preto', sku: 'CAM-P-PT', barcode: '7890001' }),
    ]);
    const find = (query: string): string[] => ids(c.repos.catalog.search(c.vitrine, { query, limit: 50, offset: 0 }));
    return { ...c, find };
  }

  it('casa com título do produto, título da variante, SKU ou código de barras', () => {
    const { find } = seeded();
    assert.deepEqual(find('Boné'), ['3']);
    assert.deepEqual(find('Branco'), ['2']);
    assert.deepEqual(find('BONE-01'), ['3']);
    assert.deepEqual(find('5551234'), ['4']);
    // Trecho no meio do texto, e sem diferenciar maiúsculas em ASCII.
    assert.deepEqual(find('miseta'), ['2', '1']);
    assert.deepEqual(find('cam-p'), ['1']);
    assert.deepEqual(find('789000'), ['2', '1']);
    assert.deepEqual(find('nada que exista'), []);
  });

  it('nunca devolve variantes de outra loja', () => {
    const { repos, find, checkout } = seeded();
    assert.ok(!find('Camiseta').includes('6'));
    assert.deepEqual(ids(repos.catalog.search(checkout, { query: 'Camiseta', limit: 50, offset: 0 })), ['6']);
    assert.deepEqual(repos.catalog.search('st_nao_existe', { limit: 50, offset: 0 }), []);
  });

  it('sem texto (ausente, vazio ou só espaços) lista tudo; espaços nas pontas são ignorados', () => {
    const { repos, find, vitrine } = seeded();
    const everything = ['3', '2', '1', '5', '4'];
    assert.deepEqual(ids(repos.catalog.search(vitrine, { limit: 50, offset: 0 })), everything);
    assert.deepEqual(find(''), everything);
    assert.deepEqual(find('   \t\n'), everything);
    assert.deepEqual(find('  Boné  '), ['3']);
  });

  it('ordena por título do produto e depois da variante, sem diferenciar maiúsculas', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants([
      makeVariant(vitrine, '1', { productId: '1', productTitle: 'zebra', variantTitle: 'b' }),
      makeVariant(vitrine, '2', { productId: '2', productTitle: 'Abacaxi', variantTitle: 'Z' }),
      makeVariant(vitrine, '3', { productId: '2', productTitle: 'Abacaxi', variantTitle: 'a' }),
      makeVariant(vitrine, '4', { productId: '3', productTitle: 'abacate', variantTitle: 'M' }),
      makeVariant(vitrine, '5', { productId: '1', productTitle: 'zebra', variantTitle: 'A' }),
      // Mesmo título de produto e de variante em produtos diferentes: desempate estável.
      makeVariant(vitrine, '7', { productId: '5', productTitle: 'Manga', variantTitle: 'M' }),
      makeVariant(vitrine, '6', { productId: '4', productTitle: 'Manga', variantTitle: 'M' }),
    ]);
    const expected = ['4', '3', '2', '6', '7', '5', '1'];
    assert.deepEqual(ids(repos.catalog.search(vitrine, { limit: 50, offset: 0 })), expected);
    assert.deepEqual(ids(repos.catalog.search(vitrine, { query: 'a', limit: 50, offset: 0 })), expected);
  });

  it('pagina com limit/offset sem repetir nem pular linhas', () => {
    const { repos, vitrine } = ctx();
    const all = range(1000, 23);
    repos.catalog.upsertVariants(all.map((id) => makeVariant(vitrine, id, { productId: id, productTitle: `Produto ${id}` })));

    const seen: string[] = [];
    for (let offset = 0; offset < 30; offset += 5) {
      const page = ids(repos.catalog.search(vitrine, { query: 'produto', limit: 5, offset }));
      assert.ok(page.length <= 5);
      seen.push(...page);
    }
    assert.deepEqual(seen, all);
    assert.deepEqual(ids(repos.catalog.search(vitrine, { limit: 3, offset: 21 })), ['1021', '1022']);
    assert.deepEqual(repos.catalog.search(vitrine, { limit: 5, offset: 23 }), []);
  });

  it('saneia limit e offset inválidos', () => {
    const { repos, vitrine } = ctx();
    repos.catalog.upsertVariants(range(1, 600).map((id) => makeVariant(vitrine, id)));
    const len = (limit: number, offset: number): number => repos.catalog.search(vitrine, { limit, offset }).length;

    assert.equal(len(0, 0), 0);
    assert.equal(len(-5, 0), 0);
    assert.equal(len(2.9, 0), 2);
    assert.equal(len(10, -3), 10);
    assert.equal(len(10, 595.7), 5);
    assert.equal(len(10, Number.MAX_VALUE), 0);
    // Limite absurdo é cortado no teto do repositório; inválido cai no padrão.
    assert.equal(len(1_000_000, 0), 500);
    assert.equal(len(Number.POSITIVE_INFINITY, 0), 50);
    assert.equal(len(Number.NaN, Number.NaN), 50);
  });

  it('neutraliza os curingas do LIKE no texto do usuário', () => {
    const { find } = seeded();
    // "%" e "_" valem como caracteres literais.
    assert.deepEqual(find('%'), ['3']);
    assert.deepEqual(find('100%'), ['3']);
    assert.deepEqual(find('100% A'), ['3']);
    assert.deepEqual(find('_'), ['2', '5']);
    assert.deepEqual(find('CAM_G_BR'), ['2']);
    assert.deepEqual(find('50_'), ['5']);
    assert.deepEqual(find('C%a'), []);
    assert.deepEqual(find('B_n'), []);
    assert.deepEqual(find('%%'), []);
    // A barra do ESCAPE também é literal.
    assert.deepEqual(find('\\'), ['4']);
    assert.deepEqual(find('c\\12'), ['4']);
    assert.deepEqual(find('\\%'), []);
    assert.deepEqual(find('\\_'), []);
  });

  it('texto com SQL é só texto: não casa com tudo e não altera o banco', () => {
    const { find, db } = seeded();
    const attacks = [
      `' OR '1'='1`,
      `' OR 1=1 --`,
      `%' OR 1=1 --`,
      `x'; DROP TABLE catalog_variants; --`,
      `") OR ("1"="1`,
      `\\' OR 1=1 --`,
      `' UNION SELECT * FROM stores --`,
      `'; DELETE FROM catalog_variants WHERE '1'='1`,
      '?',
      '?1',
      ':storeId',
      'zzz\u0000',
      '\u0000zzz',
    ];
    for (const attack of attacks) assert.deepEqual(find(attack), [], attack);
    assert.equal(tableCount(db, 'catalog_variants'), 6);
    assert.equal(tableCount(db, 'stores'), 2);
    // Apóstrofo legítimo continua funcionando.
    assert.deepEqual(find(`d'Água`), ['5']);
  });

  it('caractere NUL no texto não trunca o padrão do LIKE', () => {
    const { find } = seeded();
    // Para o LIKE do SQLite o padrão termina no NUL: sem remover o caractere,
    // "Boné\u0000zzz" buscaria só "Boné" e "\u0000Boné" viraria "%", que casa com tudo.
    assert.deepEqual(find('Boné\u0000zzz'), []);
    assert.deepEqual(find('\u0000Boné'), ['3']);
    assert.deepEqual(find('Bo\u0000né'), ['3']);
    // Só NUL (ou NUL e espaços) é o mesmo que busca vazia: lista sem filtro, na ordem normal.
    assert.deepEqual(find('\u0000'), find(''));
    assert.deepEqual(find(' \u0000 \u0000 '), find(''));
  });

  it('unicode: acentos, CJK e emoji casam; texto enorme ou cortado no meio de um emoji não quebra', () => {
    const { find } = seeded();
    assert.deepEqual(find('Básica'), ['2', '1']);
    assert.deepEqual(find('Algodão'), ['3']);
    assert.deepEqual(find('日本'), ['5']);
    assert.deepEqual(find('👕'), ['5']);
    assert.deepEqual(find('Água'), ['5', '4']);
    // O texto de busca é cortado em 200 caracteres: nada disto pode lançar.
    assert.deepEqual(find('x'.repeat(100_000)), []);
    assert.deepEqual(find('%'.repeat(100_000)), []);
    assert.deepEqual(find(`a${'👕'.repeat(150)}`), []);
    assert.deepEqual(find('\ud83d'), []);
  });
});

