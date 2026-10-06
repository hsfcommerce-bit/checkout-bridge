import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DestinationStream } from 'pino';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createStorefrontClient } from '../src/shopify/storefront.ts';
import { BridgeError as BridgeErrorClass, isBridgeError } from '../src/types.ts';
import type { Alert, BridgeError, BridgeErrorCode, CartCreateInput, Metrics, NewStore, Store } from '../src/types.ts';
import { makeStore, setup } from './db-helpers.ts';

/** Valores marcados para os testes de sigilo: não podem aparecer em log, erro ou alerta. */
const TOKEN = 'shpat_token_SECRETO_123';
const CART_KEY = 'CHAVE_SECRETA_DO_CARRINHO';
const BUYER_IP = '203.0.113.7';

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface LineSpec {
  variantId: string;
  quantity: number;
  price?: string;
  availableForSale?: boolean;
}

function cartBody(lines: LineSpec[] = [{ variantId: '9001', quantity: 2 }], extra: Record<string, unknown> = {}): unknown {
  const nodes = lines.map((line, i) => ({
    id: `gid://shopify/CartLine/linha-${i}?cart=c1-abc`,
    quantity: line.quantity,
    cost: { amountPerQuantity: { amount: line.price ?? '39.90', currencyCode: 'BRL' } },
    merchandise: { id: `gid://shopify/ProductVariant/${line.variantId}`, availableForSale: line.availableForSale ?? true },
  }));
  return {
    data: {
      cartCreate: {
        cart: {
          id: `gid://shopify/Cart/c1-abc?key=${CART_KEY}`,
          checkoutUrl: `https://loja-checkout.myshopify.com/cart/c/c1-abc?key=${CART_KEY}`,
          totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
          cost: {
            subtotalAmount: { amount: '79.80', currencyCode: 'BRL' },
            totalAmount: { amount: '84.80', currencyCode: 'BRL' },
          },
          lines: { nodes },
          discountCodes: [],
        },
        userErrors: [],
        warnings: [],
        ...extra,
      },
    },
  };
}

function topError(code: string | null, message: string, extensions: Record<string, unknown> = {}): Response {
  return json({ errors: [{ message, extensions: code === null ? extensions : { code, ...extensions } }] });
}

