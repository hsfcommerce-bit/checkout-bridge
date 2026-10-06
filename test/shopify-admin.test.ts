import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeClock } from '../src/lib/clock.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import { createAdminClient } from '../src/shopify/admin.ts';
import { BridgeError, isBridgeError } from '../src/types.ts';
import type { AdminTokenProvider, Alert, BridgeErrorCode, Store } from '../src/types.ts';

const QUERY = 'query Loja { shop { name } }';
const DATA = { shop: { name: 'Loja Checkout' } };

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

const STORE: Store = {
  id: 'st_checkout_1',
  role: 'checkout',
  name: 'Loja Checkout',
  shopDomain: 'loja-checkout.myshopify.com',
  publicDomain: null,
  proxyPath: null,
  clientId: 'client-1',
  currency: 'BRL',
  status: 'connected',
  statusDetail: null,
  storefrontAuthMode: 'tokenless',
  hasStorefrontToken: false,
  lastSyncAt: null,
  lastSyncOk: null,
  lastSyncDetail: null,
  variantCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function cost(requested: number, available: number, restoreRate: number, maximum = 1000): Record<string, unknown> {
  return {
    cost: {
      requestedQueryCost: requested,
      actualQueryCost: null,
      throttleStatus: { maximumAvailable: maximum, currentlyAvailable: available, restoreRate },
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function ok(extensions?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json(200, extensions ? { data: DATA, extensions } : { data: DATA }, headers);
}

function gqlError(code: string | null, message: string, extensions?: Record<string, unknown>): Response {
  const error = code === null ? { message } : { message, extensions: { code } };
  return json(200, extensions ? { errors: [error], extensions } : { errors: [error] });
}

function harness(opts: { timeoutMs?: number; tokenError?: BridgeError } = {}) {
  const clock = fakeClock();
  const calls: Array<{ url: string; init: RequestInit; token: string | null }> = [];
  const script: Step[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init: init ?? {},
      token: new Headers(init?.headers).get('x-shopify-access-token'),
    });
    const step = script.shift();
    if (step === undefined) throw new Error('fetch fora do roteiro');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(init ?? {}) : step;
  }) as typeof fetch;

  // Porta falsa: cada invalidate() faz o próximo getToken devolver um token novo.
  const tokenState = { generation: 1, invalidated: [] as string[], requests: 0 };
  const tokens: AdminTokenProvider = {
    async getToken() {
      tokenState.requests += 1;
      if (opts.tokenError) throw opts.tokenError;
      return `shpat_token_secreto_${tokenState.generation}`;
    },
    async getScopes() {
      return [];
    },
    invalidate(storeId) {
      tokenState.invalidated.push(storeId);
      tokenState.generation += 1;
    },
  };

  const logLines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    env: 'test',
    destination: { write: (line: string) => void logLines.push(line) },
  });
  const metrics = createMetrics();
  const alerts: Alert[] = [];
  const sleeps: number[] = [];
  const client = createAdminClient({
    tokens,
    config: { shopifyApiVersion: '2026-10', upstreamTimeoutMs: opts.timeoutMs ?? 1000 },
    logger,
    metrics,
    alerter: { notify: (alert) => void alerts.push(alert) },
    fetchImpl,
    clock,
    // Dormir avança o relógio falso, como aconteceria de verdade.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    random: () => 0.5,
  });
  return { clock, calls, script, tokenState, logLines, metrics, alerts, sleeps, client };
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

