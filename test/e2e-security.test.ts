import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createE2E, PROXY_PATH, setupScenario } from './support/e2e-harness.ts';
import type { E2E, Scenario, ShopRef } from './support/e2e-harness.ts';

/**
 * Garantias de segurança pela aplicação inteira: nada do navegador decide preço ou loja,
 * assinatura e HMAC são conferidos, idempotência, limites, paridade de preço, estoque,
 * queda da Storefront API e ausência de vazamento de segredos em respostas e logs.
 */

let seq = 0;
function token(): string {
  seq += 1;
  return `cart-token-${seq}`;
}

describe('ponta a ponta: segurança', () => {
  let e2e: E2E;
  let s: Scenario;
  /** Assinaturas de App Proxy usadas nos testes, para a conferência de vazamento no fim. */
  const signatures: string[] = [];

  function signed(overrides?: Record<string, string | string[]>): string {
    const query = e2e.proxyQuery(s.vitrine, overrides);
    const signature = new URLSearchParams(query).get('signature');
    if (signature !== null) signatures.push(signature);
    return query;
  }

  async function checkout(body: unknown, opts: { query?: string; rawBody?: string } = {}): Promise<Record<string, unknown>> {
    const { status, json } = await e2e.proxyCheckout(s.vitrine, body, { query: opts.query ?? signed(), rawBody: opts.rawBody });
    // O App Proxy exige 200 sempre; o resultado viaja no corpo.
    assert.equal(status, 200);
    return json;
  }

  function cartRequestsTo(domain: string): number {
    return e2e.shopify.requestsOf('storefront', domain).length;
  }

  before(async () => {
    e2e = createE2E();
    s = await setupScenario(e2e);
  });
  after(() => e2e.close());

  it('corpo com preço é recusado antes de qualquer chamada à Shopify', async () => {
    e2e.shopify.clearRequests();
    const withLinePrice = await checkout({ lines: [{ variantId: '101', quantity: 1, price: '1.00' }], cartToken: token() });
    assert.equal(withLinePrice['ok'], false);
    assert.equal(withLinePrice['code'], 'invalid_request');
    const withTopPrice = await checkout({ lines: [{ variantId: '101', quantity: 1 }], price: '1.00', cartToken: token() });
    assert.equal(withTopPrice['code'], 'invalid_request');
    const notJson = await checkout(null, { rawBody: '{"lines": [' });
    assert.equal(notJson['code'], 'invalid_request');
    assert.equal(e2e.shopify.requestsOf('storefront').length, 0);
    // A mensagem é a pública, sem detalhes internos nem valores do corpo.
    assert.ok(!JSON.stringify(withLinePrice).includes('1.00'));
  });

  it('variante desconhecida ou de outra loja é recusada', async () => {
    e2e.shopify.clearRequests();
    const unknown = await checkout({ lines: [{ variantId: '999999', quantity: 1 }], cartToken: token() });
    assert.equal(unknown['ok'], false);
    assert.equal(unknown['code'], 'unmapped_variant');
    // Id de variante da loja checkout A enviado como se fosse da vitrine.
    const foreign = await checkout({ lines: [{ variantId: '201', quantity: 1 }], cartToken: token() });
    assert.equal(foreign['code'], 'unmapped_variant');
    const mixed = await checkout({ lines: [{ variantId: '101', quantity: 1 }, { variantId: '201', quantity: 1 }], cartToken: token() });
    assert.equal(mixed['code'], 'unmapped_variant');
    assert.equal(e2e.shopify.requestsOf('storefront').length, 0);
  });

  it('assinatura adulterada, ausente ou antiga é recusada', async () => {
    e2e.shopify.clearRequests();
    const body = { lines: [{ variantId: '101', quantity: 1 }], cartToken: token() };
    const good = signed();
    const params = new URLSearchParams(good);
    params.set('signature', 'f'.repeat(64));
    const tampered = await checkout(body, { query: params.toString() });
    assert.equal(tampered['code'], 'unauthorized');

    const shopSwapped = new URLSearchParams(good);
    shopSwapped.set('shop', s.checkoutA.domain);
    assert.equal((await checkout(body, { query: shopSwapped.toString() }))['code'], 'unauthorized');

    const stale = signed({ timestamp: String(Math.floor(e2e.clock.now().getTime() / 1000) - 1000) });
    assert.equal((await checkout(body, { query: stale }))['code'], 'unauthorized');

    const unsigned = new URLSearchParams(good);
    unsigned.delete('signature');
    assert.equal((await checkout(body, { query: unsigned.toString() }))['code'], 'unauthorized');
    assert.equal(e2e.shopify.requestsOf('storefront').length, 0);
  });

  it('repetição da mesma requisição devolve a mesma URL sem criar um segundo carrinho', async () => {
    e2e.shopify.clearRequests();
    const body = { lines: [{ variantId: '101', quantity: 1 }], country: 'BR', cartToken: token() };
    const first = await checkout(body);
    const second = await checkout(body);
    assert.equal(first['ok'], true, JSON.stringify(first));
    assert.equal(second['ok'], true);
    assert.equal(second['checkoutUrl'], first['checkoutUrl']);
    assert.equal(second['sessionId'], first['sessionId']);
    assert.equal(cartRequestsTo(s.checkoutB.domain), 1);
    assert.equal(s.checkoutB.fake.storefront.cartsCreated, 1);
  });

  it('quantidade acima do limite da rota é recusada', async () => {
    e2e.shopify.clearRequests();
    const over = await checkout({ lines: [{ variantId: '101', quantity: 11 }], cartToken: token() });
    assert.equal(over['code'], 'quantity_exceeded');
    // Dividir em duas linhas iguais não contorna o limite.
    const split = await checkout({ lines: [{ variantId: '101', quantity: 6 }, { variantId: '101', quantity: 6 }], cartToken: token() });
    assert.equal(split['code'], 'quantity_exceeded');
    assert.equal(e2e.shopify.requestsOf('storefront').length, 0);
  });

  it('preço alterado na loja checkout: bloqueado com parityPolicy block, permitido com warn', async () => {
    s.checkoutB.fake.storefront.livePrice.set('301', '55.00');
    try {
      const blocked = await checkout({ lines: [{ variantId: '101', quantity: 1 }], country: 'BR', cartToken: token() });
      assert.equal(blocked['ok'], false);
      assert.equal(blocked['code'], 'price_divergence');
      assert.ok(!JSON.stringify(blocked).includes('55.00'));

      e2e.deps.repos.links.update(s.countryLinkId, { parityPolicy: 'warn' });
      const allowed = await checkout({ lines: [{ variantId: '101', quantity: 1 }], country: 'BR', cartToken: token() });
      assert.equal(allowed['ok'], true, JSON.stringify(allowed));
      assert.equal(new URL(String(allowed['checkoutUrl'])).hostname, s.checkoutB.domain);
    } finally {
      s.checkoutB.fake.storefront.livePrice.clear();
      e2e.deps.repos.links.update(s.countryLinkId, { parityPolicy: 'block' });
    }
  });

  it('linha sem estoque ou que some do carrinho é recusada', async () => {
    const { storefront } = s.checkoutB.fake;
    storefront.outOfStock.add('302');
    try {
      const out = await checkout({ lines: [{ variantId: '102', quantity: 1 }], country: 'BR', cartToken: token() });
      assert.equal(out['code'], 'variant_unavailable');
    } finally {
      storefront.outOfStock.clear();
    }
    storefront.vanished.add('302');
    try {
      const gone = await checkout({ lines: [{ variantId: '101', quantity: 1 }, { variantId: '102', quantity: 2 }], country: 'BR', cartToken: token() });
      assert.equal(gone['code'], 'variant_unavailable');
    } finally {
      storefront.vanished.clear();
    }
    const failed = e2e.deps.repos.sessions.list({ status: 'failed', limit: 50, offset: 0 });
    assert.ok(failed.some((session) => session.errorCode === 'variant_unavailable'));
  });

  it('queda da Storefront API: permalink na MESMA loja quando permitido, falha quando não', async () => {
    e2e.shopify.clearRequests();
    s.checkoutB.fake.storefront.mode = 'outage';
    try {
      const refused = await checkout({ lines: [{ variantId: '101', quantity: 2 }], country: 'BR', cartToken: token() });
      assert.equal(refused['ok'], false);
      assert.equal(refused['code'], 'upstream_unavailable');

      e2e.deps.repos.links.update(s.countryLinkId, { allowPermalinkFallback: true });
      const fallback = await checkout({ lines: [{ variantId: '101', quantity: 2 }], country: 'BR', cartToken: token() });
      assert.equal(fallback['ok'], true, JSON.stringify(fallback));
      const url = new URL(String(fallback['checkoutUrl']));
      assert.equal(url.hostname, s.checkoutB.domain);
      assert.match(url.pathname, /^\/cart\/301:2/);
      const session = e2e.deps.repos.sessions.get(String(fallback['sessionId']));
      assert.equal(session?.strategy, 'permalink');
      assert.equal(session?.checkoutStoreId, s.checkoutB.id);
    } finally {
      s.checkoutB.fake.storefront.mode = 'ok';
      e2e.deps.repos.links.update(s.countryLinkId, { allowPermalinkFallback: false });
    }
    // A loja A nunca foi procurada: a queda de B não desvia o comprador.
    assert.equal(cartRequestsTo(s.checkoutA.domain), 0);
  });

  it('Storefront API com THROTTLED, HTTP 430, 5xx ou falha de rede: upstream_unavailable, sessão failed, sem fallback nem desvio', async () => {
    const { storefront } = s.checkoutB.fake;
    // [modo, quantas chamadas saem: 430 não repete, THROTTLED repete uma vez, rede e 5xx repetem duas]
    const cases: Array<[typeof storefront.mode, number]> = [
      ['throttled', 2],
      ['security_rejected', 1],
      ['outage', 3],
      ['network_error', 3],
    ];
    for (const [mode, calls] of cases) {
      e2e.shopify.clearRequests();
      storefront.mode = mode;
      let refused: Record<string, unknown>;
      try {
        refused = await checkout({ lines: [{ variantId: '103', quantity: 1 }], country: 'BR', cartToken: token() });
      } finally {
        storefront.mode = 'ok';
      }
      assert.equal(refused['ok'], false, `${mode}: ${JSON.stringify(refused)}`);
      assert.equal(refused['code'], 'upstream_unavailable', mode);
      assert.equal(cartRequestsTo(s.checkoutB.domain), calls, `${mode}: chamadas à Storefront API`);
      assert.equal(cartRequestsTo(s.checkoutA.domain), 0, `${mode}: a loja A nunca é procurada`);
      const failed = e2e.deps.repos.sessions.list({ status: 'failed', checkoutStoreId: s.checkoutB.id, limit: 1, offset: 0 });
      assert.equal(failed[0]?.errorCode, 'upstream_unavailable', mode);
      assert.equal(failed[0]?.checkoutUrl, null, mode);
      // A loja volta: o próximo checkout passa (e o circuito nunca chegou a abrir).
      const recovered = await checkout({ lines: [{ variantId: '103', quantity: 1 }], country: 'BR', cartToken: token() });
      assert.equal(recovered['ok'], true, `${mode}: ${JSON.stringify(recovered)}`);
    }
    const alert = e2e.alerts().find((a) => a.key === `storefront_430:${s.checkoutB.id}`);
    assert.ok(alert !== undefined, 'HTTP 430 precisa alertar o lojista');
    assert.ok(!e2e.alerts().some((a) => a.key.startsWith('storefront_circuit:')), 'circuito não pode abrir com falhas isoladas');
    const metrics = await (await e2e.request('/metrics')).text();
    assert.match(metrics, /bridge_storefront_requests_total\{result="throttled"\} 2\b/);
    assert.match(metrics, /bridge_checkout_sessions_total\{code="upstream_unavailable",result="failed",strategy="storefront_cart"\} \d+/);
  });

  it('nenhuma sessão vai para loja diferente da que a rota correspondente nomeia', async () => {
    for (const [country, expected] of [
      ['BR', s.checkoutB],
      ['PT', s.checkoutA],
      ['US', s.checkoutA],
      [undefined, s.checkoutA],
    ] as const) {
      e2e.shopify.clearRequests();
      const json = await checkout({ lines: [{ variantId: '103', quantity: 1 }], ...(country === undefined ? {} : { country }), cartToken: token() });
      assert.equal(json['ok'], true, JSON.stringify(json));
      assert.equal(new URL(String(json['checkoutUrl'])).hostname, expected.domain);
      assert.deepEqual(e2e.shopify.requestsOf('storefront').map((r) => r.shop), [expected.domain]);
    }
    for (const session of e2e.deps.repos.sessions.list({ limit: 500, offset: 0 })) {
      const link = e2e.deps.repos.links.get(session.linkId);
      assert.ok(link !== null);
      assert.equal(session.checkoutStoreId, link.checkoutStoreId);
      assert.equal(session.vitrineStoreId, s.vitrine.id);
      if (session.checkoutUrl !== null) assert.equal(new URL(session.checkoutUrl).hostname, link.checkoutStoreId === s.checkoutA.id ? s.checkoutA.domain : s.checkoutB.domain);
    }
  });

  it('webhook com HMAC errado ou ausente é recusado; com HMAC certo é aceito', async () => {
    const body = JSON.stringify({ id: 10101, admin_graphql_api_id: 'gid://shopify/Product/10101' });
    assert.equal((await e2e.webhook(s.vitrine, 'products/update', body, { hmac: 'AAAA' })).status, 401);
    assert.equal((await e2e.webhook(s.vitrine, 'products/update', body, { hmac: null })).status, 401);
    // Assinado com o segredo de OUTRA loja.
    const other = { ...s.vitrine, secret: s.checkoutA.secret };
    assert.equal((await e2e.webhook(other, 'products/update', body)).status, 401);
    assert.equal((await e2e.webhook(s.vitrine, 'products/update', body)).status, 200);
    await e2e.drainQueue();
  });

  it('POST no painel sem CSRF é recusado, mesmo com sessão válida', async () => {
    const res = await e2e.request('/admin/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.auth.cookie },
      body: new URLSearchParams({ role: 'checkout', name: 'X', shopDomain: 'x.myshopify.com', clientId: 'c', clientSecret: 's' }).toString(),
    });
    assert.equal(res.status, 403);
    assert.equal(e2e.deps.repos.stores.list().length, 3);
    const noSession = await e2e.adminPost('/admin/stores', { role: 'checkout', name: 'X' }, null);
    assert.ok(noSession.status === 303 || noSession.status === 401 || noSession.status === 403);
    assert.equal(e2e.deps.repos.stores.list().length, 3);
  });

  it('nenhuma resposta nem linha de log contém client secret, token de acesso ou assinatura', async () => {
    // Páginas do painel que mostram as lojas também entram na amostra.
    for (const ref of [s.vitrine, s.checkoutA, s.checkoutB]) await e2e.adminGet(`/admin/stores/${ref.id}`, s.auth);
    await e2e.adminGet('/admin/audit', s.auth);
    await e2e.adminGet('/admin/sessions', s.auth);
    const issuedTokens = [s.vitrine, s.checkoutA, s.checkoutB].flatMap((ref) => [...ref.fake.issuedTokens]);
    const secrets = [s.vitrine.secret, s.checkoutA.secret, s.checkoutB.secret, ...issuedTokens, ...signatures];
    assert.ok(issuedTokens.length >= 3 && signatures.length >= 5);
    const haystacks = [...e2e.responses, ...e2e.logs];
    assert.ok(haystacks.length > 50);
    for (const text of haystacks) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `vazamento de "${secret.slice(0, 12)}..." em: ${text.slice(0, 200)}`);
      assert.ok(!text.includes('shpss_') && !text.includes('shpat_fake_'), `prefixo de segredo em: ${text.slice(0, 200)}`);
    }
  });
});

