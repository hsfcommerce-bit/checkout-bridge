import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRODUCT_VARIANTS_QUERY, SHOP_INFO_QUERY, VARIANTS_PAGE_QUERY } from '../src/catalog/queries.ts';
import { createCatalogSyncService } from '../src/catalog/sync.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import { BridgeError, isBridgeError } from '../src/types.ts';
import type { AdminClient, Alert, Alerter, BridgeErrorCode, Store, StoreRole } from '../src/types.ts';
import { makeStore, makeVariant, setup, T0 } from './db-helpers.ts';

// ---------------------------------------------------------------------------
// Apoio: AdminClient falso com respostas roteirizadas e repositórios reais
// ---------------------------------------------------------------------------

type Vars = Record<string, unknown>;
type Handler = (query: string, variables: Vars) => unknown;

function fakeAdmin(handler: Handler): { admin: AdminClient; calls: Array<{ query: string; variables: Vars }> } {
  const calls: Array<{ query: string; variables: Vars }> = [];
  const admin: AdminClient = {
    async graphql<T>(_store: Store, query: string, variables: Vars = {}): Promise<T> {
      calls.push({ query, variables });
      return (await handler(query, variables)) as T;
    },
  };
  return { admin, calls };
}

function shopData(over: Vars = {}): unknown {
  return {
    shop: {
      name: 'Loja Teste',
      currencyCode: 'BRL',
      myshopifyDomain: 'Loja-Teste.myshopify.com',
      primaryDomain: { host: 'www.lojateste.com.br' },
      ...over,
    },
  };
}

function productFields(productId: string, over: Vars = {}): Vars {
  return {
    id: `gid://shopify/Product/${productId}`,
    title: `Produto ${productId}`,
    handle: `produto-${productId}`,
    status: 'ACTIVE',
    ...over,
  };
}

/** Nó de variante no formato da Admin API. `product` só existe na consulta da loja inteira. */
function variantNode(variantId: string, productId: string | null, over: Vars = {}): Vars {
  return {
    id: `gid://shopify/ProductVariant/${variantId}`,
    title: `Variante ${variantId}`,
    sku: `SKU-${variantId}`,
    barcode: null,
    price: '39.90',
    compareAtPrice: null,
    availableForSale: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 5,
    selectedOptions: [{ name: 'Tamanho', value: 'M' }],
    inventoryItem: { tracked: true },
    ...(productId === null ? {} : { product: productFields(productId) }),
    ...over,
  };
}

function variantsPage(nodes: Vars[], endCursor: string | null): unknown {
  return { productVariants: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } };
}

function productPage(productId: string, nodes: Vars[], endCursor: string | null, over: Vars = {}): unknown {
  return {
    product: {
      ...productFields(productId, over),
      variants: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
    },
  };
}

/**
 * Roteiro por cursor: a chave '' é a primeira página. Um valor que é função é chamado (e
 * pode lançar); qualquer outro é devolvido como resposta.
 */
function scripted(pages: Record<string, unknown>, shop: unknown = shopData()): Handler {
  return (query, variables) => {
    if (query === SHOP_INFO_QUERY) return shop;
    const key = typeof variables['after'] === 'string' ? variables['after'] : '';
    if (!(key in pages)) throw new Error(`página não roteirizada: "${key}"`);
    const entry = pages[key];
    return typeof entry === 'function' ? (entry as (variables: Vars) => unknown)(variables) : entry;
  };
}

function harness(handler: Handler, opts: { role?: StoreRole; limits?: { pageSize?: number; maxObjects?: number } } = {}) {
  const ctx = setup();
  const store = makeStore(ctx.repos, opts.role ?? 'checkout');
  const { admin, calls } = fakeAdmin(handler);
  const alerts: Alert[] = [];
  const alerter: Alerter = { notify: (alert) => void alerts.push(alert) };
  const metrics = createMetrics();
  const service = createCatalogSyncService({
    repos: ctx.repos,
    admin,
    logger: createLogger({ level: 'silent', env: 'test' }),
    metrics,
    alerter,
    clock: ctx.clock,
    limits: opts.limits,
  });
  const pageCalls = () => calls.filter((call) => call.query !== SHOP_INFO_QUERY);
  return { ...ctx, store, service, calls, pageCalls, alerts, metrics };
}