describe('createAdminClient: requisição', () => {
  it('faz o POST no endpoint da versão fixada e devolve data', async () => {
    const h = harness();
    h.script.push(ok());
    const data = await h.client.graphql<typeof DATA>(STORE, QUERY, { first: 10 });
    assert.deepEqual(data, DATA);

    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call?.url, 'https://loja-checkout.myshopify.com/admin/api/2026-10/graphql.json');
    assert.equal(call?.init.method, 'POST');
    assert.equal(call?.init.redirect, 'manual');
    assert.equal(call?.token, 'shpat_token_secreto_1');
    assert.equal(new Headers(call?.init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(call?.init.body)), { query: QUERY, variables: { first: 10 } });
    assert.match(h.metrics.render(), /bridge_admin_requests_total\{result="ok"\} 1/);
    assert.match(h.metrics.render(), /bridge_admin_request_ms_count\{result="ok"\} 1/);
    assert.deepEqual(h.alerts, []);
  });

  it('sem variáveis, o corpo leva só a consulta', async () => {
    const h = harness();
    h.script.push(ok());
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(JSON.parse(String(h.calls[0]?.init.body)), { query: QUERY });
  });

  it('erro do provedor de token é propagado sem chamar a Shopify', async () => {
    const tokenError = new BridgeError('upstream_rejected', 'credenciais recusadas', { status: 401, error: 'invalid_client' });
    const h = harness({ tokenError });
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(err, tokenError);
    assert.equal(h.calls.length, 0);
    assert.match(h.metrics.render(), /bridge_admin_request_ms_count\{result="error"\} 1/);
  });

  it('domínio fora de myshopify.com: recusa sem pedir token nem enviar nada', async () => {
    const h = harness();
    await rejection(h.client.graphql({ ...STORE, shopDomain: 'loja.evil.example' }, QUERY), 'upstream_rejected');
    assert.equal(h.calls.length, 0);
    assert.equal(h.tokenState.requests, 0);
  });
});

describe('createAdminClient: acesso negado', () => {
  it('HTTP 401: invalida o token, emite outro e repete uma vez', async () => {
    const h = harness();
    h.script.push(json(401, { errors: '[API] Invalid API key or access token' }), ok());
    assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
    assert.deepEqual(h.tokenState.invalidated, [STORE.id]);
    assert.deepEqual(h.calls.map((call) => call.token), ['shpat_token_secreto_1', 'shpat_token_secreto_2']);
    assert.deepEqual(h.sleeps, []);
  });

  it('ACCESS_DENIED no corpo: mesmo caminho do 401', async () => {
    const h = harness();
    h.script.push(gqlError('ACCESS_DENIED', 'Access denied for products field.'), ok());
    assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
    assert.deepEqual(h.tokenState.invalidated, [STORE.id]);
    assert.equal(h.calls.length, 2);
  });

  it('negado de novo com token novo: upstream_rejected com code ACCESS_DENIED', async () => {
    const h = harness();
    const denied = (): Response =>
      json(200, {
        data: { products: null },
        errors: [{ message: 'Access denied for products field. Required access: `read_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }],
      });
    h.script.push(denied(), denied());
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(err.details['code'], 'ACCESS_DENIED');
    assert.deepEqual(err.details['messages'], ['Access denied for products field. Required access: `read_products` access scope.']);
    assert.match(err.message, /escopo/);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.tokenState.invalidated, [STORE.id]);
  });

  it('401 duas vezes: upstream_rejected com code ACCESS_DENIED e status 401', async () => {
    const h = harness();
    h.script.push(new Response('', { status: 401 }), new Response('', { status: 401 }));
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(err.details['code'], 'ACCESS_DENIED');
    assert.equal(err.details['status'], 401);
    assert.equal(h.calls.length, 2);
  });
});

describe('createAdminClient: limite de custo (THROTTLED)', () => {
  const cases: Array<{ name: string; response: () => Response; waitMs: number }> = [
    { name: 'ceil((300 - 50) / 100) = 3 s', response: () => gqlError('THROTTLED', 'Throttled', cost(300, 50, 100)), waitMs: 3000 },
    { name: 'ceil((101 - 100) / 100) = 1 s', response: () => gqlError('THROTTLED', 'Throttled', cost(101, 100, 100)), waitMs: 1000 },
    { name: 'saldo já suficiente: piso de 0,5 s', response: () => gqlError('THROTTLED', 'Throttled', cost(10, 50, 100)), waitMs: 500 },
    { name: 'espera longa: teto de 10 s', response: () => gqlError('THROTTLED', 'Throttled', cost(1000, 0, 50)), waitMs: 10_000 },
    { name: 'sem dados de custo: 1 s', response: () => gqlError('THROTTLED', 'Throttled'), waitMs: 1000 },
    { name: 'restoreRate zero: 1 s', response: () => gqlError('THROTTLED', 'Throttled', cost(300, 50, 0)), waitMs: 1000 },
    { name: 'HTTP 429 sem corpo: 1 s', response: () => new Response('', { status: 429 }), waitMs: 1000 },
    { name: 'HTTP 429 com Retry-After', response: () => new Response('', { status: 429, headers: { 'retry-after': '2.0' } }), waitMs: 2000 },
    { name: 'HTTP 429 com Retry-After absurdo: teto de 10 s', response: () => new Response('', { status: 429, headers: { 'retry-after': '120' } }), waitMs: 10_000 },
  ];
  for (const c of cases) {
    it(`espera e repete: ${c.name}`, async () => {
      const h = harness();
      h.script.push(c.response(), ok());
      assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
      assert.deepEqual(h.sleeps, [c.waitMs]);
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.tokenState.invalidated, []);
    });
  }

  it('desiste na quinta resposta limitada com upstream_unavailable', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.script.push(gqlError('THROTTLED', 'Throttled', cost(200, 0, 100)));
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_unavailable');
    assert.equal(err.details['code'], 'THROTTLED');
    assert.equal(err.details['attempts'], 5);
    assert.equal(h.calls.length, 5);
    assert.deepEqual(h.sleeps, [2000, 2000, 2000, 2000]);
    assert.match(h.metrics.render(), /bridge_admin_requests_total\{result="throttled"\} 5/);
  });
});

