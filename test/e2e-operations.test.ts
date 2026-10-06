import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createE2E, setupScenario } from './support/e2e-harness.ts';
import type { E2E, Scenario } from './support/e2e-harness.ts';

/**
 * Operação do dia a dia pela aplicação inteira (createApp + app.request) com a Shopify
 * falsa: rota por permalink, "Testar rota" pelo painel, rota desativada, loja desativada
 * pelo painel e desinstalação do app numa loja checkout. Cada cenário é conferido pelo que
 * se observa de fora: corpo da resposta, repositórios, requisições à Shopify falsa,
 * alertas emitidos e texto das métricas.
 */

let seq = 0;
function token(): string {
  seq += 1;
  return `cart-ops-${seq}`;
}

describe('ponta a ponta: operação', () => {
  let e2e: E2E;
  let s: Scenario;

  async function checkout(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, json } = await e2e.proxyCheckout(s.vitrine, { cartToken: token(), ...body });
    assert.equal(status, 200);
    return json;
  }

  before(async () => {
    e2e = createE2E();
    s = await setupScenario(e2e);
  });
  after(() => e2e.close());

  it('rota por permalink: URL de carrinho no domínio público da loja checkout, sem chamar a Storefront API', async () => {
    e2e.deps.repos.links.update(s.defaultLinkId, { strategy: 'permalink' });
    e2e.deps.repos.stores.update(s.checkoutA.id, { publicDomain: 'loja-a.exemplo.com' });
    e2e.shopify.clearRequests();
    try {
      const json = await checkout({
        lines: [
          { variantId: '101', quantity: 2 },
          { variantId: '103', quantity: 1 },
          { variantId: '101', quantity: 1 },
        ],
        country: 'US',
        discountCodes: ['PROMO10'],
        attribution: { utm_source: 'insta', fbp: 'fb.1.1700000000.123' },
      });
      assert.equal(json['ok'], true, JSON.stringify(json));
      const url = new URL(String(json['checkoutUrl']));
      assert.equal(url.hostname, 'loja-a.exemplo.com');
      // Variante repetida vira um único par, com os ids da loja checkout A.
      assert.equal(url.pathname, '/cart/201:3,203:1');
      assert.equal(url.searchParams.get('discount'), 'PROMO10');
      assert.equal(url.searchParams.get('attributes[bridge_session]'), json['sessionId']);
      assert.equal(url.searchParams.get('attributes[bridge_source]'), s.vitrine.domain);
      assert.equal(url.searchParams.get('attributes[utm_source]'), 'insta');
      assert.equal(url.searchParams.get('utm_source'), 'insta');
      // Identificador de cookie não entra na URL (ela passa por logs e Referer).
      assert.ok(!url.href.includes('fbp'), url.href);
      assert.equal(e2e.shopify.requestsOf('storefront').length, 0);

      const session = e2e.deps.repos.sessions.get(String(json['sessionId']));
      assert.equal(session?.status, 'created');
      assert.equal(session?.strategy, 'permalink');
      assert.equal(session?.checkoutStoreId, s.checkoutA.id);
      assert.equal(session?.linkId, s.defaultLinkId);
      assert.equal(session?.cartId, null);
      assert.equal(session?.subtotal, null);
      assert.deepEqual(
        session?.lines.map((l) => [l.vitrineVariantId, l.checkoutVariantId, l.quantity]),
        [
          ['101', '201', 3],
          ['103', '203', 1],
        ],
      );
      const metrics = await (await e2e.request('/metrics')).text();
      assert.match(metrics, /bridge_checkout_sessions_total\{code="ok",result="created",strategy="permalink"\} 1\b/);
    } finally {
      e2e.deps.repos.links.update(s.defaultLinkId, { strategy: 'storefront_cart' });
      e2e.deps.repos.stores.update(s.checkoutA.id, { publicDomain: null });
    }
  });

  it('"Testar rota" pelo painel: sucesso quando todas as linhas voltam no carrinho de teste', async () => {
    e2e.shopify.clearRequests();
    const res = await e2e.adminPost(`/admin/links/${s.countryLinkId}/test`, {}, s.auth);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/admin/links/${s.countryLinkId}`);
    const cartRequests = e2e.shopify.requestsOf('storefront');
    assert.equal(cartRequests.length, 1);
    assert.equal(cartRequests[0]?.shop, s.checkoutB.domain);
    assert.ok(cartRequests[0]?.body.includes('bridge_test'));

    const page = await e2e.adminGet(`/admin/links/${s.countryLinkId}`, s.auth);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Resultado do teste da rota'), 'página sem o resultado do teste');
    assert.ok(html.includes('Sucesso') && html.includes('Variantes testadas: 3'), html.slice(0, 400));
    assert.ok(html.includes('Nenhum problema encontrado na amostra.'));
    assert.ok(html.includes('contexto do país BR'));
    // Nenhuma sessão de checkout nasce de um teste.
    assert.ok(e2e.deps.repos.sessions.list({ checkoutStoreId: s.checkoutB.id, limit: 10, offset: 0 }).every((x) => x.strategy !== null));
    const audit = e2e.deps.repos.audit.list({ limit: 5, offset: 0, targetType: 'link', targetId: s.countryLinkId });
    const row = audit.find((entry) => entry.action === 'link.test');
    assert.ok(row !== undefined);
    assert.deepEqual(row.detail, { ok: true, tested: 3, problems: 0 });
  });

  it('"Testar rota" lista a variante não publicada (some do carrinho) e a sem estoque', async () => {
    const { storefront } = s.checkoutB.fake;
    storefront.vanished.add('302');
    storefront.outOfStock.add('303');
    try {
      const res = await e2e.adminPost(`/admin/links/${s.countryLinkId}/test`, {}, s.auth);
      assert.equal(res.status, 303);
    } finally {
      storefront.vanished.clear();
      storefront.outOfStock.clear();
    }
    const html = await (await e2e.adminGet(`/admin/links/${s.countryLinkId}`, s.auth)).text();
    assert.ok(html.includes('Falhou'));
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '').filter((li) => li.includes('mono'));
    const about = (vitrineId: string): string => items.find((li) => li.includes(`>${vitrineId}<`)) ?? '';
    assert.match(about('102'), />302</);
    assert.match(about('102'), /Não entrou no carrinho de teste/);
    assert.match(about('103'), />303</);
    assert.match(about('103'), /Sem estoque na loja checkout\./);
    assert.ok(!html.includes('>101<') || !about('101').includes('Sem estoque'), 'a variante sadia não pode aparecer como problema');
    const audit = e2e.deps.repos.audit.list({ limit: 1, offset: 0, targetType: 'link', targetId: s.countryLinkId });
    assert.deepEqual(audit[0]?.detail, { ok: false, tested: 3, problems: 2 });
  });

  it('rota desativada: comprador recebe no_route, alerta é emitido e as outras rotas seguem', async () => {
    const disable = await e2e.adminPost(`/admin/links/${s.defaultLinkId}/disable`, {}, s.auth);
    assert.equal(disable.status, 303);
    assert.equal(e2e.deps.repos.links.get(s.defaultLinkId)?.enabled, false);
    e2e.shopify.clearRequests();
    try {
      const refused = await checkout({ lines: [{ variantId: '101', quantity: 1 }], country: 'US' });
      assert.equal(refused['ok'], false);
      assert.equal(refused['code'], 'no_route');
      assert.equal(typeof refused['message'], 'string');
      assert.equal(e2e.shopify.requestsOf('storefront').length, 0, 'nenhuma loja pode ser procurada sem rota');
      const alert = e2e.alerts().find((a) => a.key === `no_route:${s.vitrine.id}`);
      assert.ok(alert !== undefined, 'alerta de rota ausente não foi emitido');
      assert.equal(alert.severity, 'critical');
      // A rota BR continua valendo: desativar a padrão não desvia ninguém.
      const brazil = await checkout({ lines: [{ variantId: '101', quantity: 1 }], country: 'BR' });
      assert.equal(brazil['ok'], true, JSON.stringify(brazil));
      assert.equal(new URL(String(brazil['checkoutUrl'])).hostname, s.checkoutB.domain);
      const metrics = await (await e2e.request('/metrics')).text();
      assert.match(metrics, /bridge_checkout_requests_total\{code="no_route",result="error"\} 1\b/);
    } finally {
      assert.equal((await e2e.adminPost(`/admin/links/${s.defaultLinkId}/enable`, {}, s.auth)).status, 303);
    }
    const again = await checkout({ lines: [{ variantId: '101', quantity: 1 }], country: 'US' });
    assert.equal(again['ok'], true, JSON.stringify(again));
    assert.equal(new URL(String(again['checkoutUrl'])).hostname, s.checkoutA.domain);
  });

  // Fica por último: deixa a loja checkout A em erro e depois desativada.
  it('app/uninstalled na loja checkout: loja em erro, token invalidado, auditoria e alerta; a rota nunca desvia', async () => {
    const tokensBefore = s.checkoutA.fake.issuedTokens.size;
    const body = JSON.stringify({
      id: 55555,
      admin_graphql_api_id: 'gid://shopify/Shop/55555',
      myshopify_domain: s.checkoutA.domain,
      name: 'Loja checkoutA',
    });
    // HMAC inválido: nada muda na loja.
    assert.equal((await e2e.webhook(s.checkoutA, 'app/uninstalled', body, { hmac: 'AAAA' })).status, 401);
    assert.equal(e2e.deps.repos.stores.get(s.checkoutA.id)?.status, 'connected');

    const res = await e2e.webhook(s.checkoutA, 'app/uninstalled', body);
    assert.equal(res.status, 200);
    const store = e2e.deps.repos.stores.get(s.checkoutA.id);
    assert.equal(store?.status, 'error');
    assert.equal(store?.statusDetail, 'App desinstalado na loja');
    const audit = e2e.deps.repos.audit.list({ limit: 10, offset: 0, targetType: 'store', targetId: s.checkoutA.id });
    const row = audit.find((entry) => entry.action === 'store.app_uninstalled');
    assert.ok(row !== undefined, 'sem linha de auditoria da desinstalação');
    assert.equal(row.actor, 'webhook');
    assert.deepEqual(row.detail, { shopDomain: s.checkoutA.domain, role: 'checkout', previousStatus: 'connected' });
    const alert = e2e.alerts().find((a) => a.key === `app_uninstalled:${s.checkoutA.id}`);
    assert.equal(alert?.severity, 'critical');

    // Cache de token invalidado: a próxima chamada à Admin API emite um token novo, e a
    // chamada vai com esse token (não com o antigo, ainda aceito pela loja falsa).
    e2e.shopify.clearRequests();
    await e2e.deps.sync.syncStore(s.checkoutA.id);
    assert.equal(e2e.shopify.requestsOf('token', s.checkoutA.domain).length, 1);
    assert.equal(s.checkoutA.fake.issuedTokens.size, tokensBefore + 1);
    const newest = [...s.checkoutA.fake.issuedTokens].at(-1);
    const adminCalls = e2e.shopify.requestsOf('admin', s.checkoutA.domain);
    assert.ok(adminCalls.length >= 1);
    assert.ok(adminCalls.every((r) => r.headers['x-shopify-access-token'] === newest));

    // Loja em erro NÃO desvia o comprador: a rota padrão continua apontando para A, e só
    // para A. (O status 'error' sozinho não bloqueia o checkout; ver service.ts, passo 2.)
    e2e.shopify.clearRequests();
    const afterUninstall = await checkout({ lines: [{ variantId: '102', quantity: 1 }], country: 'US' });
    assert.ok(e2e.shopify.requestsOf('storefront').every((r) => r.shop === s.checkoutA.domain));
    assert.equal(e2e.shopify.requestsOf('storefront', s.checkoutB.domain).length, 0);
    if (afterUninstall['ok'] === true) assert.equal(new URL(String(afterUninstall['checkoutUrl'])).hostname, s.checkoutA.domain);

    // Desativada pelo painel: checkout recusado com store_disabled, sem tocar na Shopify.
    assert.equal((await e2e.adminPost(`/admin/stores/${s.checkoutA.id}/disable`, {}, s.auth)).status, 303);
    assert.equal(e2e.deps.repos.stores.get(s.checkoutA.id)?.status, 'disabled');
    e2e.shopify.clearRequests();
    const refused = await checkout({ lines: [{ variantId: '102', quantity: 1 }], country: 'US' });
    assert.equal(refused['ok'], false);
    assert.equal(refused['code'], 'store_disabled');
    assert.equal(e2e.shopify.requestsOf('storefront').length, 0);
    assert.ok(e2e.deps.repos.sessions.list({ limit: 100, offset: 0 }).every((x) => x.checkoutStoreId !== s.checkoutB.id || x.linkId === s.countryLinkId));
    const test = await e2e.deps.checkout.testLink(s.defaultLinkId);
    assert.equal(test.ok, false);
    assert.equal(test.detail, 'Loja checkout da rota está desativada.');
    // Uma nova entrega do mesmo webhook numa loja desativada mantém a decisão manual.
    assert.equal((await e2e.webhook(s.checkoutA, 'app/uninstalled', body)).status, 200);
    assert.equal(e2e.deps.repos.stores.get(s.checkoutA.id)?.status, 'disabled');
    const metrics = await (await e2e.request('/metrics')).text();
    assert.match(metrics, /bridge_webhooks_total\{result="ok",topic="app\/uninstalled"\} 2\b/);
    assert.match(metrics, /bridge_webhooks_total\{result="unauthorized",topic="app\/uninstalled"\} 1\b/);
    assert.match(metrics, /bridge_checkout_requests_total\{code="store_disabled",result="error"\} 1\b/);
  });
});