function harness(storeOverrides: Partial<NewStore> = {}, opts: { timeoutMs?: number; captureLogs?: boolean } = {}) {
  const ctx = setup();
  const store = makeStore(ctx.repos, 'checkout', storeOverrides);
  const calls: Call[] = [];
  const script: Step[] = [];
  const alerts: Alert[] = [];
  const sleeps: number[] = [];
  const incs: Array<{ name: string; result: string | undefined }> = [];
  const gauges: Array<{ name: string; value: number; store: string | undefined }> = [];
  const observed: string[] = [];
  const logLines: string[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const safeInit = init ?? {};
    const body = JSON.parse(String(safeInit.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({
      url: String(input),
      init: safeInit,
      headers: { ...(safeInit.headers as Record<string, string>) },
      query: body.query,
      variables: body.variables,
    });
    const step = script.shift();
    if (step === undefined) throw new Error('chamada de fetch fora do roteiro');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(safeInit) : step;
  }) as typeof fetch;

  const metrics: Metrics = {
    inc: (name, labels) => void incs.push({ name, result: labels?.result }),
    observe: (name) => void observed.push(name),
    gauge: (name, value, labels) => void gauges.push({ name, value, store: labels?.store }),
    render: () => '',
  };
  const destination = { write: (line: string) => void logLines.push(line) } as DestinationStream;
  const logger = opts.captureLogs
    ? createLogger({ level: 'trace', env: 'test', destination })
    : createLogger({ level: 'silent', env: 'test' });

  const client = createStorefrontClient({
    stores: ctx.repos.stores,
    config: testConfig({ upstreamTimeoutMs: opts.timeoutMs ?? 2000 }),
    logger,
    metrics,
    alerter: { notify: (alert) => void alerts.push(alert) },
    fetchImpl,
    clock: ctx.clock,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });

  const results = (): Array<string | undefined> =>
    incs.filter((i) => i.name === 'bridge_storefront_requests_total').map((i) => i.result);

  return { ...ctx, store, client, calls, script, alerts, sleeps, incs, gauges, observed, logLines, results };
}

const INPUT: CartCreateInput = { lines: [{ variantId: '9001', quantity: 2 }], attributes: [] };

async function failure(promise: Promise<unknown>, code: BridgeErrorCode): Promise<BridgeError> {
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

function privateStore(): Partial<NewStore> {
  return { storefrontAuthMode: 'private_token', storefrontToken: TOKEN };
}

/** Alertas de userError determinístico (regra de quantidade, plano de venda, validação...). */
function userErrorAlerts(alerts: Alert[]): Alert[] {
  return alerts.filter((a) => a.key.startsWith('storefront_user_errors:'));
}

describe('storefront: autenticação e cabeçalhos', () => {
  it('tokenless: POST no endpoint versionado, sem cabeçalho de autenticação nem de IP', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody()));
    await h.client.createCart(h.store, { ...INPUT, buyerIp: BUYER_IP });

    const call = h.calls[0];
    assert.ok(call);
    assert.equal(call.url, `https://${h.store.shopDomain}/api/2026-10/graphql.json`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual');
    assert.deepEqual(Object.keys(call.headers).sort(), ['Accept', 'Content-Type']);
    assert.equal(call.headers['Content-Type'], 'application/json');
  });

  it('public_token: X-Shopify-Storefront-Access-Token, sem IP do comprador', async () => {
    const h = harness({ storefrontAuthMode: 'public_token', storefrontToken: TOKEN });
    h.script.push(json(cartBody()));
    await h.client.createCart(h.store, { ...INPUT, buyerIp: BUYER_IP });

    const headers = h.calls[0]?.headers ?? {};
    assert.equal(headers['X-Shopify-Storefront-Access-Token'], TOKEN);
    assert.equal('Shopify-Storefront-Private-Token' in headers, false);
    assert.equal('Shopify-Storefront-Buyer-IP' in headers, false);
  });

  it('private_token: token privado e IP do comprador quando o IP é válido (v4 e v6)', async () => {
    const h = harness(privateStore());
    h.script.push(json(cartBody()), json(cartBody()));
    await h.client.createCart(h.store, { ...INPUT, buyerIp: BUYER_IP });
    await h.client.createCart(h.store, { ...INPUT, buyerIp: '2001:db8::1' });

    const first = h.calls[0]?.headers ?? {};
    assert.equal(first['Shopify-Storefront-Private-Token'], TOKEN);
    assert.equal(first['Shopify-Storefront-Buyer-IP'], BUYER_IP);
    assert.equal('X-Shopify-Storefront-Access-Token' in first, false);
    assert.equal(h.calls[1]?.headers['Shopify-Storefront-Buyer-IP'], '2001:db8::1');
  });

  it('private_token: sem IP, ou com IP malformado, o cabeçalho de IP é omitido (nunca inventado)', async () => {
    const h = harness(privateStore());
    const candidates: Array<string | null | undefined> = [undefined, null, '', 'desconhecido', '203.0.113.7, 10.0.0.1', '999.1.1.1', ' 203.0.113.7'];
    for (const buyerIp of candidates) {
      h.script.push(json(cartBody()));
      await h.client.createCart(h.store, { ...INPUT, buyerIp });
    }
    assert.equal(h.calls.length, candidates.length);
    for (const call of h.calls) {
      assert.equal(call.headers['Shopify-Storefront-Private-Token'], TOKEN);
      assert.equal('Shopify-Storefront-Buyer-IP' in call.headers, false);
    }
  });

  it('modo com token sem token guardado: upstream_rejected antes de qualquer chamada de rede', async () => {
    for (const mode of ['private_token', 'public_token'] as const) {
      const h = harness({ storefrontAuthMode: mode });
      const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      assert.equal(err.details.reason, 'missing_storefront_token');
      assert.equal(h.calls.length, 0);
      assert.equal(h.alerts.length, 1);
      assert.equal(h.alerts[0]?.key, `storefront_auth:${h.store.id}`);
    }
  });
});