describe('createAdminClient: ritmo preventivo', () => {
  it('espera antes da requisição quando o saldo conhecido não cobre o último custo', async () => {
    const h = harness();
    h.script.push(ok(cost(500, 100, 50)), ok(cost(500, 600, 50)), ok());
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, []);
    // Saldo 100, custo 500, recomposição 50/s: faltam 400 pontos, 8 segundos.
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, [8000]);
    // Saldo 600 cobre o custo 500: sem espera.
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, [8000]);
  });

  it('conta o que o balde recompôs desde a última resposta, até o máximo informado', async () => {
    const h = harness();
    h.script.push(ok(cost(500, 100, 50)), ok(cost(900, 0, 50, 1000)), ok());
    await h.client.graphql(STORE, QUERY);
    h.clock.advance(4000);
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, [4000]);
    // Uma hora depois o balde está cheio (1000), não em 180000.
    h.clock.advance(3_600_000);
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, [4000]);
  });

  it('chamadas simultâneas não contam o mesmo saldo duas vezes; lojas são independentes', async () => {
    const h = harness();
    h.script.push(ok(cost(100, 150, 50)), ok(), ok(), ok());
    await h.client.graphql(STORE, QUERY);
    await Promise.all([h.client.graphql(STORE, QUERY), h.client.graphql(STORE, QUERY)]);
    assert.deepEqual(h.sleeps, [1000]);
    await h.client.graphql({ ...STORE, id: 'st_outra', shopDomain: 'outra-loja.myshopify.com' }, QUERY);
    assert.deepEqual(h.sleeps, [1000]);
  });
});