async function rejectsWith(promise: Promise<unknown>, code: BridgeErrorCode): Promise<BridgeError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  assert.ok(isBridgeError(thrown), `esperava BridgeError('${code}'), veio: ${String(thrown)}`);
  assert.equal(thrown.code, code);
  return thrown;
}

// ---------------------------------------------------------------------------
// syncStore
// ---------------------------------------------------------------------------

describe('syncStore', () => {
  test('lê todas as páginas, grava as variantes e guarda moeda e domínio da loja', async () => {
    const h = harness(
      scripted({
        '': variantsPage([variantNode('1', '100'), variantNode('2', '100')], 'c1'),
        c1: variantsPage([variantNode('3', '200', { price: '10', compareAtPrice: '15.5', barcode: '789', image: { url: 'https://cdn.shopify.com/s/files/v3.jpg' } })], 'c2'),
        c2: variantsPage([variantNode('4', '300', { product: productFields('300', { featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/p300.jpg' } } } }) }), variantNode('5', '400', { image: { url: 'http://outro.site/x.jpg' } })], null),
      }),
    );
    h.clock.advance(1000);
    const startedAt = h.clock.now().toISOString();

    const result = await h.service.syncStore(h.store.id);

    assert.deepEqual(result, { storeId: h.store.id, ok: true, variants: 5, removed: 0, durationMs: 0, detail: null });
    assert.deepEqual(
      h.pageCalls().map((call) => call.variables),
      [
        { first: 100, after: null },
        { first: 100, after: 'c1' },
        { first: 100, after: 'c2' },
      ],
    );
    assert.equal(h.pageCalls().every((call) => call.query === VARIANTS_PAGE_QUERY), true);
    assert.equal(h.repos.catalog.count(h.store.id), 5);
    // Imagem: a da variante vale; sem ela, a do produto; URL fora do CDN da Shopify é descartada.
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.imageUrl, null);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '4')?.imageUrl, 'https://cdn.shopify.com/s/files/p300.jpg');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '5')?.imageUrl, null);
    assert.deepEqual(h.repos.catalog.getVariant(h.store.id, '3'), {
      storeId: h.store.id,
      variantId: '3',
      productId: '200',
      productTitle: 'Produto 200',
      productHandle: 'produto-200',
      productStatus: 'ACTIVE',
      variantTitle: 'Variante 3',
      options: [{ name: 'Tamanho', value: 'M' }],
      sku: 'SKU-3',
      barcode: '789',
      price: '10',
      compareAtPrice: '15.5',
      currency: 'BRL',
      availableForSale: true,
      inventoryPolicy: 'DENY',
      inventoryQuantity: 5,
      tracked: true,
      imageUrl: 'https://cdn.shopify.com/s/files/v3.jpg',
      syncedAt: startedAt,
    });

    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.currency, 'BRL');
    assert.equal(saved?.publicDomain, 'www.lojateste.com.br');
    assert.equal(saved?.lastSyncOk, true);
    assert.equal(saved?.lastSyncDetail, null);
    assert.equal(saved?.lastSyncAt, startedAt);
    assert.equal(h.alerts.length, 0);

    const rendered = h.metrics.render();
    assert.match(rendered, /bridge_catalog_sync_total\{result="ok"\} 1/);
    assert.match(rendered, /bridge_catalog_sync_ms_count 1/);
    assert.ok(rendered.includes(`bridge_catalog_variants{store="${h.store.shopDomain}"} 5`));
  });

  test('não troca o domínio público já informado e atualiza a moeda quando ela muda', async () => {
    let currencyCode = 'BRL';
    const h = harness((query) =>
      query === SHOP_INFO_QUERY ? shopData({ currencyCode }) : variantsPage([variantNode('1', '100')], null),
    );
    h.repos.stores.update(h.store.id, { publicDomain: 'checkout.minhaloja.com' });

    await h.service.syncStore(h.store.id);
    assert.equal(h.repos.stores.get(h.store.id)?.publicDomain, 'checkout.minhaloja.com');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.currency, 'BRL');

    currencyCode = 'USD';
    h.clock.advance(1000);
    const result = await h.service.syncStore(h.store.id);
    assert.equal(result.ok, true);
    assert.equal(h.repos.stores.get(h.store.id)?.currency, 'USD');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.currency, 'USD');
  });

  test('remove o que sumiu da loja só depois da última página', async () => {
    const seen: Array<string | null> = [];
    const h = harness((query, variables) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      // Enquanto a execução não termina, a variante antiga continua no catálogo.
      seen.push(h.repos.catalog.getVariant(h.store.id, '900')?.variantId ?? null);
      return variables['after'] === 'c1'
        ? variantsPage([variantNode('2', '100')], null)
        : variantsPage([variantNode('1', '100')], 'c1');
    });
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '900', { syncedAt: T0 }),
      makeVariant(h.store.id, '1', { price: '1.00', syncedAt: T0 }),
    ]);
    h.clock.advance(60_000);

    const result = await h.service.syncStore(h.store.id);

    assert.deepEqual(seen, ['900', '900']);
    assert.equal(result.ok, true);
    assert.equal(result.variants, 2);
    assert.equal(result.removed, 1);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '900'), null);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.price, '39.90');
    assert.equal(h.repos.catalog.count(h.store.id), 2);
  });

  test('falha na página 2 mantém o catálogo anterior e devolve ok = false', async () => {
    const h = harness(
      scripted({
        '': variantsPage([variantNode('1', '100'), variantNode('2', '100')], 'c1'),
        c1: () => {
          throw new BridgeError('upstream_unavailable', 'tempo esgotado; token shpat_segredo_123', {
            accessToken: 'shpat_segredo_123',
          });
        },
      }),
    );
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '900', { syncedAt: T0 }),
      makeVariant(h.store.id, '1', { price: '1.00', syncedAt: T0 }),
    ]);
    h.clock.advance(60_000);

    const result = await h.service.syncStore(h.store.id);

    assert.equal(result.ok, false);
    assert.equal(result.variants, 2);
    assert.equal(result.removed, 0);
    assert.match(result.detail ?? '', /A Shopify não respondeu/);
    assert.match(result.detail ?? '', /upstream_unavailable; páginas lidas: 1/);
    // Nada foi apagado: a variante que não veio nesta execução continua lá, e a página que
    // chegou inteira já foi gravada.
    assert.equal(h.repos.catalog.getVariant(h.store.id, '900')?.syncedAt, T0);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.price, '39.90');
    assert.equal(h.repos.catalog.count(h.store.id), 3);

    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.lastSyncOk, false);
    assert.equal(saved?.lastSyncDetail, result.detail);

    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `catalog-sync:${h.store.id}`);
    assert.equal(h.alerts[0]?.severity, 'warning');
    // Nem o detalhe do painel nem o alerta carregam a mensagem original do erro.
    assert.equal(JSON.stringify([result, saved, h.alerts]).includes('shpat_segredo_123'), false);

    const rendered = h.metrics.render();
    assert.match(rendered, /bridge_catalog_sync_total\{result="error"\} 1/);
    assert.ok(rendered.includes(`bridge_catalog_variants{store="${h.store.shopDomain}"} 3`));
  });

  test('erro que não é BridgeError, loja inexistente e resposta malformada nunca lançam', async () => {
    const h = harness(
      scripted({
        '': () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const network = await h.service.syncStore(h.store.id);
    assert.equal(network.ok, false);
    assert.match(network.detail ?? '', /upstream_unavailable/);

    const missing = await h.service.syncStore('st_nao_existe');
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? '', /Loja não encontrada/);
    assert.equal(h.alerts.at(-1)?.key, 'catalog-sync:st_nao_existe');

    const bad = harness(
      scripted({
        '': variantsPage([variantNode('1', '100')], 'c1'),
        c1: variantsPage([variantNode('2', '100', { price: null })], null),
      }),
    );
    bad.repos.catalog.upsertVariants([makeVariant(bad.store.id, '900', { syncedAt: T0 })]);
    bad.clock.advance(1000);
    const malformed = await bad.service.syncStore(bad.store.id);
    assert.equal(malformed.ok, false);
    assert.match(malformed.detail ?? '', /resposta inesperada/);
    assert.match(malformed.detail ?? '', /malformed_response/);
    assert.notEqual(bad.repos.catalog.getVariant(bad.store.id, '900'), null);
    assert.equal(bad.repos.catalog.getVariant(bad.store.id, '2'), null);
  });

  test('corta a página pela metade quando a Shopify recusa pelo custo e segue com a página menor', async () => {
    const h = harness((query, variables) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      if (Number(variables['first']) > 25) {
        throw new BridgeError('upstream_rejected', 'Consulta recusada pela Admin API', {
          errors: [{ message: 'Query cost is 1002', extensions: { code: 'MAX_COST_EXCEEDED' } }],
        });
      }
      return variables['after'] === 'c1'
        ? variantsPage([variantNode('2', '100')], null)
        : variantsPage([variantNode('1', '100')], 'c1');
    });

    const result = await h.service.syncStore(h.store.id);

    assert.equal(result.ok, true);
    assert.equal(result.variants, 2);
    assert.deepEqual(
      h.pageCalls().map((call) => call.variables),
      [
        { first: 100, after: null },
        { first: 50, after: null },
        { first: 25, after: null },
        { first: 25, after: 'c1' },
      ],
    );
    assert.equal(h.alerts.length, 0);
  });

  test('desiste quando nem a página de 1 variante cabe no custo', async () => {
    const h = harness((query) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      // O código também é reconhecido quando vem só na mensagem do erro.
      throw new BridgeError('upstream_rejected', 'custo máximo por consulta excedido (MAX_COST_EXCEEDED)');
    });
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '900', { syncedAt: T0 })]);
    h.clock.advance(1000);

    const result = await h.service.syncStore(h.store.id);

    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /max_cost_exceeded/);
    assert.deepEqual(
      h.pageCalls().map((call) => call.variables['first']),
      [100, 50, 25, 12, 6, 3, 1],
    );
    assert.equal(h.repos.catalog.count(h.store.id), 1);
  });

  test('para com alerta ao atingir o teto de paginação, sem apagar nada', async () => {
    let next = 0;
    const h = harness(
      (query, variables) => {
        if (query === SHOP_INFO_QUERY) return shopData();
        const nodes: Vars[] = [];
        for (let i = 0; i < Number(variables['first']); i += 1) {
          next += 1;
          nodes.push(variantNode(String(next), '100'));
        }
        return variantsPage(nodes, `c${next}`);
      },
      { limits: { pageSize: 2, maxObjects: 5 } },
    );
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '900', { syncedAt: T0 })]);
    h.clock.advance(1000);

    const result = await h.service.syncStore(h.store.id);

    assert.equal(result.ok, false);
    assert.equal(result.variants, 5);
    assert.equal(result.removed, 0);
    assert.match(result.detail ?? '', /limite de paginação/);
    // A última página pedida encolhe para o que ainda cabe no teto.
    assert.deepEqual(
      h.pageCalls().map((call) => call.variables['first']),
      [2, 2, 1],
    );
    assert.notEqual(h.repos.catalog.getVariant(h.store.id, '900'), null);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `catalog-sync:${h.store.id}`);
    assert.equal(h.repos.stores.get(h.store.id)?.lastSyncOk, false);
  });

  test('catálogo que termina exatamente no teto sincroniza normalmente', async () => {
    const h = harness(
      scripted({
        '': variantsPage([variantNode('1', '100'), variantNode('2', '100')], 'c1'),
        c1: variantsPage([variantNode('3', '100'), variantNode('4', '100')], null),
      }),
      { limits: { pageSize: 2, maxObjects: 4 } },
    );
    const result = await h.service.syncStore(h.store.id);
    assert.equal(result.ok, true);
    assert.equal(result.variants, 4);
  });

  test('estoque não rastreado fica com quantidade null; SKU em branco vira null', async () => {
    const h = harness(
      scripted({
        '': variantsPage(
          [
            variantNode('1', '100', { inventoryItem: { tracked: false }, inventoryQuantity: 7, sku: '  ' }),
            variantNode('2', '100', { inventoryQuantity: -3, inventoryPolicy: 'CONTINUE' }),
            variantNode('3', '100', { inventoryItem: null, inventoryQuantity: 9 }),
            variantNode('4', '100', { inventoryQuantity: null, availableForSale: false }),
          ],
          null,
        ),
      }),
    );
    await h.service.syncStore(h.store.id);

    const untracked = h.repos.catalog.getVariant(h.store.id, '1');
    assert.equal(untracked?.tracked, false);
    assert.equal(untracked?.inventoryQuantity, null);
    assert.equal(untracked?.sku, null);

    const tracked = h.repos.catalog.getVariant(h.store.id, '2');
    assert.equal(tracked?.tracked, true);
    assert.equal(tracked?.inventoryQuantity, -3);
    assert.equal(tracked?.inventoryPolicy, 'CONTINUE');

    const noItem = h.repos.catalog.getVariant(h.store.id, '3');
    assert.equal(noItem?.tracked, false);
    assert.equal(noItem?.inventoryQuantity, null);

    const noQuantity = h.repos.catalog.getVariant(h.store.id, '4');
    assert.equal(noQuantity?.tracked, true);
    assert.equal(noQuantity?.inventoryQuantity, null);
    assert.equal(noQuantity?.availableForSale, false);
  });

  test('produtos UNLISTED, DRAFT e ARCHIVED são mantidos com o status deles', async () => {
    const withStatus = (variantId: string, productId: string, status: string): Vars =>
      variantNode(variantId, null, { product: productFields(productId, { status }) });
    const h = harness(
      scripted({
        '': variantsPage(
          [withStatus('1', '100', 'UNLISTED'), withStatus('2', '200', 'DRAFT'), withStatus('3', '300', 'ARCHIVED')],
          null,
        ),
      }),
    );
    const result = await h.service.syncStore(h.store.id);

    assert.equal(result.variants, 3);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '1')?.productStatus, 'UNLISTED');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '2')?.productStatus, 'DRAFT');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '3')?.productStatus, 'ARCHIVED');
  });

  test('chamadas simultâneas para a mesma loja compartilham uma execução', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async (query) => {
      if (query === SHOP_INFO_QUERY) {
        await gate;
        return shopData();
      }
      return variantsPage([variantNode('1', '100')], null);
    });
    const other = makeStore(h.repos, 'vitrine');

    const first = h.service.syncStore(h.store.id);
    const second = h.service.syncStore(h.store.id);
    const third = h.service.syncStore(other.id);
    assert.equal(first, second);
    assert.notEqual(first, third);
    release();
    const [a, b, c] = await Promise.all([first, second, third]);

    assert.equal(a, b);
    assert.equal(a.ok, true);
    assert.equal(c.storeId, other.id);
    // Uma leitura de loja por execução: duas execuções (uma por loja), não três.
    assert.equal(h.calls.filter((call) => call.query === SHOP_INFO_QUERY).length, 2);

    // Terminada a execução, uma nova chamada começa outra.
    h.clock.advance(1000);
    const again = await h.service.syncStore(h.store.id);
    assert.equal(again.ok, true);
    assert.equal(h.calls.filter((call) => call.query === SHOP_INFO_QUERY).length, 3);
  });
});