describe('storefront: consulta e variáveis', () => {
  const CONSENT = { analytics: true, marketing: false, preferences: true, saleOfData: false };

  it('sem idioma nem consentimento: consulta sem @inContext, com a seleção completa', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody()));
    await h.client.createCart(h.store, INPUT);

    const call = h.calls[0];
    assert.ok(call);
    assert.equal(call.query.includes('@inContext'), false);
    assert.match(call.query, /cartCreate\(input: \$input\)/);
    assert.match(call.query, /lines\(first: \$first\)/);
    for (const field of ['checkoutUrl', 'totalQuantity', 'subtotalAmount', 'totalAmount', 'amountPerQuantity', 'availableForSale', 'discountCodes { code applicable }', 'userErrors { code field message }', 'warnings { code message target }']) {
      assert.ok(call.query.includes(field), `faltou ${field} na consulta`);
    }
    assert.deepEqual(Object.keys(call.variables).sort(), ['first', 'input']);
  });

  it('escolhe a variante da consulta conforme idioma e consentimento', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody()), json(cartBody()), json(cartBody()));
    await h.client.createCart(h.store, { ...INPUT, language: 'pt-BR' });
    await h.client.createCart(h.store, { ...INPUT, consent: CONSENT });
    await h.client.createCart(h.store, { ...INPUT, language: 'pt-BR', consent: CONSENT });

    const [language, consent, both] = h.calls;
    assert.ok(language && consent && both);
    assert.ok(language.query.includes('@inContext(language: $language)'));
    assert.equal(language.variables.language, 'PT_BR');
    assert.equal('visitorConsent' in language.variables, false);

    assert.ok(consent.query.includes('@inContext(visitorConsent: $visitorConsent)'));
    assert.deepEqual(consent.variables.visitorConsent, CONSENT);
    assert.equal('language' in consent.variables, false);

    assert.ok(both.query.includes('@inContext(language: $language, visitorConsent: $visitorConsent)'));
    assert.equal(both.variables.language, 'PT_BR');
    assert.deepEqual(both.variables.visitorConsent, CONSENT);
  });

  it('valores da requisição nunca entram no texto da consulta', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody()));
    await h.client.createCart(h.store, {
      lines: [{ variantId: '9001', quantity: 2, attributes: [{ key: 'Gravação', value: 'TEXTO_UNICO_1' }] }],
      attributes: [{ key: 'utm_source', value: 'TEXTO_UNICO_2' }],
      countryCode: 'BR',
      discountCodes: ['CUPOM_UNICO_3'],
      language: 'pt-BR',
    });
    const query = h.calls[0]?.query ?? '';
    for (const value of ['9001', 'TEXTO_UNICO_1', 'TEXTO_UNICO_2', 'CUPOM_UNICO_3', 'PT_BR', '"BR"']) {
      assert.equal(query.includes(value), false, `${value} apareceu no texto da consulta`);
    }
  });

  it('monta CartInput: gid da variante, atributos, país e cupons só quando presentes; $first = nº de linhas', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody([{ variantId: '9001', quantity: 2 }, { variantId: '9002', quantity: 1 }])), json(cartBody()));
    await h.client.createCart(h.store, {
      lines: [
        { variantId: '9001', quantity: 2, attributes: [{ key: 'Gravação', value: 'Ana' }] },
        { variantId: '9002', quantity: 1 },
      ],
      attributes: [{ key: 'bridge_session', value: 'cs_1' }],
      countryCode: 'br',
      discountCodes: ['BEMVINDO'],
    });
    await h.client.createCart(h.store, { ...INPUT, discountCodes: [] });

    assert.equal(h.calls[0]?.variables.first, 2);
    assert.deepEqual(h.calls[0]?.variables.input, {
      lines: [
        { merchandiseId: 'gid://shopify/ProductVariant/9001', quantity: 2, attributes: [{ key: 'Gravação', value: 'Ana' }] },
        { merchandiseId: 'gid://shopify/ProductVariant/9002', quantity: 1, attributes: [] },
      ],
      attributes: [{ key: 'bridge_session', value: 'cs_1' }],
      buyerIdentity: { countryCode: 'BR' },
      discountCodes: ['BEMVINDO'],
    });
    assert.equal(h.calls[1]?.variables.first, 1);
    assert.deepEqual(h.calls[1]?.variables.input, {
      lines: [{ merchandiseId: 'gid://shopify/ProductVariant/9001', quantity: 2, attributes: [] }],
      attributes: [],
    });
  });

  it('$first acompanha 250 linhas; entrada inválida falha antes da rede', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    const many = Array.from({ length: 250 }, (_, i) => ({ variantId: String(1000 + i), quantity: 1 }));
    h.script.push(json(cartBody(many)));
    const result = await h.client.createCart(h.store, { lines: many, attributes: [] });
    assert.equal(h.calls[0]?.variables.first, 250);
    assert.equal(result.lines.length, 250);

    const tooMany = [...many, { variantId: '5', quantity: 1 }];
    await failure(h.client.createCart(h.store, { lines: tooMany, attributes: [] }), 'invalid_request');
    await failure(h.client.createCart(h.store, { lines: [], attributes: [] }), 'invalid_request');
    await failure(h.client.createCart(h.store, { lines: [{ variantId: 'abc', quantity: 1 }], attributes: [] }), 'invalid_request');
    await failure(h.client.createCart(h.store, { lines: [{ variantId: '9001', quantity: 0 }], attributes: [] }), 'invalid_request');
    await failure(h.client.createCart(h.store, { ...INPUT, countryCode: 'Brasil' }), 'invalid_request');
    assert.equal(h.calls.length, 1);
  });

  it('idioma: mapeia para LanguageCode e descarta o que não é tag de idioma', async () => {
    const cases: Array<[string, string | null]> = [
      ['pt-BR', 'PT_BR'],
      ['pt_br', 'PT_BR'],
      ['pt-PT', 'PT_PT'],
      ['zh-Hant-TW', 'ZH_TW'],
      ['en-US', 'EN'],
      ['es', 'ES'],
      ['fil', 'FIL'],
      ['', null],
      ['português', null],
      ['pt-BR; DROP', null],
      ['p', null],
    ];
    const h = harness({ storefrontAuthMode: 'tokenless' });
    for (const [language] of cases) {
      h.script.push(json(cartBody()));
      await h.client.createCart(h.store, { ...INPUT, language });
    }
    cases.forEach(([language, expected], i) => {
      const call = h.calls[i];
      assert.ok(call);
      if (expected === null) {
        assert.equal(call.query.includes('@inContext'), false, `"${language}" deveria ser descartado`);
        assert.equal('language' in call.variables, false);
      } else {
        assert.equal(call.variables.language, expected, `"${language}"`);
      }
    });
  });

  it('consentimento incompleto é descartado', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody()));
    const partial = { analytics: true, marketing: true } as unknown as CartCreateInput['consent'];
    await h.client.createCart(h.store, { ...INPUT, consent: partial });
    assert.equal(h.calls[0]?.query.includes('@inContext'), false);
  });

  it('erro GraphQL causado por idioma ou consentimento: repete UMA vez sem @inContext', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(
      topError('INVALID_VARIABLE', 'Variable $language of type LanguageCode was provided invalid value'),
      json(cartBody()),
    );
    const result = await h.client.createCart(h.store, { ...INPUT, language: 'xx', consent: CONSENT });

    assert.equal(result.lines.length, 1);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0]?.query.includes('@inContext'));
    assert.equal(h.calls[1]?.query.includes('@inContext'), false);
    assert.deepEqual(Object.keys(h.calls[1]?.variables ?? {}).sort(), ['first', 'input']);
    // Não é nova tentativa por indisponibilidade: sem espera e sem contar para o circuito.
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(h.results(), ['context_error', 'ok']);
  });

  it('argumento da diretiva recusado (nome em extensions) também cai na repetição sem @inContext', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(topError('argumentNotAccepted', 'Directive does not accept argument', { name: 'inContext', argumentName: 'visitorConsent' }), json(cartBody()));
    await h.client.createCart(h.store, { ...INPUT, consent: CONSENT });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]?.query.includes('@inContext'), false);
  });

  it('a repetição sem @inContext acontece uma vez só; outro erro GraphQL vira upstream_rejected', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(topError(null, 'Variable $language of type LanguageCode was provided invalid value'), topError(null, 'Field does not exist'));
    const err = await failure(h.client.createCart(h.store, { ...INPUT, language: 'xx' }), 'upstream_rejected');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(err.details.graphqlErrors, [{ code: null, message: 'Field does not exist' }]);

    // Erro sem relação com a diretiva: nenhuma repetição, mesmo com @inContext na consulta.
    const other = harness({ storefrontAuthMode: 'tokenless' });
    other.script.push(topError('MAX_COST_EXCEEDED', 'Query has complexity of 1200, which exceeds max complexity of 1000'));
    await failure(other.client.createCart(other.store, { ...INPUT, language: 'pt-BR' }), 'upstream_rejected');
    assert.equal(other.calls.length, 1);

    // Sem @inContext na consulta, um erro que cita "language" não provoca repetição.
    const plain = harness({ storefrontAuthMode: 'tokenless' });
    plain.script.push(topError(null, 'Something about language'));
    await failure(plain.client.createCart(plain.store, INPUT), 'upstream_rejected');
    assert.equal(plain.calls.length, 1);
  });
});