describe('createAdminClient: falhas transitórias', () => {
  it('rede, 5xx, 200 que não é JSON e INTERNAL_SERVER_ERROR: até 3 novas tentativas com backoff', async () => {
    const h = harness();
    h.script.push(new Response('erro', { status: 500 }), new TypeError('fetch failed'), new Response('<html></html>', { status: 200 }), ok());
    assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
    // random = 0.5: metade de 400, 800 e 1600 ms.
    assert.deepEqual(h.sleeps, [200, 400, 800]);
    assert.equal(h.calls.length, 4);

    const g = harness();
    g.script.push(gqlError('INTERNAL_SERVER_ERROR', 'Internal error'), ok());
    assert.deepEqual(await g.client.graphql(STORE, QUERY), DATA);
    assert.deepEqual(g.sleeps, [200]);
  });

  it('desiste depois de 4 tentativas com upstream_unavailable', async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) h.script.push(new Response('bad gateway', { status: 502 }));
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'http', status: 502, attempts: 4 });
    assert.equal(h.calls.length, 4);
    assert.equal(h.sleeps.length, 3);
  });

  it('timeout conta como falha transitória', async () => {
    const h = harness({ timeoutMs: 5 });
    const hang = (init: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    h.script.push(hang, hang, hang, hang);
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'timeout', status: null, attempts: 4 });
    assert.equal(h.calls.length, 4);
  });

  it('Retry-After de um 503 vale como espera mínima; erro desconhecido do fetch não é repetido', async () => {
    const h = harness();
    h.script.push(new Response('', { status: 503, headers: { 'retry-after': '3' } }), ok());
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.sleeps, [3000]);

    const g = harness();
    g.script.push(new Error('defeito qualquer'));
    const err = await rejection(g.client.graphql(STORE, QUERY), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'Error' });
    assert.equal(g.calls.length, 1);
  });
});

