import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../src/lib/logger.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import { createAdminTokenProvider } from '../src/shopify/auth.ts';
import { isBridgeError } from '../src/types.ts';
import type { Alert, BridgeError, BridgeErrorCode, Store } from '../src/types.ts';
import { makeStore, setup } from './db-helpers.ts';

const SECRET = 'shpss_segredo_que_nao_pode_vazar';
const TOKEN = 'shpat_token_que_nao_pode_vazar';

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return json(200, { access_token: TOKEN, scope: 'read_products,write_products', expires_in: 86399, ...overrides });
}

function harness(opts: { timeoutMs?: number } = {}) {
  const ctx = setup();
  const store = makeStore(ctx.repos, 'checkout', { clientSecret: SECRET });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const script: Step[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = script.shift();
    if (step === undefined) throw new Error('fetch fora do roteiro');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(init ?? {}) : step;
  }) as typeof fetch;
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    env: 'test',
    destination: { write: (line: string) => void logLines.push(line) },
  });
  const metrics = createMetrics();
  const alerts: Alert[] = [];
  const sleeps: number[] = [];
  const provider = createAdminTokenProvider({
    stores: ctx.repos.stores,
    config: { upstreamTimeoutMs: opts.timeoutMs ?? 1000 },
    logger,
    metrics,
    alerter: { notify: (alert) => void alerts.push(alert) },
    fetchImpl,
    clock: ctx.clock,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  const bodyOf = (index: number): URLSearchParams => new URLSearchParams(String(calls[index]?.init.body ?? ''));
  return { ...ctx, store, calls, script, logLines, metrics, alerts, sleeps, provider, bodyOf };
}

async function rejection(promise: Promise<unknown>, code: BridgeErrorCode): Promise<BridgeError> {
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

/** Tudo o que sai do módulo por log, alerta ou erro, em um texto só. */
function everythingVisible(h: ReturnType<typeof harness>, errors: BridgeError[] = []): string {
  return [
    h.logLines.join('\n'),
    JSON.stringify(h.alerts),
    ...errors.map((err) => `${err.message} ${JSON.stringify(err.details)} ${String(err.stack)}`),
    h.metrics.render(),
  ].join('\n');
}

describe('createAdminTokenProvider: pedido e cache', () => {
  it('faz o POST do client credentials grant e devolve o token e os escopos', async () => {
    const h = harness();
    h.script.push(tokenResponse({ scope: ' read_products, write_products ,, read_inventory' }));
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.deepEqual(await h.provider.getScopes(h.store), ['read_products', 'write_products', 'read_inventory']);

    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call?.url, `https://${h.store.shopDomain}/admin/oauth/access_token`);
    assert.equal(call?.init.method, 'POST');
    assert.equal(call?.init.redirect, 'manual');
    assert.equal(new Headers(call?.init.headers).get('content-type'), 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(h.bodyOf(0)), {
      grant_type: 'client_credentials',
      client_id: h.store.clientId,
      client_secret: SECRET,
    });
    assert.match(h.metrics.render(), /bridge_admin_token_requests_total\{result="ok"\} 1/);
  });

  it('reaproveita o token e renova quando faltam menos de 5 minutos', async () => {
    const h = harness();
    h.script.push(tokenResponse(), tokenResponse({ access_token: 'shpat_segundo' }));
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    h.clock.advance((86399 - 300) * 1000 - 1);
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(h.calls.length, 1);
    h.clock.advance(1);
    assert.equal(await h.provider.getToken(h.store), 'shpat_segundo');
    assert.equal(h.calls.length, 2);
  });

  it('sem expires_in utilizável assume validade curta', async () => {
    const h = harness();
    h.script.push(tokenResponse({ expires_in: 'amanhã' }), tokenResponse({ access_token: 'shpat_segundo' }));
    await h.provider.getToken(h.store);
    h.clock.advance(4 * 60_000);
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    h.clock.advance(2 * 60_000);
    assert.equal(await h.provider.getToken(h.store), 'shpat_segundo');
  });

  it('single flight: chamadas simultâneas da mesma loja compartilham um pedido', async () => {
    const h = harness();
    let release: (res: Response) => void = () => {};
    h.script.push(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = Promise.all([
      h.provider.getToken(h.store),
      h.provider.getToken(h.store),
      h.provider.getScopes(h.store),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.length, 1);
    release(tokenResponse());
    const [first, second, scopes] = await pending;
    assert.equal(first, TOKEN);
    assert.equal(second, TOKEN);
    assert.deepEqual(scopes, ['read_products', 'write_products']);
    assert.equal(h.calls.length, 1);
  });

  it('lojas diferentes têm caches e pedidos independentes', async () => {
    const h = harness();
    const other = makeStore(h.repos, 'vitrine', { clientSecret: 'outro-segredo' });
    h.script.push(tokenResponse(), tokenResponse({ access_token: 'shpat_outra' }));
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(await h.provider.getToken(other), 'shpat_outra');
    assert.equal(h.calls[1]?.url, `https://${other.shopDomain}/admin/oauth/access_token`);
    assert.equal(h.bodyOf(1).get('client_secret'), 'outro-segredo');
  });

  it('credenciais novas valem na hora (impressão digital de clientId + secret)', async () => {
    const h = harness();
    h.script.push(tokenResponse(), tokenResponse({ access_token: 'shpat_novo_secret' }));
    await h.provider.getToken(h.store);

    h.repos.stores.update(h.store.id, { clientSecret: 'shpss_secret_rotacionado' });
    assert.equal(await h.provider.getToken(h.store), 'shpat_novo_secret');
    assert.equal(h.bodyOf(1).get('client_secret'), 'shpss_secret_rotacionado');
    assert.equal(await h.provider.getToken(h.store), 'shpat_novo_secret');
    assert.equal(h.calls.length, 2);

    h.script.push(tokenResponse({ access_token: 'shpat_novo_client' }));
    const renamed: Store = h.repos.stores.update(h.store.id, { clientId: 'client-novo' });
    assert.equal(await h.provider.getToken(renamed), 'shpat_novo_client');
    assert.equal(h.bodyOf(2).get('client_id'), 'client-novo');
  });

  it('invalidate força um token novo', async () => {
    const h = harness();
    h.script.push(tokenResponse(), tokenResponse({ access_token: 'shpat_segundo', scope: 'read_orders' }));
    await h.provider.getToken(h.store);
    h.provider.invalidate(h.store.id);
    assert.equal(await h.provider.getToken(h.store), 'shpat_segundo');
    assert.deepEqual(await h.provider.getScopes(h.store), ['read_orders']);
    assert.equal(h.calls.length, 2);
  });

  it('invalidate durante um pedido em curso impede que o resultado entre no cache', async () => {
    const h = harness();
    let release: (res: Response) => void = () => {};
    h.script.push(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = h.provider.getToken(h.store);
    await new Promise((resolve) => setImmediate(resolve));
    h.provider.invalidate(h.store.id);
    release(tokenResponse());
    assert.equal(await pending, TOKEN);

    h.script.push(tokenResponse({ access_token: 'shpat_depois' }));
    assert.equal(await h.provider.getToken(h.store), 'shpat_depois');
    assert.equal(h.calls.length, 2);
  });

  it('loja inexistente propaga store_not_found sem chamar a Shopify', async () => {
    const h = harness();
    await rejection(h.provider.getToken({ ...h.store, id: 'st_nao_existe' }), 'store_not_found');
    assert.equal(h.calls.length, 0);
  });
});

describe('createAdminTokenProvider: erros permanentes de configuração', () => {
  it('shop_not_permitted: não repete, explica a causa, alerta e lembra por 30 segundos', async () => {
    const h = harness();
    h.script.push(json(400, { error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop.' }));
    const err = await rejection(h.provider.getToken(h.store), 'upstream_rejected');
    assert.deepEqual(err.details, { status: 400, error: 'shop_not_permitted' });
    assert.match(err.message, /mesma organização/);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `admin-token:${h.store.id}`);
    assert.equal(h.alerts[0]?.severity, 'critical');

    // Dentro dos 30 segundos: mesma resposta, sem novo pedido e sem novo alerta.
    h.clock.advance(29_999);
    const again = await rejection(h.provider.getScopes(h.store), 'upstream_rejected');
    assert.deepEqual(again.details, { status: 400, error: 'shop_not_permitted' });
    assert.equal(again.message, err.message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.alerts.length, 1);
    assert.match(h.metrics.render(), /bridge_admin_token_requests_total\{result="rejected"\} 1/);
    assert.match(h.metrics.render(), /bridge_admin_token_requests_total\{result="negative_cache"\} 1/);

    h.clock.advance(1);
    h.script.push(tokenResponse());
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(h.calls.length, 2);
  });

  it('o cache negativo cai com invalidate e com credenciais novas', async () => {
    const h = harness();
    h.script.push(json(401, { error: 'invalid_client' }), tokenResponse());
    await rejection(h.provider.getToken(h.store), 'upstream_rejected');
    h.provider.invalidate(h.store.id);
    assert.equal(await h.provider.getToken(h.store), TOKEN);

    const g = harness();
    g.script.push(json(401, { error: 'invalid_client' }), tokenResponse());
    await rejection(g.provider.getToken(g.store), 'upstream_rejected');
    g.repos.stores.update(g.store.id, { clientSecret: 'shpss_corrigido' });
    assert.equal(await g.provider.getToken(g.store), TOKEN);
    assert.equal(g.bodyOf(1).get('client_secret'), 'shpss_corrigido');
  });

  const cases: Array<{ name: string; response: () => Response; status: number; error: string | null; message: RegExp }> = [
    { name: 'application_cannot_be_found', response: () => json(400, { error: 'application_cannot_be_found' }), status: 400, error: 'application_cannot_be_found', message: /Client ID/ },
    { name: 'invalid_client', response: () => json(401, { error: 'invalid_client' }), status: 401, error: 'invalid_client', message: /Client secret/ },
    { name: 'invalid_request', response: () => json(400, { error: 'invalid_request' }), status: 400, error: 'invalid_request', message: /versão lançada/ },
    { name: 'HTTP 403 sem corpo JSON', response: () => new Response('Forbidden', { status: 403 }), status: 403, error: null, message: /HTTP 403/ },
    { name: 'HTTP 404 com HTML', response: () => new Response('<html>Not Found</html>', { status: 404 }), status: 404, error: null, message: /myshopify\.com/ },
    { name: 'erro no formato {"errors": "..."}', response: () => json(400, { errors: 'Bad Request' }), status: 400, error: 'Bad Request', message: /HTTP 400/ },
    { name: 'redirecionamento', response: () => new Response(null, { status: 302, headers: { location: 'https://outro.example/' } }), status: 302, error: null, message: /redirecionamento/ },
    { name: 'código permanente com status 500', response: () => json(500, { error: 'shop_not_permitted' }), status: 500, error: 'shop_not_permitted', message: /organização/ },
    { name: '200 sem access_token', response: () => json(200, { scope: 'read_products', expires_in: 86399 }), status: 200, error: null, message: /access_token/ },
    { name: '200 com corpo que não é JSON', response: () => new Response('<html>ok</html>', { status: 200 }), status: 200, error: null, message: /access_token/ },
  ];
  for (const c of cases) {
    it(`${c.name}: upstream_rejected sem retry`, async () => {
      const h = harness();
      h.script.push(c.response());
      const err = await rejection(h.provider.getToken(h.store), 'upstream_rejected');
      assert.deepEqual(err.details, { status: c.status, error: c.error });
      assert.match(err.message, c.message);
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.sleeps, []);
      assert.equal(h.alerts[0]?.key, `admin-token:${h.store.id}`);
    });
  }

  it('domínio fora de myshopify.com: recusa sem enviar o secret a lugar nenhum', async () => {
    const h = harness();
    const err = await rejection(h.provider.getToken({ ...h.store, shopDomain: 'loja.evil.example' }), 'upstream_rejected');
    assert.equal(err.details['error'], 'invalid_shop_domain');
    assert.equal(h.calls.length, 0);
  });
});

describe('createAdminTokenProvider: falhas transitórias', () => {
  it('repete até 2 vezes com backoff e devolve o token quando a Shopify volta', async () => {
    const h = harness();
    h.script.push(new Response('erro', { status: 500 }), new TypeError('fetch failed'), tokenResponse());
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(h.calls.length, 3);
    // random = 0.5: metade de 250 ms e metade de 500 ms.
    assert.deepEqual(h.sleeps, [125, 250]);
    assert.deepEqual(h.alerts, []);
  });

  for (const c of [
    { name: 'HTTP 503', step: () => new Response('fora do ar', { status: 503 }), details: { reason: 'http', status: 503 } },
    { name: 'HTTP 429', step: () => new Response('', { status: 429 }), details: { reason: 'http', status: 429 } },
    { name: 'falha de rede', step: () => new TypeError('fetch failed'), details: { reason: 'network' } },
  ]) {
    it(`${c.name}: 3 tentativas e depois upstream_unavailable, sem cache negativo`, async () => {
      const h = harness();
      h.script.push(c.step(), c.step(), c.step());
      const err = await rejection(h.provider.getToken(h.store), 'upstream_unavailable');
      assert.deepEqual(err.details, c.details);
      assert.equal(h.calls.length, 3);
      assert.equal(h.sleeps.length, 2);
      assert.deepEqual(h.alerts, []);
      assert.match(h.metrics.render(), /bridge_admin_token_requests_total\{result="unavailable"\} 1/);

      // Erro transitório não é lembrado: a chamada seguinte tenta de novo na hora.
      h.script.push(tokenResponse());
      assert.equal(await h.provider.getToken(h.store), TOKEN);
      assert.equal(h.calls.length, 4);
    });
  }

  it('respeita Retry-After do 429 como espera mínima', async () => {
    const h = harness();
    h.script.push(new Response('', { status: 429, headers: { 'retry-after': '2.0' } }), tokenResponse());
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.deepEqual(h.sleeps, [2000]);
  });

  it('timeout: 3 tentativas e depois upstream_unavailable', async () => {
    const h = harness({ timeoutMs: 5 });
    const hang = (init: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    h.script.push(hang, hang, hang);
    const err = await rejection(h.provider.getToken(h.store), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'timeout' });
    assert.equal(h.calls.length, 3);
  });

  it('renovação antecipada que falha mantém o token atual enquanto ele ainda vale', async () => {
    const h = harness();
    h.script.push(tokenResponse());
    await h.provider.getToken(h.store);
    h.clock.advance((86399 - 240) * 1000);

    h.script.push(new Response('', { status: 503 }), new Response('', { status: 503 }), new Response('', { status: 503 }));
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(h.calls.length, 4);
    // Nos 30 segundos seguintes não tenta renovar de novo.
    h.clock.advance(29_000);
    assert.equal(await h.provider.getToken(h.store), TOKEN);
    assert.equal(h.calls.length, 4);
    h.clock.advance(1000);
    h.script.push(tokenResponse({ access_token: 'shpat_renovado' }));
    assert.equal(await h.provider.getToken(h.store), 'shpat_renovado');

    // Já expirado, a falha transitória não tem reserva para devolver.
    h.clock.advance(86400 * 1000);
    h.script.push(new Response('', { status: 503 }), new Response('', { status: 503 }), new Response('', { status: 503 }));
    await rejection(h.provider.getToken(h.store), 'upstream_unavailable');
  });

  it('erro permanente na renovação antecipada não é mascarado pelo token antigo', async () => {
    const h = harness();
    h.script.push(tokenResponse());
    await h.provider.getToken(h.store);
    h.clock.advance((86399 - 240) * 1000);
    h.script.push(json(401, { error: 'invalid_client' }));
    await rejection(h.provider.getToken(h.store), 'upstream_rejected');
  });
});

describe('createAdminTokenProvider: segredos', () => {
  it('o client secret e o token não aparecem em log, alerta, métrica ou erro', async () => {
    const h = harness();
    const errors: BridgeError[] = [];
    // Sucesso, com log em nível trace.
    h.script.push(tokenResponse());
    await h.provider.getToken(h.store);
    h.provider.invalidate(h.store.id);
    // Erro permanente em que o destino ecoa o secret e um token no corpo.
    h.script.push(
      json(400, { error: `invalid_client: ${SECRET} / ${encodeURIComponent(SECRET)}`, error_description: SECRET, access_token: 12345 }),
    );
    errors.push(await rejection(h.provider.getToken(h.store), 'upstream_rejected'));
    h.provider.invalidate(h.store.id);
    // Erro transitório com o secret no corpo.
    h.script.push(new Response(SECRET, { status: 500 }), new Response(SECRET, { status: 500 }), new Response(SECRET, { status: 500 }));
    errors.push(await rejection(h.provider.getToken(h.store), 'upstream_unavailable'));

    assert.ok(h.logLines.length >= 4, 'esperava linhas de log capturadas');
    assert.ok(h.alerts.length >= 1);
    const visible = everythingVisible(h, errors);
    assert.ok(!visible.includes(SECRET), 'o client secret vazou');
    assert.ok(!visible.includes(encodeURIComponent(SECRET)), 'o client secret codificado vazou');
    assert.ok(!visible.includes(TOKEN), 'o token vazou');
    assert.match(String(errors[0]?.details['error']), /\[redigido\]/);
  });
});