describe('storefront: tradução do resultado', () => {
  it('mapeia linhas, valores, avisos e cupons; o id do carrinho sai sem a chave', async () => {
    const h = harness(privateStore());
    const body = cartBody(
      [
        { variantId: '9001', quantity: 2, price: '39.90' },
        { variantId: '9002', quantity: 0, price: '10.00', availableForSale: false },
      ],
      {
        warnings: [
          { code: 'MERCHANDISE_OUT_OF_STOCK', message: 'Esgotado', target: 'gid://shopify/CartLine/linha-1?cart=c1-abc' },
          { code: 'DISCOUNT_NOT_FOUND', message: 'Cupom não existe', target: `gid://shopify/Cart/c1-abc?key=${CART_KEY}` },
        ],
      },
    ) as { data: { cartCreate: { cart: { discountCodes: unknown } } } };
    body.data.cartCreate.cart.discountCodes = [{ code: 'BEMVINDO', applicable: false }];
    h.script.push(json(body));

    const result = await h.client.createCart(h.store, {
      lines: [{ variantId: '9001', quantity: 2 }, { variantId: '9002', quantity: 1 }],
      attributes: [],
      discountCodes: ['BEMVINDO'],
    });

    assert.deepEqual(result, {
      cartId: 'gid://shopify/Cart/c1-abc',
      checkoutUrl: `https://loja-checkout.myshopify.com/cart/c/c1-abc?key=${CART_KEY}`,
      currency: 'BRL',
      subtotal: '79.80',
      total: '84.80',
      lines: [
        { lineId: 'gid://shopify/CartLine/linha-0?cart=c1-abc', variantId: '9001', quantity: 2, unitPrice: '39.90', currency: 'BRL', availableForSale: true },
        { lineId: 'gid://shopify/CartLine/linha-1?cart=c1-abc', variantId: '9002', quantity: 0, unitPrice: '10.00', currency: 'BRL', availableForSale: false },
      ],
      warnings: [
        { code: 'MERCHANDISE_OUT_OF_STOCK', message: 'Esgotado', target: 'gid://shopify/CartLine/linha-1?cart=c1-abc' },
        { code: 'DISCOUNT_NOT_FOUND', message: 'Cupom não existe', target: 'gid://shopify/Cart/c1-abc' },
      ],
      discountCodes: [{ code: 'BEMVINDO', applicable: false }],
    });
    assert.deepEqual(h.results(), ['ok']);
    assert.deepEqual(h.observed, ['bridge_storefront_request_ms']);
  });

  it('não julga o carrinho: linha faltando ou quantidade diferente é devolvida como veio', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody([{ variantId: '9001', quantity: 1 }])));
    const result = await h.client.createCart(h.store, {
      lines: [{ variantId: '9001', quantity: 2 }, { variantId: '9002', quantity: 1 }],
      attributes: [],
    });
    assert.deepEqual(result.lines.map((l) => [l.variantId, l.quantity]), [['9001', 1]]);
  });

  it('userErrors: upstream_rejected com code, field e message em details, sem nova tentativa', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    const userErrors = [{ code: 'INVALID', field: ['input', 'lines', '0', 'merchandiseId'], message: 'The merchandise with id gid://shopify/ProductVariant/9001 does not exist.' }];
    h.script.push(json({ data: { cartCreate: { cart: null, userErrors, warnings: [] } } }));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
    assert.deepEqual(err.details, { userErrors });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.results(), ['user_errors']);
    assert.deepEqual(userErrorAlerts(h.alerts), []);
  });

  // userErrors determinísticos (SHOP-03): o mesmo carrinho vai ser recusado de novo, então a
  // mensagem pública não pode mandar tentar outra vez, e o lojista precisa ficar sabendo.
  const DETERMINISTIC: Array<{ codes: string[]; kind: string; bridgeCode: BridgeErrorCode }> = [
    { codes: ['MAXIMUM_EXCEEDED', 'MINIMUM_NOT_MET', 'INVALID_INCREMENT'], kind: 'quantity_rule', bridgeCode: 'quantity_exceeded' },
    { codes: ['VARIANT_REQUIRES_SELLING_PLAN', 'SELLING_PLAN_NOT_APPLICABLE'], kind: 'selling_plan', bridgeCode: 'selling_plan_unsupported' },
    { codes: ['MERCHANDISE_NOT_APPLICABLE', 'INVALID_MERCHANDISE_LINE'], kind: 'merchandise', bridgeCode: 'variant_unavailable' },
    { codes: ['VALIDATION_CUSTOM'], kind: 'validation_custom', bridgeCode: 'checkout_validation' },
  ];

  for (const { codes, kind, bridgeCode } of DETERMINISTIC) {
    it(`userErrors ${codes.join('/')}: ${bridgeCode} sem nova tentativa, com alerta ${kind} ao lojista`, async () => {
      for (const code of codes) {
        const h = harness({ storefrontAuthMode: 'tokenless' });
        const userErrors = [{ code, field: ['input', 'lines', '0', 'quantity'], message: `Recusado (${code}).` }];
        h.script.push(json({ data: { cartCreate: { cart: null, userErrors, warnings: [] } } }));
        const err = await failure(h.client.createCart(h.store, INPUT), bridgeCode);
        assert.notEqual(err.publicMessage, new BridgeErrorClass('upstream_rejected').publicMessage, code);
        assert.deepEqual(err.details, { userErrors, kind });
        assert.equal(h.calls.length, 1, code);
        assert.deepEqual(h.sleeps, []);
        assert.deepEqual(h.results(), ['user_errors']);
        const alerts = userErrorAlerts(h.alerts);
        assert.equal(alerts.length, 1, code);
        assert.equal(alerts[0]?.key, `storefront_user_errors:${h.store.id}:${kind}`);
        assert.equal(alerts[0]?.severity, 'warning');
        assert.ok(alerts[0]?.title.includes(h.store.shopDomain));
        assert.deepEqual(alerts[0]?.detail, {
          storeId: h.store.id,
          shopDomain: h.store.shopDomain,
          kind,
          code: bridgeCode,
          userErrors,
        });
      }
    });
  }

  it('userErrors: o primeiro código conhecido decide; código desconhecido ou nulo fica upstream_rejected sem alerta', async () => {
    const mixed = harness({ storefrontAuthMode: 'tokenless' });
    const userErrors = [
      { code: 'INVALID', field: ['input'], message: 'x' },
      { code: 'MAXIMUM_EXCEEDED', field: ['input', 'lines', '0', 'quantity'], message: 'max' },
      { code: 'VALIDATION_CUSTOM', field: null, message: 'custom' },
    ];
    mixed.script.push(json({ data: { cartCreate: { cart: null, userErrors, warnings: [] } } }));
    const err = await failure(mixed.client.createCart(mixed.store, INPUT), 'quantity_exceeded');
    assert.deepEqual(err.details, { userErrors, kind: 'quantity_rule' });
    assert.equal(userErrorAlerts(mixed.alerts).length, 1);

    for (const code of ['CART_TOO_LARGE', 'LESS_THAN', 'SERVICE_UNAVAILABLE', 'NOVO_CODIGO', null]) {
      const h = harness({ storefrontAuthMode: 'tokenless' });
      h.script.push(json({ data: { cartCreate: { cart: null, userErrors: [{ code, field: null, message: 'x' }], warnings: [] } } }));
      const unknown = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      assert.deepEqual(unknown.details, { userErrors: [{ code, field: null, message: 'x' }] });
      assert.deepEqual(userErrorAlerts(h.alerts), [], String(code));
    }
  });

  it('userErrors VALIDATION_CUSTOM: a mensagem da Function vai ao alerta sem chave de carrinho nem token', async () => {
    const h = harness(privateStore());
    const message = `Limite por cliente. ver /cart/c/tok?key=${CART_KEY} token=${TOKEN}`;
    h.script.push(json({ data: { cartCreate: { cart: null, userErrors: [{ code: 'VALIDATION_CUSTOM', field: null, message }], warnings: [] } } }));
    const err = await failure(h.client.createCart(h.store, INPUT), 'checkout_validation');
    const alert = userErrorAlerts(h.alerts)[0];
    assert.ok(alert);
    const texts = [JSON.stringify(err.details), JSON.stringify(alert.detail), alert.title];
    for (const text of texts) {
      assert.ok(!text.includes(CART_KEY), text);
      assert.ok(!text.includes(TOKEN), text);
    }
    assert.ok(JSON.stringify(alert.detail).includes('Limite por cliente'));
  });

  it('carrinho nulo, checkoutUrl que não é https e formato inesperado: upstream_rejected', async () => {
    const nullCart = { data: { cartCreate: { cart: null, userErrors: [], warnings: [] } } };
    const http = cartBody() as { data: { cartCreate: { cart: { checkoutUrl: string } } } };
    http.data.cartCreate.cart.checkoutUrl = 'http://loja-checkout.myshopify.com/cart/c/c1-abc';
    const relative = cartBody() as { data: { cartCreate: { cart: { checkoutUrl: string } } } };
    relative.data.cartCreate.cart.checkoutUrl = '/cart/c/c1-abc';
    const script = cartBody() as { data: { cartCreate: { cart: { checkoutUrl: string } } } };
    script.data.cartCreate.cart.checkoutUrl = 'javascript:alert(1)';
    const notVariant = cartBody() as { data: { cartCreate: { cart: { lines: { nodes: Array<{ merchandise: unknown }> } } } } };
    const firstNode = notVariant.data.cartCreate.cart.lines.nodes[0];
    assert.ok(firstNode);
    firstNode.merchandise = {};

    const cases: Array<[unknown, string]> = [
      [nullCart, 'null_cart'],
      [http, 'invalid_checkout_url'],
      [relative, 'invalid_checkout_url'],
      [script, 'invalid_checkout_url'],
      [notVariant, 'unexpected_response'],
      [{ data: null }, 'unexpected_response'],
      [{ data: { cartCreate: null } }, 'unexpected_response'],
    ];
    for (const [body, reason] of cases) {
      const h = harness({ storefrontAuthMode: 'tokenless' });
      h.script.push(json(body));
      const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      assert.equal(err.details.reason, reason);
      assert.equal(h.calls.length, 1);
    }
  });

  it('página de linhas cheia com total maior que o lido: leitura incompleta é recusada', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    const body = cartBody() as { data: { cartCreate: { cart: { totalQuantity: number } } } };
    body.data.cartCreate.cart.totalQuantity = 5;
    h.script.push(json(body));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
    assert.equal(err.details.reason, 'cart_lines_truncated');
  });
});

