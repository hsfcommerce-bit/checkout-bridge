import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createE2E, PROXY_PATH, setupScenario } from './support/e2e-harness.ts';
import type { E2E, Scenario } from './support/e2e-harness.ts';

/**
 * Fluxo completo pela aplicação inteira (createApp + app.request) com a Shopify falsa:
 * cadastro pelo painel, conexão, mapeamento por SKU, checkout pelo App Proxy para a loja
 * da rota certa, webhook de catálogo e tarefas periódicas.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Todas as chaves de um JSON, em qualquer profundidade. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out));
  else if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      allKeys(inner, out);
    }
  }
  return out;
}

describe('ponta a ponta: fluxo do lojista e do comprador', () => {
  let e2e: E2E;
  let s: Scenario;

  before(async () => {
    e2e = createE2E();
    s = await setupScenario(e2e);
  });
  after(() => e2e.close());

  it('cadastra e conecta as três lojas pelo painel (token, loja, escopos, webhooks, catálogo)', () => {
    for (const ref of [s.vitrine, s.checkoutA, s.checkoutB]) {
      const store = e2e.deps.repos.stores.get(ref.id);
      assert.ok(store !== null);
      assert.equal(store.status, 'connected', `${ref.domain}: ${store.statusDetail ?? ''}`);
      assert.equal(store.currency, 'BRL');
      assert.equal(store.lastSyncOk, true);
      assert.equal(e2e.deps.repos.catalog.count(ref.id), 3);
      // Webhooks registrados na loja falsa apontando para este serviço.
      const topics = ref.fake.webhooks.map((w) => w.topic).sort();
      const expectedTopics = store.role === 'vitrine'
        ? ['APP_UNINSTALLED', 'ORDERS_CREATE', 'PRODUCTS_CREATE', 'PRODUCTS_DELETE', 'PRODUCTS_UPDATE']
        : ['APP_UNINSTALLED', 'ORDERS_CANCELLED', 'ORDERS_CREATE', 'ORDERS_UPDATED', 'PRODUCTS_CREATE', 'PRODUCTS_DELETE', 'PRODUCTS_UPDATE', 'REFUNDS_CREATE'];
      assert.deepEqual(topics, expectedTopics);
      assert.ok(ref.fake.webhooks.every((w) => w.uri === 'https://bridge.test/webhooks/shopify'));
    }
    // O token foi pedido por client credentials com as credenciais da própria loja.
    const tokenRequests = e2e.shopify.requestsOf('token', s.vitrine.domain);
    assert.ok(tokenRequests.length >= 1);
    assert.match(tokenRequests[0]?.body ?? '', /grant_type=client_credentials/);
    assert.match(tokenRequests[0]?.body ?? '', /client_id=client-vitrine/);
  });

  it('as rotas criadas pelo painel produzem mapeamentos ativos por SKU nos dois pares', () => {
    for (const [checkout, prefix] of [
      [s.checkoutA, '2'],
      [s.checkoutB, '3'],
    ] as const) {
      const mappings = e2e.deps.repos.mappings.listAll(s.vitrine.id, checkout.id);
      assert.equal(mappings.length, 3);
      for (const mapping of mappings) {
        assert.equal(mapping.status, 'active');
        assert.equal(mapping.method, 'sku');
        assert.deepEqual(mapping.divergences, []);
        assert.equal(mapping.checkoutVariantId, `${prefix}${mapping.vitrineVariantId.slice(1)}`);
      }
    }
    const defaultLink = e2e.deps.repos.links.get(s.defaultLinkId);
    const countryLink = e2e.deps.repos.links.get(s.countryLinkId);
    assert.equal(defaultLink?.kind, 'default');
    assert.equal(defaultLink?.checkoutStoreId, s.checkoutA.id);
    assert.equal(countryLink?.kind, 'country');
    assert.deepEqual(countryLink?.countries, ['BR']);
    assert.equal(countryLink?.checkoutStoreId, s.checkoutB.id);
  });

  it('painel: páginas de loja e rota respondem e o snippet lista os hosts das lojas checkout ligadas', async () => {
    const storePage = await e2e.adminGet(`/admin/stores/${s.vitrine.id}`, s.auth);
    assert.equal(storePage.status, 200);
    const html = await storePage.text();
    assert.ok(html.includes('checkout-a.myshopify.com') && html.includes('checkout-b.myshopify.com'));
    assert.ok(html.includes(`${PROXY_PATH}/bridge.js`));
    const linkPage = await e2e.adminGet(`/admin/links/${s.countryLinkId}`, s.auth);
    assert.equal(linkPage.status, 200);
    const mappingsPage = await e2e.adminGet(`/admin/links/${s.countryLinkId}/mappings`, s.auth);
    assert.equal(mappingsPage.status, 200);
    assert.ok((await mappingsPage.text()).includes('CAM-AZUL-M'));
  });

  it('GET bridge.js pelo App Proxy devolve o script com o caminho assinado e os hosts de preconnect', async () => {
    const res = await e2e.request(`/proxy/bridge.js?${e2e.proxyQuery(s.vitrine)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    const source = await res.text();
    assert.ok(source.includes(`"proxyPath":"${PROXY_PATH}"`));
    assert.ok(source.includes('checkout-a.myshopify.com') && source.includes('checkout-b.myshopify.com'));
  });

  it('checkout de comprador no Brasil vai para a loja da rota BR, só com variante e quantidade', async () => {
    e2e.shopify.clearRequests();
    const { status, json } = await e2e.proxyCheckout(s.vitrine, {
      lines: [
        { variantId: '101', quantity: 2 },
        { variantId: '103', quantity: 1 },
      ],
      country: 'BR',
      cartToken: 'cart-token-br-1',
      source: 'cart',
      attribution: { utm_source: 'insta' },
    });
    assert.equal(status, 200);
    assert.equal(json['ok'], true, JSON.stringify(json));
    const url = new URL(String(json['checkoutUrl']));
    assert.equal(url.hostname, s.checkoutB.domain);
    // A resposta ao navegador leva só o necessário: ok, sessionId e checkoutUrl.
    assert.deepEqual(Object.keys(json).sort(), ['checkoutUrl', 'ok', 'sessionId']);

    const cartRequests = e2e.shopify.requestsOf('storefront');
    assert.equal(cartRequests.length, 1);
    assert.equal(cartRequests[0]?.shop, s.checkoutB.domain);
    const body = cartRequests[0]?.json as Record<string, unknown>;
    const input = (body['variables'] as Record<string, unknown>)['input'] as Record<string, unknown>;
    const lines = input['lines'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      lines.map((l) => [l['merchandiseId'], l['quantity']]),
      [
        ['gid://shopify/ProductVariant/301', 2],
        ['gid://shopify/ProductVariant/303', 1],
      ],
    );
    for (const line of lines) assert.deepEqual(Object.keys(line).sort(), ['attributes', 'merchandiseId', 'quantity']);
    const keys = allKeys(body);
    for (const forbidden of ['price', 'amount', 'cost', 'total', 'subtotal']) assert.ok(!keys.has(forbidden), `corpo do carrinho com "${forbidden}"`);
    assert.equal(input['buyerIdentity'] === undefined ? 'BR' : (input['buyerIdentity'] as Record<string, unknown>)['countryCode'], 'BR');

    const sessions = e2e.deps.repos.sessions.list({ limit: 10, offset: 0 });
    assert.equal(sessions.length, 1);
    const session = sessions[0];
    assert.ok(session !== undefined);
    assert.equal(session.id, json['sessionId']);
    assert.equal(session.status, 'created');
    assert.equal(session.strategy, 'storefront_cart');
    assert.equal(session.checkoutStoreId, s.checkoutB.id);
    assert.equal(session.linkId, s.countryLinkId);
    assert.equal(session.country, 'BR');
    assert.equal(session.subtotal, '300.00');
    assert.deepEqual(
      session.lines.map((l) => [l.vitrineVariantId, l.checkoutVariantId, l.quantity]),
      [
        ['101', '301', 2],
        ['103', '303', 1],
      ],
    );
    assert.ok(session.cartId !== null && !session.cartId.includes('?key='));
  });

  it('comprador de outro país (ou sem país) vai para a rota padrão', async () => {
    for (const country of ['US', undefined]) {
      e2e.shopify.clearRequests();
      const { json } = await e2e.proxyCheckout(s.vitrine, {
        lines: [{ variantId: '102', quantity: 1 }],
        ...(country === undefined ? {} : { country }),
        cartToken: `cart-token-${country ?? 'none'}`,
      });
      assert.equal(json['ok'], true, JSON.stringify(json));
      assert.equal(new URL(String(json['checkoutUrl'])).hostname, s.checkoutA.domain);
      assert.deepEqual(
        e2e.shopify.requestsOf('storefront').map((r) => r.shop),
        [s.checkoutA.domain],
      );
    }
  });

  it('webhook products/update com HMAC válido relê o produto e recalcula as divergências', async () => {
    const variant = s.vitrine.fake.variants.find((v) => v.variantId === '102');
    assert.ok(variant !== undefined);
    variant.price = '35.00';
    const body = JSON.stringify({ id: Number(variant.productId), admin_graphql_api_id: `gid://shopify/Product/${variant.productId}`, title: variant.productTitle });
    const res = await e2e.webhook(s.vitrine, 'products/update', body);
    assert.equal(res.status, 200);
    await e2e.drainQueue();
    assert.equal(e2e.deps.repos.catalog.getVariant(s.vitrine.id, '102')?.price, '35.00');
    const mapping = e2e.deps.repos.mappings.get(s.vitrine.id, s.checkoutA.id, '102');
    assert.equal(mapping?.status, 'active');
    assert.deepEqual(mapping?.divergences, [{ kind: 'price', vitrine: '35.00', checkout: '30.00' }]);
    // Entrega repetida (mesmos ids) é descartada sem nova releitura.
    e2e.shopify.clearRequests();
    const again = await e2e.webhook(s.vitrine, 'products/update', body, { eventId: 'ev-fixo', webhookId: 'wh-fixo' });
    const dup = await e2e.webhook(s.vitrine, 'products/update', body, { eventId: 'ev-fixo', webhookId: 'wh-fixo' });
    assert.equal(again.status, 200);
    assert.equal(dup.status, 200);
    await e2e.drainQueue();
    assert.equal(e2e.shopify.requestsOf('admin', s.vitrine.domain).filter((r) => r.operation === 'BridgeProductVariants').length, 1);
    variant.price = '30.00';
  });

  it('agendador: runSyncOnce ressincroniza as lojas ativas e runPurgeOnce respeita a retenção', async () => {
    e2e.shopify.clearRequests();
    await e2e.deps.scheduler.runSyncOnce();
    const synced = e2e.shopify.requestsOf('admin').filter((r) => r.operation === 'BridgeVariantsPage').map((r) => r.shop);
    assert.deepEqual(new Set(synced), new Set([s.vitrine.domain, s.checkoutA.domain, s.checkoutB.domain]));
    assert.equal(e2e.deps.repos.catalog.getVariant(s.vitrine.id, '102')?.price, '30.00');
    assert.deepEqual(e2e.deps.repos.mappings.get(s.vitrine.id, s.checkoutA.id, '102')?.divergences, []);

    const before = e2e.deps.repos.sessions.list({ limit: 50, offset: 0 }).length;
    assert.ok(before >= 3);
    e2e.deps.scheduler.runPurgeOnce();
    assert.equal(e2e.deps.repos.sessions.list({ limit: 50, offset: 0 }).length, before, 'sessões recentes não podem ser apagadas');
    e2e.clock.advance((e2e.config.retentionDays + 1) * 24 * 60 * 60 * 1000);
    e2e.deps.scheduler.runPurgeOnce();
    assert.equal(e2e.deps.repos.sessions.list({ limit: 50, offset: 0 }).length, 0);
    e2e.clock.set('2026-03-01T12:00:00.000Z');
  });

  it('rotas de operação, raiz e 404', async () => {
    assert.equal((await e2e.request('/healthz')).status, 200);
    assert.equal((await e2e.request('/readyz')).status, 200);
    const metrics = await e2e.request('/metrics');
    assert.equal(metrics.status, 200);
    assert.ok((await metrics.text()).includes('bridge_checkout_requests_total'));
    const root = await e2e.request('/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin');
    const missing = await e2e.request('/nada-aqui');
    assert.equal(missing.status, 404);
    assert.ok(missing.headers.get('x-request-id')?.startsWith('req_'));
  });

  it('log de acesso tem método, caminho, status e latência, mas nunca a query string', () => {
    const access = e2e.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['msg'] === 'http');
    assert.ok(access.length > 10);
    const checkoutLine = access.find((entry) => entry['path'] === '/proxy/checkout');
    assert.ok(checkoutLine !== undefined);
    assert.equal(checkoutLine['method'], 'POST');
    assert.equal(typeof checkoutLine['status'], 'number');
    assert.equal(typeof checkoutLine['ms'], 'number');
    assert.ok(access.every((entry) => !String(entry['path']).includes('?')));
    assert.ok(e2e.logs.every((line) => !line.includes('signature=') && !line.includes('timestamp=')));
  });
});
