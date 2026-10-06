import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { createLogger } from '../src/lib/logger.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import { createProxyRoutes } from '../src/routes/proxy.ts';
import type { ProxyEnv, ProxyRouteDeps } from '../src/routes/proxy.ts';
import { signAppProxyQuery } from '../src/shopify/proxy-signature.ts';
import { BridgeError } from '../src/types.ts';
import type { CheckoutRequest, CheckoutResponse, CheckoutService, RequestContext, Store } from '../src/types.ts';
import { T0, makeStore, setup } from './db-helpers.ts';

const SECRET = 'shpss_segredo_da_vitrine';
const PROXY_PATH = '/apps/checkout-bridge';
const T0_SECONDS = Date.parse(T0) / 1000;
const BUYER_IP = '203.0.113.9';
const CHECKOUT_URL = 'https://loja-checkout.example/cart/c/abc?key=chave-secreta-do-carrinho';
const UNAUTHORIZED_MESSAGE = new BridgeError('unauthorized').publicMessage;

interface Harness {
  app: Hono<ProxyEnv>;
  store: Store;
  clock: ReturnType<typeof setup>['clock'];
  repos: ReturnType<typeof setup>['repos'];
  calls: Array<{ request: CheckoutRequest; ctx: RequestContext }>;
  logs: string[];
  metrics: ReturnType<typeof createMetrics>;
  /** Query assinada para a vitrine do teste; `overrides` troca ou acrescenta parâmetros. */
  sign(overrides?: Record<string, string | string[]>, secret?: string): string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

function harness(opts: {
  createCheckout?: CheckoutService['createCheckout'];
  parseBody?: ProxyRouteDeps['parseBody'];
  renderScript?: ProxyRouteDeps['renderScript'];
  ipCapacity?: number;
  shopCapacity?: number;
  /** Proxies confiáveis à frente do serviço; 0 = o item da Shopify é o último de X-Forwarded-For. */
  trustedProxyHops?: number;
} = {}): Harness {
  const { repos, clock } = setup();
  const store = makeStore(repos, 'vitrine', { clientSecret: SECRET, proxyPath: PROXY_PATH });
  const calls: Harness['calls'] = [];
  const logs: string[] = [];
  const metrics = createMetrics();
  const defaultCreate: CheckoutService['createCheckout'] = async () => ({
    sessionId: 'cs_teste_1',
    checkoutUrl: CHECKOUT_URL,
    strategy: 'storefront_cart',
    reused: false,
  });
  const checkout: CheckoutService = {
    async createCheckout(request, ctx): Promise<CheckoutResponse> {
      calls.push({ request, ctx });
      return (opts.createCheckout ?? defaultCreate)(request, ctx);
    },
    async testLink() {
      throw new Error('não usado nestes testes');
    },
  };
  // Validador mínimo: os testes da rota não dependem do esquema real (outro módulo).
  const parseBody: ProxyRouteDeps['parseBody'] = (body) => {
    if (typeof body !== 'object' || body === null || !('lines' in body) || !Array.isArray(body.lines)) {
      return { ok: false, message: 'mensagem interna do validador' };
    }
    return { ok: true, value: body as Omit<CheckoutRequest, 'shopDomain'> };
  };
  const app = createProxyRoutes({
    repos,
    checkout,
    parseBody: opts.parseBody ?? parseBody,
    renderScript: opts.renderScript ?? ((s, pathPrefix) => `/* script ${s.id} ${pathPrefix} */`),
    config: { proxySignatureMaxAgeSeconds: 90, trustedProxyHops: opts.trustedProxyHops ?? 0 },
    ipLimiter: createRateLimiter({ capacity: opts.ipCapacity ?? 100, refillPerSecond: 1, clock }),
    shopLimiter: createRateLimiter({ capacity: opts.shopCapacity ?? 100, refillPerSecond: 1, clock }),
    logger: createLogger({ level: 'debug', env: 'test', destination: { write: (line: string) => void logs.push(line) } }),
    metrics,
    clock,
  });
  const sign: Harness['sign'] = (overrides = {}, secret = SECRET) =>
    signAppProxyQuery(
      { shop: store.shopDomain, logged_in_customer_id: '', path_prefix: PROXY_PATH, timestamp: String(T0_SECONDS), ...overrides },
      secret,
    );
  const post: Harness['post'] = async (path, body, headers = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': BUYER_IP, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, store, clock, repos, calls, logs, metrics, sign, post };
}

const VALID_BODY = { lines: [{ variantId: '44001', quantity: 2 }], cartToken: 'tok-1', country: 'BR' };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('location'), null);
  for (const name of res.headers.keys()) assert.ok(!name.startsWith('access-control-'), `cabeçalho CORS: ${name}`);
  return (await res.json()) as Record<string, unknown>;
}