describe('storefront: erros e novas tentativas', () => {
  it('falha de rede: até 2 novas tentativas com backoff e jitter, depois upstream_unavailable', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'network' });
    assert.equal(h.calls.length, 3);
    // random() fixo em 0.5: metade de 200 ms e metade de 400 ms.
    assert.deepEqual(h.sleeps, [100, 200]);
    assert.deepEqual(h.results(), ['network', 'network', 'network']);
  });

  it('falha de rede seguida de sucesso devolve o carrinho', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(new TypeError('fetch failed'), json(cartBody()));
    const result = await h.client.createCart(h.store, INPUT);
    assert.equal(result.cartId, 'gid://shopify/Cart/c1-abc');
    assert.equal(h.calls.length, 2);
  });

  it('timeout: 3 chamadas e upstream_unavailable', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' }, { timeoutMs: 3 });
    const hang = (init: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    h.script.push(hang, hang, hang);
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'timeout' });
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.results(), ['timeout', 'timeout', 'timeout']);
  });

  it('5xx: 3 chamadas, respeita Retry-After, depois upstream_unavailable com o status', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json({}, 503, { 'retry-after': '2' }), json({}, 502), json({}, 500));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { status: 500 });
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.sleeps, [2000, 200]);
  });

  it('corpo 200 ilegível e INTERNAL_SERVER_ERROR no corpo contam como indisponibilidade', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(new Response('<html>erro</html>', { status: 200 }), topError('INTERNAL_SERVER_ERROR', 'Internal error'), json(cartBody()));
    await h.client.createCart(h.store, INPUT);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.results(), ['bad_response', 'server_error', 'ok']);
  });

  it('HTTP 430: sem nova tentativa, details { status: 430 } e alerta sugerindo token privado com IP', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(new Response('', { status: 430 }));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { status: 430 });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `storefront_430:${h.store.id}`);
    assert.match(h.alerts[0]?.title ?? '', /token privado/);
    assert.match(h.alerts[0]?.title ?? '', /Shopify-Storefront-Buyer-IP/);
    assert.deepEqual(h.results(), ['security_rejection']);
  });

  it('THROTTLED com HTTP 200: uma nova tentativa após cerca de 1 s', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(topError('THROTTLED', 'Throttled'), json(cartBody()));
    await h.client.createCart(h.store, INPUT);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.sleeps, [1000]);

    const again = harness({ storefrontAuthMode: 'tokenless' });
    again.script.push(topError('THROTTLED', 'Throttled'), topError('THROTTLED', 'Throttled'), json(cartBody()));
    const err = await failure(again.client.createCart(again.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { reason: 'throttled' });
    assert.equal(again.calls.length, 2);
    assert.deepEqual(again.sleeps, [1000]);
  });

  it('ACCESS_DENIED e HTTP 401/403: upstream_rejected com alerta, sem nova tentativa', async () => {
    const responses: Array<() => Response> = [
      () => topError('ACCESS_DENIED', 'Access denied for cartCreate field.'),
      () => new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401 }),
      () => new Response('', { status: 403 }),
    ];
    for (const make of responses) {
      const h = harness(privateStore());
      h.script.push(make());
      await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      assert.equal(h.calls.length, 1);
      assert.equal(h.alerts.length, 1);
      assert.equal(h.alerts[0]?.key, `storefront_auth:${h.store.id}`);
      assert.equal(h.alerts[0]?.severity, 'critical');
      assert.deepEqual(h.results(), ['auth']);
    }
  });

  it('HTTP 402, 404, 423, redirecionamento e SHOP_INACTIVE: upstream_rejected sem nova tentativa', async () => {
    for (const status of [402, 404, 423, 302, 400]) {
      const h = harness({ storefrontAuthMode: 'tokenless' });
      h.script.push(new Response(null, { status, headers: status === 302 ? { location: 'https://outro.example/' } : {} }));
      const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      assert.deepEqual(err.details, { status });
      assert.equal(h.calls.length, 1);
      if (status === 402 || status === 423) {
        // Loja congelada ou bloqueada: o circuito não cobre, então o alerta sai daqui.
        assert.equal(h.alerts.length, 1, `HTTP ${status} deve alertar`);
        assert.equal(h.alerts[0]?.key, `storefront_shop_state:${h.store.id}`);
        assert.equal(h.alerts[0]?.severity, 'critical');
        assert.equal(h.alerts[0]?.detail?.['status'], status);
        assert.equal(h.alerts[0]?.detail?.['shopDomain'], h.store.shopDomain);
      } else {
        // 404, 3xx e 400 são configuração errada, já visível no relatório de conexão.
        assert.equal(h.alerts.length, 0, `HTTP ${status} não deve alertar`);
      }
    }
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(topError('SHOP_INACTIVE', 'Shop is inactive'));
    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
    assert.deepEqual(err.details, { code: 'SHOP_INACTIVE' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.key, `storefront_shop_state:${h.store.id}`);
    assert.equal(h.alerts[0]?.severity, 'critical');
    assert.equal(h.alerts[0]?.detail?.['code'], 'SHOP_INACTIVE');
  });
});