describe('ponta a ponta: /metrics com METRICS_TOKEN', () => {
  const METRICS_TOKEN = 'token-de-metricas-nao-vaza';
  let e2e: E2E;

  before(() => {
    e2e = createE2E({ metricsToken: METRICS_TOKEN });
  });
  after(() => e2e.close());

  it('sem o bearer responde 401 (e não expõe nada); com o bearer certo responde 200 em texto Prometheus', async () => {
    const missing = await e2e.request('/metrics');
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
    assert.ok(!(await missing.text()).includes('bridge_'));
    const wrong = await e2e.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}x` } });
    assert.equal(wrong.status, 401);
    const basic = await e2e.request('/metrics', { headers: { authorization: `Basic ${METRICS_TOKEN}` } });
    assert.equal(basic.status, 401);
    const ok = await e2e.request('/metrics', { headers: { authorization: `bearer ${METRICS_TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
    // Série que existe desde o início (as de checkout só nascem com o primeiro checkout).
    assert.match(await ok.text(), /^# TYPE bridge_metrics_dropped_series_total counter$/m);
    // As rotas de vida continuam abertas, e o token não aparece em log nem resposta.
    assert.equal((await e2e.request('/healthz')).status, 200);
    assert.ok([...e2e.logs, ...e2e.responses].every((text) => !text.includes(METRICS_TOKEN)));
  });
});

describe('ponta a ponta: IP do comprador com TRUSTED_PROXY_HOPS', () => {
  /** Item que a Shopify acrescenta ao fim de X-Forwarded-For (o último item, escrito pelo proxy reverso). */
  const SHOPIFY = '192.0.2.1';
  const BUYER = '203.0.113.9';
  let e2e: E2E;
  let shop: ShopRef;

  async function ping(forwardedFor: string | null): Promise<string> {
    const res = await e2e.request(`/proxy/ping?${e2e.proxyQuery(shop)}`, {
      headers: forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    return json['ok'] === true ? 'ok' : String(json['code']);
  }

  before(() => {
    // Um proxy reverso confiável (hops = 1) e, pelo App Proxy, mais um salto da Shopify:
    // o comprador é o segundo item a contar da direita. Limite baixo para testar.
    e2e = createE2E({ trustedProxyHops: 1, rateLimitPerIpPerMinute: 2 });
    const domain = 'vitrine-ip.myshopify.com';
    const secret = 'shpss_vitrine_ip_segredo';
    const fake = e2e.shopify.addShop({ domain, clientId: 'client-ip', clientSecret: secret });
    const store = e2e.deps.repos.stores.create({
      role: 'vitrine',
      name: 'Vitrine IP',
      shopDomain: domain,
      clientId: 'client-ip',
      clientSecret: secret,
      proxyPath: PROXY_PATH,
    });
    shop = { id: store.id, domain, secret, fake };
  });
  after(() => e2e.close());

  it('o limite por IP usa o item que a Shopify viu; um item forjado à esquerda não contorna o limite', async () => {
    assert.equal(await ping(`${BUYER}, ${SHOPIFY}`), 'ok');
    assert.equal(await ping(`${BUYER}, ${SHOPIFY}`), 'ok');
    assert.equal(await ping(`${BUYER}, ${SHOPIFY}`), 'rate_limited');
    // O navegador escreve o que quiser à esquerda; o comprador continua sendo BUYER.
    assert.equal(await ping(`198.51.100.77, ${BUYER}, ${SHOPIFY}`), 'rate_limited');
    assert.equal(await ping(`10.0.0.1, 198.51.100.78, ${BUYER}, ${SHOPIFY}`), 'rate_limited');
    // Mesmo endereço em forma IPv6 mapeada ou com porta: mesma chave.
    assert.equal(await ping(`::ffff:${BUYER}, ${SHOPIFY}`), 'rate_limited');
    assert.equal(await ping(`${BUYER}:51234, ${SHOPIFY}`), 'rate_limited');
    // Outro comprador de verdade (outro item na posição da Shopify) tem cota própria.
    assert.equal(await ping(`203.0.113.10, ${SHOPIFY}`), 'ok');
    // Com o relógio adiante uma ficha volta: 1 ficha a cada 30 s com limite 2/min.
    e2e.clock.advance(30_000);
    assert.equal(await ping(`${BUYER}, ${SHOPIFY}`), 'ok');
    assert.equal(await ping(`${BUYER}, ${SHOPIFY}`), 'rate_limited');
    const metrics = await (await e2e.request('/metrics')).text();
    assert.match(metrics, /bridge_proxy_rate_limited_total\{scope="ip"\} 6\b/);
    assert.ok(!metrics.includes('scope="shop"'));
    // IP não vai para o log de acesso nem para o do proxy.
    assert.ok(e2e.logs.every((line) => !line.includes(BUYER) && !line.includes('203.0.113.10')));
  });

  it('cabeçalho mais curto que o esperado não produz IP; a cota por loja continua valendo', async () => {
    // Só o item da Shopify (nenhum proxy reverso escreveu o do comprador): sem IP, sem
    // limite por IP; o limite por loja (600/min em testConfig) é o que protege a loja.
    for (let i = 0; i < 5; i += 1) assert.equal(await ping(SHOPIFY), 'ok');
    assert.equal(await ping(null), 'ok');
    assert.ok(e2e.logs.every((line) => !line.includes(SHOPIFY)));
  });
});