async function expectFailure(res: Response, code: string): Promise<void> {
  const body = await readJson(res);
  assert.deepEqual(body, { ok: false, code, message: new BridgeError(code as BridgeError['code']).publicMessage });
}

describe('POST /checkout', () => {
  it('sucesso: devolve checkoutUrl e sessionId, loja vem da assinatura', async () => {
    const h = harness();
    const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'user-agent': 'Mozilla/5.0 teste' });
    assert.deepEqual(await readJson(res), { ok: true, checkoutUrl: CHECKOUT_URL, sessionId: 'cs_teste_1' });
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.ok(call);
    assert.deepEqual(call.request, { ...VALID_BODY, shopDomain: h.store.shopDomain });
    assert.equal(call.ctx.buyerIp, BUYER_IP);
    assert.equal(call.ctx.userAgent, 'Mozilla/5.0 teste');
    assert.match(call.ctx.requestId, /^req_[0-9a-f]{16}$/);
    assert.equal(res.headers.get('x-request-id'), call.ctx.requestId);
    assert.match(h.metrics.render(), /bridge_checkout_requests_total\{[^}]*code="ok"[^}]*\} 1/);
    assert.match(h.metrics.render(), /bridge_checkout_request_ms_count\{[^}]*result="ok"[^}]*\} 1/);
  });

  it('campo shopDomain no corpo é ignorado', async () => {
    const h = harness();
    const other = makeStore(h.repos, 'vitrine', { clientSecret: 'outro-segredo', proxyPath: PROXY_PATH });
    const res = await h.post(`/checkout?${h.sign()}`, { ...VALID_BODY, shopDomain: other.shopDomain, shop: other.shopDomain });
    assert.equal((await readJson(res)).ok, true);
    assert.equal(h.calls[0]?.request.shopDomain, h.store.shopDomain);
  });

  it('sem IP conhecido e sem User-Agent o contexto leva null', async () => {
    const h = harness();
    const res = await h.app.request(`/checkout?${h.sign()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal((await readJson(res)).ok, true);
    assert.equal(h.calls[0]?.ctx.buyerIp, null);
    assert.equal(h.calls[0]?.ctx.userAgent, null);
  });

  it('falhas de autenticação respondem 200 unauthorized sem revelar o motivo', async () => {
    const h = harness();
    const checkoutStore = makeStore(h.repos, 'checkout', { clientSecret: SECRET });
    const disabled = makeStore(h.repos, 'vitrine', { clientSecret: SECRET, proxyPath: PROXY_PATH });
    h.repos.stores.update(disabled.id, { status: 'disabled' });
    const valid = h.sign();
    const cases: Array<[string, string]> = [
      ['', 'missing_param'],
      [valid.replace(/signature=[0-9a-f]{8}/, 'signature=00000000'), 'bad_signature'],
      [valid.replace(/&signature=[0-9a-f]+/, ''), 'missing_param'],
      [h.sign({}, 'segredo-errado'), 'bad_signature'],
      [h.sign({ timestamp: String(T0_SECONDS - 91) }), 'stale'],
      [h.sign({ timestamp: String(T0_SECONDS + 91) }), 'stale'],
      [h.sign({ shop: 'loja-desconhecida.myshopify.com' }), 'unknown_store'],
      [h.sign({ shop: checkoutStore.shopDomain }), 'wrong_role'],
      [h.sign({ shop: disabled.shopDomain }), 'store_disabled'],
      [h.sign({ shop: [h.store.shopDomain, h.store.shopDomain] }), 'duplicate_param'],
      [`${valid}&shop=${disabled.shopDomain}`, 'duplicate_param'],
      [`${valid}&x=%`, 'malformed'],
      [h.sign({ shop: 'loja.example.com' }), 'invalid_shop'],
      [`${valid}&injetado=1`, 'bad_signature'],
    ];
    for (const [query, reason] of cases) {
      const res = await h.post(`/checkout?${query}`, VALID_BODY);
      const body = await readJson(res);
      assert.deepEqual(body, { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }, reason);
      assert.match(h.metrics.render(), new RegExp(`bridge_proxy_auth_failures_total\\{reason="${reason}"\\} [1-9]`), reason);
    }
    assert.equal(h.calls.length, 0);
    assert.match(h.metrics.render(), /bridge_checkout_requests_total\{[^}]*code="unauthorized"[^}]*\} 14/);
  });

  it('timestamp no limite da janela ainda passa', async () => {
    const h = harness();
    for (const offset of [-90, 90]) {
      const res = await h.post(`/checkout?${h.sign({ timestamp: String(T0_SECONDS + offset) })}`, VALID_BODY);
      assert.equal((await readJson(res)).ok, true);
    }
  });

  it('assinatura feita com o segredo de outra vitrine não vale', async () => {
    const h = harness();
    const other = makeStore(h.repos, 'vitrine', { clientSecret: 'segredo-da-outra', proxyPath: PROXY_PATH });
    await expectFailure(await h.post(`/checkout?${h.sign({ shop: other.shopDomain })}`, VALID_BODY), 'unauthorized');
    const res = await h.post(`/checkout?${h.sign({ shop: other.shopDomain }, 'segredo-da-outra')}`, VALID_BODY);
    assert.equal((await readJson(res)).ok, true);
    assert.equal(h.calls[0]?.request.shopDomain, other.shopDomain);
  });

  it('Content-Type diferente de application/json', async () => {
    const h = harness();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp', '']) {
      const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'content-type': contentType });
      await expectFailure(res, 'invalid_request');
    }
    assert.equal(h.calls.length, 0);
    const ok = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'content-type': 'Application/JSON; charset=UTF-8' });
    assert.equal((await readJson(ok)).ok, true);
  });

  it('corpo acima de 64 KB é recusado; exatamente 64 KB passa', async () => {
    const h = harness();
    const padded = (bytes: number) => {
      const base = JSON.stringify({ ...VALID_BODY, pad: '' });
      return JSON.stringify({ ...VALID_BODY, pad: 'x'.repeat(bytes - base.length) });
    };
    assert.equal(Buffer.byteLength(padded(65536)), 65536);
    assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, padded(65536)))).ok, true);
    await expectFailure(await h.post(`/checkout?${h.sign()}`, padded(65537)), 'invalid_request');
    await expectFailure(await h.post(`/checkout?${h.sign()}`, padded(300_000)), 'invalid_request');
    // Content-Length declarado acima do teto: recusa sem ler o corpo.
    const declared = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'content-length': '70000' });
    await expectFailure(declared, 'invalid_request');
    assert.equal(h.calls.length, 1);
  });

  it('JSON inválido, UTF-8 inválido e corpo reprovado pelo validador', async () => {
    const h = harness();
    await expectFailure(await h.post(`/checkout?${h.sign()}`, '{"lines": ['), 'invalid_request');
    await expectFailure(await h.post(`/checkout?${h.sign()}`, ''), 'invalid_request');
    await expectFailure(await h.post(`/checkout?${h.sign()}`, { semLinhas: true }), 'invalid_request');
    const invalidUtf8 = await h.app.request(`/checkout?${h.sign()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    });
    await expectFailure(invalidUtf8, 'invalid_request');
    assert.equal(h.calls.length, 0);
    assert.match(h.metrics.render(), /bridge_checkout_requests_total\{[^}]*code="invalid_request"[^}]*\} 4/);
  });
});