describe('createAdminClient: recusas', () => {
  for (const status of [402, 403, 404, 423]) {
    it(`HTTP ${status}: upstream_rejected com o status, sem retry`, async () => {
      const h = harness();
      h.script.push(new Response('indisponível', { status }));
      const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
      assert.deepEqual(err.details, { status });
      assert.match(err.message, new RegExp(`HTTP ${status}`));
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.sleeps, []);
      assert.deepEqual(h.tokenState.invalidated, []);
    });
  }

  it('outros status de recusa (400, redirecionamento) também viram upstream_rejected', async () => {
    const h = harness();
    h.script.push(json(400, { errors: { query: 'Required parameter missing or invalid' } }));
    assert.deepEqual((await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected')).details, { status: 400 });

    h.script.push(new Response(null, { status: 301, headers: { location: 'https://outro.example/' } }));
    assert.deepEqual((await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected')).details, { status: 301 });
    assert.equal(h.calls.length, 2);
  });

  it('erros GraphQL sem data: upstream_rejected com as mensagens truncadas', async () => {
    const h = harness();
    const long = 'x'.repeat(1000);
    h.script.push(
      json(200, {
        errors: [
          { message: "Field 'preco' doesn't exist on type 'ProductVariant'", extensions: { code: 'undefinedField' } },
          { message: long },
          ...Array.from({ length: 10 }, (_, i) => ({ message: `erro ${i}` })),
        ],
      }),
    );
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(err.details['status'], 200);
    assert.equal(err.details['code'], 'undefinedField');
    const messages = err.details['messages'];
    assert.ok(Array.isArray(messages));
    assert.equal(messages.length, 5);
    assert.equal(messages[0], "Field 'preco' doesn't exist on type 'ProductVariant'");
    assert.equal(messages[1], 'x'.repeat(300));
    assert.equal(h.calls.length, 1);
  });

  it('MAX_COST_EXCEEDED fica visível em details.code mesmo não sendo o primeiro erro', async () => {
    const h = harness();
    h.script.push(
      json(200, {
        errors: [
          { message: 'outro erro', extensions: { code: 'OUTRO' } },
          { message: 'Query cost is 1500, which exceeds the single query max cost limit (1000).', extensions: { code: 'MAX_COST_EXCEEDED' } },
        ],
      }),
    );
    const err = await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(err.details['code'], 'MAX_COST_EXCEEDED');
    assert.match(err.message, /MAX_COST_EXCEEDED/);
    assert.equal(h.calls.length, 1);
  });

  it('200 sem data e sem erros é recusa; data com erros de campo é devolvido com aviso', async () => {
    const h = harness();
    h.script.push(json(200, { data: null }));
    assert.deepEqual((await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected')).details, { status: 200 });

    h.script.push(json(200, { data: DATA, errors: [{ message: 'campo indisponível', path: ['shop', 'x'] }] }));
    assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
    assert.ok(h.logLines.some((line) => line.includes('dados junto com erros') && line.includes('campo indisponível')));
  });
});

describe('createAdminClient: versão da API', () => {
  it('versão igual à fixada não gera aviso', async () => {
    const h = harness();
    h.script.push(ok(undefined, { 'x-shopify-api-version': '2026-10' }));
    await h.client.graphql(STORE, QUERY);
    assert.deepEqual(h.alerts, []);
    assert.ok(!h.logLines.some((line) => line.includes('versão diferente')));
  });

  it('versão diferente: aviso no log e alerta api-version:<loja>, sem repetir a cada resposta', async () => {
    const h = harness();
    const fellForward = (): Response => ok(undefined, { 'X-Shopify-API-Version': '2027-01' });
    h.script.push(fellForward(), fellForward(), fellForward());
    assert.deepEqual(await h.client.graphql(STORE, QUERY), DATA);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `api-version:${STORE.id}`);
    assert.equal(h.alerts[0]?.severity, 'warning');
    assert.deepEqual(h.alerts[0]?.detail, {
      storeId: STORE.id,
      shopDomain: STORE.shopDomain,
      pinnedVersion: '2026-10',
      servedVersion: '2027-01',
    });
    const warnings = (): number =>
      h.logLines.filter((line) => line.includes('versão diferente') && line.includes('"level":"warn"')).length;
    assert.equal(warnings(), 1);

    await h.client.graphql(STORE, QUERY);
    assert.equal(h.alerts.length, 1);
    assert.equal(warnings(), 1);

    h.clock.advance(10 * 60_000);
    await h.client.graphql(STORE, QUERY);
    assert.equal(h.alerts.length, 2);
    assert.equal(warnings(), 2);
  });

  it('o cabeçalho também é conferido em respostas de erro', async () => {
    const h = harness();
    h.script.push(new Response('', { status: 404, headers: { 'x-shopify-api-version': '2027-04' } }));
    await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected');
    assert.equal(h.alerts[0]?.key, `api-version:${STORE.id}`);
  });
});

describe('createAdminClient: segredos', () => {
  it('o token não aparece em log, alerta, métrica ou erro', async () => {
    const h = harness();
    const errors: BridgeError[] = [];
    const echo = 'shpat_token_secreto_1';
    // Sucesso com versão diferente (gera log e alerta), depois limite, falha e recusas.
    h.script.push(ok(cost(10, 900, 50), { 'x-shopify-api-version': '2027-01' }));
    await h.client.graphql(STORE, QUERY, { cursor: null });
    h.script.push(gqlError('THROTTLED', `Throttled ${echo}`, cost(10, 0, 50)), new Response(echo, { status: 500 }), ok());
    await h.client.graphql(STORE, QUERY);
    h.script.push(gqlError(null, `token recebido: ${echo}`));
    errors.push(await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected'));
    h.script.push(json(200, { data: DATA, errors: [{ message: `aviso com ${echo}` }] }));
    await h.client.graphql(STORE, QUERY);
    h.script.push(json(401, { errors: echo }), json(401, { errors: 'shpat_token_secreto_2' }));
    errors.push(await rejection(h.client.graphql(STORE, QUERY), 'upstream_rejected'));

    assert.ok(h.logLines.length >= 5, 'esperava linhas de log capturadas');
    assert.equal(h.alerts.length, 1);
    const visible = [
      h.logLines.join('\n'),
      JSON.stringify(h.alerts),
      h.metrics.render(),
      ...errors.map((err) => `${err.message} ${JSON.stringify(err.details)} ${String(err.stack)}`),
    ].join('\n');
    assert.ok(!visible.includes('shpat_token_secreto'), 'o token vazou');
    assert.match(JSON.stringify(errors[0]?.details), /\[redigido\]/);
  });
});