// ---------------------------------------------------------------------------
// refreshProduct, removeProduct e fetchShopInfo
// ---------------------------------------------------------------------------

describe('refreshProduct', () => {
  test('acrescenta um produto novo lendo todas as páginas de variantes', async () => {
    const h = harness(
      scripted({
        '': productPage('500', [variantNode('11', null), variantNode('12', null)], 'p1', { status: 'UNLISTED' }),
        p1: productPage('500', [variantNode('13', null, { price: '99.00' })], null, { status: 'UNLISTED' }),
      }),
    );
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '1', { productId: '100' })]);
    h.clock.advance(5000);
    const now = h.clock.now().toISOString();

    await h.service.refreshProduct(h.store.id, '500');

    // Loja sem moeda guardada: lê a loja antes e guarda a moeda.
    assert.equal(h.calls[0]?.query, SHOP_INFO_QUERY);
    assert.equal(h.repos.stores.get(h.store.id)?.currency, 'BRL');
    assert.deepEqual(
      h.pageCalls().map((call) => [call.query === PRODUCT_VARIANTS_QUERY, call.variables]),
      [
        [true, { id: 'gid://shopify/Product/500', first: 100, after: null }],
        [true, { id: 'gid://shopify/Product/500', first: 100, after: 'p1' }],
      ],
    );
    assert.equal(h.repos.catalog.count(h.store.id), 4);
    const added = h.repos.catalog.getVariant(h.store.id, '13');
    assert.equal(added?.productId, '500');
    assert.equal(added?.productTitle, 'Produto 500');
    assert.equal(added?.productHandle, 'produto-500');
    assert.equal(added?.productStatus, 'UNLISTED');
    assert.equal(added?.price, '99.00');
    assert.equal(added?.currency, 'BRL');
    assert.equal(added?.syncedAt, now);
    assert.ok(h.metrics.render().includes(`bridge_catalog_variants{store="${h.store.shopDomain}"} 4`));
  });

  test('substitui as variantes do produto e remove as que sumiram, sem tocar nos outros', async () => {
    const h = harness(
      scripted({
        '': productPage('500', [variantNode('11', null, { price: '45.00' }), variantNode('14', null)], null),
      }),
    );
    h.repos.stores.update(h.store.id, { currency: 'USD' });
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '11', { productId: '500', price: '39.90' }),
      makeVariant(h.store.id, '12', { productId: '500' }),
      makeVariant(h.store.id, '13', { productId: '500' }),
      makeVariant(h.store.id, '1', { productId: '100' }),
    ]);

    await h.service.refreshProduct(h.store.id, '500');

    // Com a moeda já guardada não há leitura da loja.
    assert.equal(h.calls.filter((call) => call.query === SHOP_INFO_QUERY).length, 0);
    assert.deepEqual(
      h.repos.catalog
        .listAll(h.store.id)
        .map((variant) => variant.variantId)
        .sort(),
      ['1', '11', '14'],
    );
    assert.equal(h.repos.catalog.getVariant(h.store.id, '11')?.price, '45.00');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '14')?.currency, 'USD');
  });

  test('produto null (apagado na Shopify) remove as variantes dele', async () => {
    const h = harness(scripted({ '': { product: null } }));
    h.repos.stores.update(h.store.id, { currency: 'BRL' });
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '11', { productId: '500' }),
      makeVariant(h.store.id, '1', { productId: '100' }),
    ]);

    await h.service.refreshProduct(h.store.id, '500');

    assert.equal(h.repos.catalog.getVariant(h.store.id, '11'), null);
    assert.notEqual(h.repos.catalog.getVariant(h.store.id, '1'), null);
  });

  test('falha da Admin API propaga como BridgeError e deixa o produto como estava', async () => {
    const original = new BridgeError('upstream_unavailable', 'Admin API fora do ar');
    let failure: unknown = original;
    const h = harness(
      scripted({
        '': productPage('500', [variantNode('14', null)], 'p1'),
        p1: () => {
          throw failure;
        },
      }),
    );
    h.repos.stores.update(h.store.id, { currency: 'BRL' });
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '11', { productId: '500' })]);

    assert.equal(await rejectsWith(h.service.refreshProduct(h.store.id, '500'), 'upstream_unavailable'), original);

    failure = new TypeError('fetch failed');
    await rejectsWith(h.service.refreshProduct(h.store.id, '500'), 'upstream_unavailable');

    failure = new Error('algo inesperado');
    await rejectsWith(h.service.refreshProduct(h.store.id, '500'), 'internal');

    // A primeira página chegou, mas nada foi gravado: a troca só acontece com tudo lido.
    assert.deepEqual(
      h.repos.catalog.listAll(h.store.id).map((variant) => variant.variantId),
      ['11'],
    );
    assert.equal(h.alerts.length, 0);
  });

  test('resposta malformada, ID inválido e loja inexistente viram BridgeError', async () => {
    const h = harness(scripted({ '': productPage('777', [variantNode('14', null)], null) }));
    h.repos.stores.update(h.store.id, { currency: 'BRL' });
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '11', { productId: '500' })]);

    // A Shopify respondeu com outro produto: nada é gravado.
    const mismatch = await rejectsWith(h.service.refreshProduct(h.store.id, '500'), 'upstream_rejected');
    assert.equal(mismatch.details['reason'], 'malformed_response');
    assert.equal(h.repos.catalog.count(h.store.id), 1);

    const before = h.calls.length;
    await rejectsWith(h.service.refreshProduct(h.store.id, 'gid://shopify/Product/500'), 'invalid_request');
    await rejectsWith(h.service.refreshProduct('st_nao_existe', '500'), 'store_not_found');
    assert.equal(h.calls.length, before);
  });

  test('também corta a página pela metade quando o custo estoura', async () => {
    const h = harness((query, variables) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      if (Number(variables['first']) > 50) throw new BridgeError('upstream_rejected', 'MAX_COST_EXCEEDED');
      return productPage('500', [variantNode('11', null)], null);
    });
    await h.service.refreshProduct(h.store.id, '500');
    assert.deepEqual(
      h.pageCalls().map((call) => call.variables['first']),
      [100, 50],
    );
    assert.notEqual(h.repos.catalog.getVariant(h.store.id, '11'), null);
  });
});