describe('storefront: circuit breaker por loja', () => {
  const reject430 = (): Response => new Response('', { status: 430 });
  const circuitAlerts = (alerts: Alert[]): string[] =>
    alerts.filter((a) => a.key.startsWith('storefront_circuit:')).map((a) => a.key.split(':')[2] ?? '');

  async function openCircuit(h: ReturnType<typeof harness>, store: Store): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      h.script.push(reject430());
      await failure(h.client.createCart(store, INPUT), 'upstream_unavailable');
    }
  }

  it('abre após 5 falhas de disponibilidade seguidas e recusa sem tocar a rede', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    await openCircuit(h, h.store);
    assert.equal(h.calls.length, 5);
    assert.deepEqual(circuitAlerts(h.alerts), ['open']);
    const openAlert = h.alerts.find((a) => a.key === `storefront_circuit:${h.store.id}:open`);
    assert.equal(openAlert?.severity, 'critical');
    assert.deepEqual(h.gauges.at(-1), { name: 'bridge_storefront_circuit_state', value: 2, store: h.store.id });

    const err = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(err.details, { circuit: 'open' });
    assert.equal(h.calls.length, 5);
    assert.equal(h.results().at(-1), 'circuit_open');

    // Ainda aberto um instante antes dos 30 s.
    h.clock.advance(29_999);
    await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.equal(h.calls.length, 5);
  });

  it('recupera: após 30 s uma chamada de teste bem-sucedida fecha o circuito', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    await openCircuit(h, h.store);
    h.clock.advance(30_000);
    h.script.push(json(cartBody()), json(cartBody()));

    const result = await h.client.createCart(h.store, INPUT);
    assert.equal(result.lines.length, 1);
    assert.deepEqual(circuitAlerts(h.alerts), ['open', 'half_open', 'closed']);
    assert.deepEqual(h.gauges.map((g) => g.value), [2, 1, 0]);

    await h.client.createCart(h.store, INPUT);
    assert.equal(h.calls.length, 7);
  });

  it('chamada de teste que falha reabre o circuito por mais 30 s', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    await openCircuit(h, h.store);
    h.clock.advance(30_000);
    h.script.push(reject430());
    const trial = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(trial.details, { status: 430 });
    assert.equal(h.calls.length, 6);

    const blocked = await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.deepEqual(blocked.details, { circuit: 'open' });
    assert.equal(h.calls.length, 6);
    assert.deepEqual(circuitAlerts(h.alerts), ['open', 'half_open', 'open']);
  });

  it('uma chamada com 3 tentativas falhas conta como UMA falha; sucesso zera a sequência', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    for (let i = 0; i < 4; i += 1) {
      h.script.push(json({}, 500), json({}, 500), json({}, 500));
      await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    }
    assert.equal(h.calls.length, 12);
    assert.deepEqual(circuitAlerts(h.alerts), []);

    h.script.push(json(cartBody()));
    await h.client.createCart(h.store, INPUT);
    for (let i = 0; i < 4; i += 1) {
      h.script.push(reject430());
      await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    }
    assert.deepEqual(circuitAlerts(h.alerts), []);
  });

  it('recusas da Shopify (userErrors, 401, 404, token ausente) não contam para o circuito', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    const userErrors = { data: { cartCreate: { cart: null, userErrors: [{ code: 'INVALID', field: ['input'], message: 'x' }], warnings: [] } } };
    for (let i = 0; i < 3; i += 1) {
      h.script.push(json(userErrors), new Response('', { status: 401 }), new Response('', { status: 404 }));
      await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
      await failure(h.client.createCart(h.store, INPUT), 'upstream_rejected');
    }
    assert.equal(h.calls.length, 9);
    assert.deepEqual(circuitAlerts(h.alerts), []);
    assert.deepEqual(h.gauges, []);
  });

  it('o circuito é por loja: a loja B continua sendo chamada com o circuito da loja A aberto', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    const other = makeStore(h.repos, 'checkout', { storefrontAuthMode: 'tokenless' });
    await openCircuit(h, h.store);

    h.script.push(json(cartBody()));
    await h.client.createCart(other, INPUT);
    assert.equal(h.calls.at(-1)?.url, `https://${other.shopDomain}/api/2026-10/graphql.json`);

    // Com o circuito de A aberto, a chamada para A falha; nenhuma requisição vai para outra loja.
    const before = h.calls.length;
    await failure(h.client.createCart(h.store, INPUT), 'upstream_unavailable');
    assert.equal(h.calls.length, before);
  });
});