describe('POST /checkout: erros do serviço, limites e logs', () => {
  it('BridgeError vira code + mensagem pública, sem details', async () => {
    const h = harness({
      createCheckout: async () => {
        throw new BridgeError('unmapped_variant', 'variante 44001 sem par', { variantId: '44001', interno: 'não vazar' });
      },
    });
    const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY);
    const text = await res.clone().text();
    await expectFailure(res, 'unmapped_variant');
    assert.ok(!text.includes('44001') && !text.includes('não vazar') && !text.includes('details'));
    assert.match(h.metrics.render(), /bridge_checkout_requests_total\{[^}]*code="unmapped_variant"[^}]*\} 1/);
  });

  it('todo código de erro de negócio responde 200', async () => {
    const codes = ['no_route', 'variant_unavailable', 'quantity_exceeded', 'selling_plan_unsupported', 'price_divergence',
      'upstream_unavailable', 'upstream_rejected', 'store_disabled', 'rate_limited'] as const;
    for (const code of codes) {
      const h = harness({ createCheckout: async () => { throw new BridgeError(code); } });
      await expectFailure(await h.post(`/checkout?${h.sign()}`, VALID_BODY), code);
    }
  });

  it('erro inesperado vira internal', async () => {
    const h = harness({ createCheckout: async () => { throw new TypeError('falha com detalhe interno'); } });
    const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY);
    const text = await res.clone().text();
    await expectFailure(res, 'internal');
    assert.ok(!text.includes('detalhe interno'));
    const failing = harness({ parseBody: () => { throw new Error('validador quebrou'); } });
    await expectFailure(await failing.post(`/checkout?${failing.sign()}`, VALID_BODY), 'internal');
  });

  it('limite por IP: recusa com rate_limited (200) e não chama o serviço', async () => {
    const h = harness({ ipCapacity: 2 });
    for (let i = 0; i < 2; i += 1) assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, VALID_BODY))).ok, true);
    await expectFailure(await h.post(`/checkout?${h.sign()}`, VALID_BODY), 'rate_limited');
    assert.equal(h.calls.length, 2);
    // Outro IP tem o próprio balde; sem IP conhecido só vale o limite da loja.
    const other = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'x-forwarded-for': '198.51.100.7' });
    assert.equal((await readJson(other)).ok, true);
    const noIp = await h.app.request(`/checkout?${h.sign()}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(VALID_BODY),
    });
    assert.equal((await readJson(noIp)).ok, true);
    // O balde repõe com o tempo (1 ficha por segundo no teste).
    h.clock.advance(1000);
    const later = await h.post(`/checkout?${h.sign({ timestamp: String(T0_SECONDS + 1) })}`, VALID_BODY);
    assert.equal((await readJson(later)).ok, true);
    assert.match(h.metrics.render(), /bridge_proxy_rate_limited_total\{scope="ip"\} 1/);
  });

  it('com proxy reverso na frente (TRUSTED_PROXY_HOPS=1), o IP do comprador é o item que a Shopify acrescentou, nunca o da esquerda', async () => {
    const h = harness({ ipCapacity: 1, trustedProxyHops: 1 });
    // Navegador, Shopify, proxy reverso: "<forjado>, <comprador>, <ip da shopify>".
    const header = (forged: string, buyer: string) => ({ 'x-forwarded-for': `${forged}, ${buyer}, 198.51.100.7` });
    assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, VALID_BODY, header('1.1.1.1', '203.0.113.5')))).ok, true);
    assert.equal(h.calls[0]?.ctx.buyerIp, '203.0.113.5');
    // Mesmo comprador com outro valor forjado à esquerda: mesmo balde, já vazio.
    await expectFailure(await h.post(`/checkout?${h.sign()}`, VALID_BODY, header('2.2.2.2', '203.0.113.5')), 'rate_limited');
    // Outro comprador de verdade tem balde próprio.
    assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, VALID_BODY, header('1.1.1.1', '203.0.113.6')))).ok, true);
    assert.equal(h.calls[1]?.ctx.buyerIp, '203.0.113.6');
    // Cabeçalho com um item só (faltam os saltos esperados): nenhum IP conhecido, só o limite da loja.
    assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'x-forwarded-for': '203.0.113.5' }))).ok, true);
    assert.equal(h.calls[2]?.ctx.buyerIp, null);
  });

  it('limite por loja vale para todos os IPs; requisição não autenticada não consome', async () => {
    const h = harness({ shopCapacity: 2 });
    for (let i = 0; i < 5; i += 1) await expectFailure(await h.post('/checkout?shop=x', VALID_BODY), 'unauthorized');
    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'x-forwarded-for': ip });
      assert.equal((await readJson(res)).ok, true);
    }
    const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { 'x-forwarded-for': '198.51.100.3' });
    await expectFailure(res, 'rate_limited');
    assert.match(h.metrics.render(), /bridge_proxy_rate_limited_total\{scope="shop"\} 1/);
    // O ping divide os mesmos baldes.
    await expectFailure(await h.app.request(`/ping?${h.sign()}`), 'rate_limited');
  });

  it('logs levam requestId, loja, código e latência; nunca assinatura, segredo, IP ou corpo', async () => {
    const h = harness();
    const query = h.sign();
    const signature = query.slice(query.indexOf('signature=') + 'signature='.length);
    await h.post(`/checkout?${query}`, { ...VALID_BODY, attribution: { utm_source: 'valor-do-corpo' } });
    await h.post(`/checkout?${query.replace(signature, '0'.repeat(64))}`, VALID_BODY);
    await h.app.request(`/bridge.js?${query}`);
    await h.app.request(`/ping?${query}`);
    const all = h.logs.join('');
    for (const secret of [signature, SECRET, BUYER_IP, 'valor-do-corpo', 'chave-secreta-do-carrinho', 'timestamp=']) {
      assert.ok(!all.includes(secret), `log contém ${secret}`);
    }
    const entries = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const ok = entries.find((e) => e.route === 'checkout' && e.code === 'ok');
    assert.ok(ok);
    assert.equal(ok.shop, h.store.shopDomain);
    assert.match(String(ok.requestId), /^req_/);
    assert.equal(typeof ok.ms, 'number');
    assert.equal(ok.sessionId, 'cs_teste_1');
    const denied = entries.find((e) => e.code === 'unauthorized');
    assert.ok(denied);
    assert.equal(denied.reason, 'bad_signature');
    assert.equal(denied.level, 'warn');
  });
});

describe('GET /bridge.js', () => {
  it('serve o script com o path_prefix verificado e cache de 5 minutos', async () => {
    const h = harness();
    const res = await h.app.request(`/bridge.js?${h.sign({ path_prefix: '/tools/outro_caminho-1' })}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(await res.text(), `/* script ${h.store.id} /tools/outro_caminho-1 */`);
  });

  it('path_prefix fora do padrão cai no caminho cadastrado na loja', async () => {
    const h = harness();
    for (const prefix of ['', '/apps/x"};alert(1);//', 'https://evil.example/apps/x', '/admin/x']) {
      const res = await h.app.request(`/bridge.js?${h.sign({ path_prefix: prefix })}`);
      assert.equal(await res.text(), `/* script ${h.store.id} ${PROXY_PATH} */`);
    }
    // Parâmetro ausente (a Shopify sempre manda, mas a rota não depende disso).
    const query = signAppProxyQuery({ shop: h.store.shopDomain, timestamp: String(T0_SECONDS) }, SECRET);
    const res = await h.app.request(`/bridge.js?${query}`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(await res.text(), `/* script ${h.store.id} ${PROXY_PATH} */`);
    // path_prefix repetido (um deles injetado pelo cliente) não chega ao gerador do script.
    const injected = await h.app.request(`/bridge.js?${h.sign({ path_prefix: ['/apps/evil', PROXY_PATH] })}`);
    assert.equal(injected.headers.get('cache-control'), 'no-store');
    assert.match(await injected.text(), /^\/\* checkout-bridge: [^*]+ \*\/\n$/);
  });

  it('falha de autenticação ou do gerador responde 200 com um comentário JavaScript', async () => {
    const h = harness({ renderScript: () => { throw new Error('gerador quebrou'); } });
    for (const query of ['', h.sign({}, 'segredo-errado'), h.sign()]) {
      const res = await h.app.request(`/bridge.js?${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(await res.text(), /^\/\* checkout-bridge: [^*]+ \*\/\n$/);
    }
  });

  it('não consome os limites de taxa', async () => {
    const h = harness({ ipCapacity: 1, shopCapacity: 1 });
    for (let i = 0; i < 5; i += 1) {
      const res = await h.app.request(`/bridge.js?${h.sign()}`, { headers: { 'x-forwarded-for': BUYER_IP } });
      assert.match(await res.text(), /^\/\* script /);
    }
    assert.equal((await readJson(await h.post(`/checkout?${h.sign()}`, VALID_BODY))).ok, true);
  });
});

describe('id de requisição', () => {
  const PARENT_ID = 'req_0123456789abcdef';

  function mounted(h: Harness): Hono<ProxyEnv> {
    // Como em src/app.ts: a aplicação principal gera o id antes de entrar nas rotas do proxy.
    const parent = new Hono<ProxyEnv>();
    parent.use('*', async (c, next) => {
      c.set('requestId', PARENT_ID);
      await next();
    });
    parent.route('/proxy', h.app);
    return parent;
  }

  it('montado na aplicação, usa o id dela no cabeçalho, no contexto do serviço e nos logs', async () => {
    const h = harness();
    const parent = mounted(h);
    const res = await parent.request(`/proxy/checkout?${h.sign()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': BUYER_IP },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal((await readJson(res)).ok, true);
    assert.equal(res.headers.get('x-request-id'), PARENT_ID);
    assert.equal(h.calls[0]?.ctx.requestId, PARENT_ID);
    const entries = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const line = entries.find((e) => e.route === 'checkout');
    assert.equal(line?.requestId, PARENT_ID);

    const ping = await parent.request(`/proxy/ping?${h.sign()}`);
    assert.equal(ping.headers.get('x-request-id'), PARENT_ID);
    const unknown = await parent.request('/proxy/nada');
    await expectFailure(unknown, 'not_found');
    assert.equal(unknown.headers.get('x-request-id'), PARENT_ID);
    const denied = await parent.request('/proxy/checkout', { method: 'POST' });
    await expectFailure(denied, 'unauthorized');
    assert.equal(denied.headers.get('x-request-id'), PARENT_ID);
  });

  it('exceção dentro de uma rota responde com o id da aplicação e o registra', async () => {
    const h = harness({
      renderScript: () => {
        throw new Error('quebrou');
      },
    });
    const parent = mounted(h);
    // Cada rota trata a própria exceção e responde 200 com { ok: false }; o id tem de ser o mesmo.
    const broken = harness({
      parseBody: () => {
        throw new Error('quebrou');
      },
    });
    const res = await mounted(broken).request(`/proxy/checkout?${broken.sign()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    await expectFailure(res, 'internal');
    assert.equal(res.headers.get('x-request-id'), PARENT_ID);
    const entries = broken.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(entries.some((e) => e.requestId === PARENT_ID && e.code === 'internal'));
    const script = await parent.request(`/proxy/bridge.js?${h.sign()}`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /^\/\* checkout-bridge: erro ao gerar o script/);
    const scriptLog = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.route === 'bridge.js');
    assert.equal(scriptLog?.requestId, PARENT_ID);
  });

  it('usado sozinho (sem a aplicação principal), gera um id próprio', async () => {
    const h = harness();
    const res = await h.post(`/checkout?${h.sign()}`, VALID_BODY);
    assert.match(res.headers.get('x-request-id') ?? '', /^req_[0-9a-f]{16}$/);
    assert.equal(res.headers.get('x-request-id'), h.calls[0]?.ctx.requestId);
  });
});

describe('GET /ping, barra final e caminhos desconhecidos', () => {
  it('ping devolve a loja verificada e o horário do servidor', async () => {
    const h = harness();
    assert.deepEqual(await readJson(await h.app.request(`/ping?${h.sign()}`)), { ok: true, shop: h.store.shopDomain, at: T0 });
    await expectFailure(await h.app.request('/ping'), 'unauthorized');
  });

  it('as três rotas respondem com barra final, sem redirecionar, também montadas em /proxy', async () => {
    const h = harness();
    const root = new Hono().route('/proxy', h.app);
    for (const base of ['', '/proxy']) {
      const target = base === '' ? h.app : root;
      const ping = await target.request(`${base}/ping/?${h.sign()}`, { redirect: 'manual' });
      assert.equal((await readJson(ping)).ok, true);
      const script = await target.request(`${base}/bridge.js/?${h.sign()}`, { redirect: 'manual' });
      assert.equal(script.status, 200);
      assert.match(await script.text(), /^\/\* script /);
      const checkout = await target.request(`${base}/checkout/?${h.sign()}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(VALID_BODY), redirect: 'manual',
      });
      assert.deepEqual(await readJson(checkout), { ok: true, checkoutUrl: CHECKOUT_URL, sessionId: 'cs_teste_1' });
    }
    assert.equal(h.calls.length, 2);
  });

  it('caminho ou método desconhecido responde 200 not_found, sem CORS', async () => {
    const h = harness();
    await expectFailure(await h.app.request(`/outra-coisa?${h.sign()}`), 'not_found');
    await expectFailure(await h.app.request(`/checkout?${h.sign()}`), 'not_found');
    await expectFailure(await h.app.request(`/ping?${h.sign()}`, { method: 'POST' }), 'not_found');
    const preflight = await h.app.request(`/checkout?${h.sign()}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    await expectFailure(preflight, 'not_found');
    const crossOrigin = await h.post(`/checkout?${h.sign()}`, VALID_BODY, { origin: 'https://evil.example' });
    assert.equal((await readJson(crossOrigin)).ok, true);
    assert.equal(h.calls.length, 1);
  });
});