describe('removeProduct e fetchShopInfo', () => {
  test('removeProduct apaga só o produto informado', () => {
    const h = harness(() => {
      throw new Error('não deveria chamar a Admin API');
    });
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '11', { productId: '500' }),
      makeVariant(h.store.id, '12', { productId: '500' }),
      makeVariant(h.store.id, '1', { productId: '100' }),
    ]);

    h.service.removeProduct(h.store.id, '500');
    // Produto que já não existe: não é erro.
    h.service.removeProduct(h.store.id, '500');

    assert.deepEqual(
      h.repos.catalog.listAll(h.store.id).map((variant) => variant.variantId),
      ['1'],
    );
    assert.equal(h.calls.length, 0);
    assert.ok(h.metrics.render().includes(`bridge_catalog_variants{store="${h.store.shopDomain}"} 1`));
  });

  test('fetchShopInfo devolve nome, moeda e domínios normalizados', async () => {
    const h = harness(() => shopData({ currencyCode: 'usd', primaryDomain: { host: 'WWW.Loja.com' } }));
    assert.deepEqual(await h.service.fetchShopInfo(h.store), {
      name: 'Loja Teste',
      currency: 'USD',
      primaryDomainHost: 'www.loja.com',
      myshopifyDomain: 'loja-teste.myshopify.com',
    });

    const noDomain = harness(() => shopData({ primaryDomain: null }));
    assert.equal((await noDomain.service.fetchShopInfo(noDomain.store)).primaryDomainHost, null);
  });

  test('fetchShopInfo propaga a falha de credenciais e recusa resposta sem moeda', async () => {
    const denied = harness(() => {
      throw new BridgeError('unauthorized', 'Credenciais recusadas');
    });
    await rejectsWith(denied.service.fetchShopInfo(denied.store), 'unauthorized');

    const broken = harness(() => ({ shop: { name: 'Loja', myshopifyDomain: 'loja.myshopify.com' } }));
    const err = await rejectsWith(broken.service.fetchShopInfo(broken.store), 'upstream_rejected');
    assert.equal(err.details['reason'], 'malformed_response');

    // Na sincronização completa a mesma recusa vira ok = false com o motivo em português.
    const result = await denied.service.syncStore(denied.store.id);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /recusou o acesso ao catálogo/);
    assert.equal(denied.pageCalls().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Sincronização completa e releitura da mesma loja nunca correm juntas (CAT-05)
// ---------------------------------------------------------------------------

function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('sincronização completa x releitura da mesma loja', () => {
  test('releitura pedida durante a completa espera; a página antiga não ressuscita a variante apagada', async () => {
    const page = gate();
    const h = harness(async (query, variables) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      if (query === VARIANTS_PAGE_QUERY) {
        // Foto tirada antes da exclusão da variante 12 na Shopify.
        await page.wait;
        return variantsPage([variantNode('11', '500'), variantNode('12', '500'), variantNode('1', '100')], null);
      }
      assert.equal(query, PRODUCT_VARIANTS_QUERY);
      assert.equal(variables['id'], 'gid://shopify/Product/500');
      return productPage('500', [variantNode('11', null)], null);
    });
    h.repos.catalog.upsertVariants([
      makeVariant(h.store.id, '11', { productId: '500' }),
      makeVariant(h.store.id, '12', { productId: '500' }),
    ]);

    const full = h.service.syncStore(h.store.id);
    await ticks();
    const refresh = h.service.refreshProduct(h.store.id, '500');
    await ticks();
    assert.equal(h.calls.filter((call) => call.query === PRODUCT_VARIANTS_QUERY).length, 0, 'a releitura espera a completa');

    page.release();
    const result = await full;
    assert.equal(result.ok, true);
    await refresh;

    assert.deepEqual(
      h.pageCalls().map((call) => call.query),
      [VARIANTS_PAGE_QUERY, PRODUCT_VARIANTS_QUERY],
      'a releitura só vai à Shopify depois da completa',
    );
    assert.deepEqual(
      h.repos.catalog
        .listAll(h.store.id)
        .map((variant) => variant.variantId)
        .sort(),
      ['1', '11'],
      'a variante 12, apagada na Shopify, não volta pela página antiga',
    );
  });

  test('completa pedida durante uma releitura espera por ela; deleteStale não apaga o que a releitura gravou', async () => {
    const product = gate();
    const h = harness(
      scripted({
        '': (variables: Vars) => {
          if (variables['id'] === 'gid://shopify/Product/500') {
            return product.wait.then(() => productPage('500', [variantNode('11', null, { price: '45.00' })], null));
          }
          return variantsPage([variantNode('11', '500', { price: '39.90' }), variantNode('1', '100')], 'p1');
        },
        p1: variantsPage([variantNode('2', '100')], null),
      }),
    );
    h.repos.stores.update(h.store.id, { currency: 'BRL' });
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '11', { productId: '500', price: '39.90' })]);

    // A releitura começa em T0 (synced_at = T0) e fica presa na Shopify.
    const refresh = h.service.refreshProduct(h.store.id, '500');
    await ticks();
    h.clock.advance(1000);
    const full = h.service.syncStore(h.store.id);
    await ticks();
    assert.equal(h.calls.filter((call) => call.query === VARIANTS_PAGE_QUERY).length, 0, 'a completa espera a releitura');

    product.release();
    await refresh;
    const result = await full;
    assert.equal(result.ok, true);
    assert.equal(result.removed, 0, 'nada gravado pela releitura foi tomado por obsoleto');
    assert.deepEqual(
      h.repos.catalog
        .listAll(h.store.id)
        .map((variant) => variant.variantId)
        .sort(),
      ['1', '11', '2'],
    );
    assert.equal(h.repos.catalog.getVariant(h.store.id, '11')?.syncedAt, h.clock.now().toISOString());
  });

  test('produto removido por webhook durante a completa não volta pela página lida antes; a próxima completa o relê', async () => {
    const page = gate();
    let waits = 0;
    const h = harness(async (query) => {
      if (query === SHOP_INFO_QUERY) return shopData();
      assert.equal(query, VARIANTS_PAGE_QUERY);
      waits += 1;
      if (waits === 1) await page.wait;
      return variantsPage([variantNode('11', '500'), variantNode('1', '100')], null);
    });
    h.repos.catalog.upsertVariants([makeVariant(h.store.id, '11', { productId: '500' })]);

    const full = h.service.syncStore(h.store.id);
    await ticks();
    // products/delete chega enquanto a página (que ainda traz o produto 500) está a caminho.
    h.service.removeProduct(h.store.id, '500');
    assert.equal(h.repos.catalog.getVariant(h.store.id, '11'), null);
    page.release();
    const result = await full;
    assert.equal(result.ok, true);
    assert.equal(h.repos.catalog.getVariant(h.store.id, '11'), null, 'a página antiga não ressuscita o produto apagado');
    assert.notEqual(h.repos.catalog.getVariant(h.store.id, '1'), null);

    // A marca vale só para aquela execução: se o produto reaparecer na Shopify, a próxima completa o grava.
    h.clock.advance(1000);
    const again = await h.service.syncStore(h.store.id);
    assert.equal(again.ok, true);
    assert.notEqual(h.repos.catalog.getVariant(h.store.id, '11'), null);
  });

  test('releitura que falha libera a espera da completa', async () => {
    const h = harness(
      scripted({
        '': (variables: Vars) => {
          if (variables['id'] === 'gid://shopify/Product/500') throw new BridgeError('upstream_unavailable', 'fora do ar');
          return variantsPage([variantNode('1', '100')], null);
        },
      }),
    );
    h.repos.stores.update(h.store.id, { currency: 'BRL' });
    const refresh = h.service.refreshProduct(h.store.id, '500');
    const full = h.service.syncStore(h.store.id);
    await rejectsWith(refresh, 'upstream_unavailable');
    const result = await full;
    assert.equal(result.ok, true);
    assert.equal(h.repos.catalog.count(h.store.id), 1);
  });
});