describe('storefront: sigilo', () => {
  it('token, chave do carrinho e IP do comprador não aparecem em log, erro, details nem alerta', async () => {
    const h = harness(privateStore(), { captureLogs: true });
    const input: CartCreateInput = { ...INPUT, buyerIp: BUYER_IP, language: 'xx' };
    const leak = `id gid://shopify/Cart/c1-abc?key=${CART_KEY} token ${TOKEN}`;
    const errors: BridgeError[] = [];

    h.script.push(topError(null, 'Variable $language of type LanguageCode was provided invalid value'), json(cartBody()));
    await h.client.createCart(h.store, input);

    h.script.push(json({ data: { cartCreate: { cart: null, userErrors: [{ code: 'INVALID', field: ['input'], message: leak }], warnings: [] } } }));
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_rejected'));
    h.script.push(topError('WEIRD', leak));
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_rejected'));
    assert.equal(h.script.length, 0);
    h.script.push(topError('ACCESS_DENIED', leak));
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_rejected'));
    h.script.push(new Response(leak, { status: 401 }));
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_rejected'));
    h.script.push(new Response(leak, { status: 500 }), new TypeError('fetch failed'), new Response(leak, { status: 503 }));
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_unavailable'));
    for (let i = 0; i < 5; i += 1) {
      h.script.push(new Response(leak, { status: 430 }));
      errors.push(await failure(h.client.createCart(h.store, input), 'upstream_unavailable'));
    }
    errors.push(await failure(h.client.createCart(h.store, input), 'upstream_unavailable'));

    const exposed = JSON.stringify({
      errors: errors.map((e) => ({ message: e.message, details: e.details, stack: e.stack })),
      alerts: h.alerts,
      logs: h.logLines,
    });
    assert.ok(h.logLines.length > 0, 'o teste precisa de linhas de log para valer');
    assert.ok(h.alerts.length >= 3);
    for (const secret of [TOKEN, CART_KEY, BUYER_IP]) {
      assert.equal(exposed.includes(secret), false, `${secret} vazou`);
    }
    // O aviso de userErrors continua útil depois da limpeza.
    const first = errors[0]?.details.userErrors as Array<{ message: string }> | undefined;
    assert.match(first?.[0]?.message ?? '', /key=\[redigido\] token \[redigido\]/);
  });

  it('mensagem de aviso do carrinho com a chave é limpa antes de ser devolvida', async () => {
    const h = harness({ storefrontAuthMode: 'tokenless' });
    h.script.push(json(cartBody(undefined, { warnings: [{ code: 'X', message: `veja /cart/c/c1-abc?key=${CART_KEY}`, target: null }] })));
    const result = await h.client.createCart(h.store, INPUT);
    assert.deepEqual(result.warnings, [{ code: 'X', message: 'veja /cart/c/c1-abc?key=[redigido]', target: null }]);
  });
});
