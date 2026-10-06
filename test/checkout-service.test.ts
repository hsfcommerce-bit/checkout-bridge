import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCheckoutService } from '../src/checkout/service.ts';
import { createLogger } from '../src/lib/logger.ts';
import { BridgeError as BridgeErrorClass, isBridgeError } from '../src/types.ts';
import type {
  Alert,
  Alerter,
  BridgeError,
  BridgeErrorCode,
  CartCreateInput,
  CartCreateResult,
  CheckoutRequest,
  Link,
  MetricLabels,
  Metrics,
  NewLink,
  RequestContext,
  Store,
  StorefrontClient,
} from '../src/types.ts';
import { makeMapping, makeStore, makeVariant, setup, tableCount } from './db-helpers.ts';

const logger = createLogger({ level: 'silent', env: 'test' });

const CTX: RequestContext = { requestId: 'req_teste', buyerIp: '203.0.113.9', userAgent: 'Mozilla/5.0 (teste)' };
const CART_URL = 'https://checkout.loja.com.br/cart/c/tok123?key=segredo';

interface FakeMetrics extends Metrics {
  incs: Array<{ name: string; labels: MetricLabels; value: number }>;
  observes: Array<{ name: string; value: number; labels: MetricLabels }>;
  count(name: string, labels?: MetricLabels): number;
}

function fakeMetrics(): FakeMetrics {
  const metrics: FakeMetrics = {
    incs: [],
    observes: [],
    inc(name, labels = {}, value = 1) {
      metrics.incs.push({ name, labels, value });
    },
    observe(name, value, labels = {}) {
      metrics.observes.push({ name, value, labels });
    },
    gauge() {},
    render: () => '',
    count(name, labels = {}) {
      return metrics.incs
        .filter((m) => m.name === name && Object.entries(labels).every(([k, v]) => m.labels[k] === v))
        .reduce((sum, m) => sum + m.value, 0);
    },
  };
  return metrics;
}

interface FakeAlerter extends Alerter {
  alerts: Alert[];
}

function fakeAlerter(): FakeAlerter {
  const alerter: FakeAlerter = {
    alerts: [],
    notify(alert) {
      alerter.alerts.push(alert);
    },
  };
  return alerter;
}

type CartHandler = (store: Store, input: CartCreateInput) => Promise<CartCreateResult> | CartCreateResult;

interface FakeStorefront extends StorefrontClient {
  calls: Array<{ store: Store; input: CartCreateInput }>;
  /** Próximas respostas, consumidas em ordem; esgotadas, vale `fallback`. */
  queue: CartHandler[];
  fallback: CartHandler;
}

/**
 * Carrinho que devolve exatamente o que foi pedido, com o preço do catálogo do checkout. A
 * URL fica no domínio da loja que recebeu a chamada, como na Shopify (CART_URL para a loja
 * checkout do harness).
 */
function echoCart(prices: Record<string, string>, currency = 'BRL'): CartHandler {
  return (store, input) => {
    const lines = input.lines.map((line, i) => ({
      lineId: `gid://shopify/CartLine/${i + 1}`,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: prices[line.variantId] ?? '39.90',
      currency,
      availableForSale: true,
    }));
    return {
      cartId: 'gid://shopify/Cart/tok123?key=segredo',
      checkoutUrl: `https://${store.publicDomain ?? store.shopDomain}/cart/c/tok123?key=segredo`,
      currency,
      subtotal: '79.80',
      total: '79.80',
      lines,
      warnings: [],
      discountCodes: (input.discountCodes ?? []).map((code) => ({ code, applicable: true })),
    };
  };
}

function fakeStorefront(fallback: CartHandler): FakeStorefront {
  const storefront: FakeStorefront = {
    calls: [],
    queue: [],
    fallback,
    async createCart(store, input) {
      storefront.calls.push({ store, input });
      const handler = storefront.queue.shift() ?? storefront.fallback;
      return handler(store, input);
    },
  };
  return storefront;
}

interface HarnessOptions {
  link?: Partial<NewLink>;
  sleepHook?: (ms: number, call: number) => void | Promise<void>;
}

function harness(opts: HarnessOptions = {}) {
  const t = setup();
  const vitrine = makeStore(t.repos, 'vitrine', { proxyPath: '/apps/bridge' });
  const checkout = makeStore(t.repos, 'checkout', { publicDomain: 'checkout.loja.com.br' });
  const link: Link = t.repos.links.create({
    vitrineStoreId: vitrine.id,
    checkoutStoreId: checkout.id,
    kind: 'default',
    parityPolicy: 'block',
    priceToleranceBps: 0,
    maxQuantityPerLine: 50,
    maxLines: 50,
    strategy: 'storefront_cart',
    allowPermalinkFallback: false,
    ...opts.link,
  });
  // Vitrine 1 -> checkout 91, vitrine 2 -> checkout 92; mesmo preço dos dois lados.
  t.repos.catalog.upsertVariants([
    makeVariant(vitrine.id, '1', { productId: '100' }),
    makeVariant(vitrine.id, '2', { productId: '100', price: '59.90' }),
    makeVariant(checkout.id, '91', { productId: '900' }),
    makeVariant(checkout.id, '92', { productId: '900', price: '59.90' }),
  ]);
  t.repos.mappings.setManual(makeMapping(vitrine.id, checkout.id, '1'));
  t.repos.mappings.setManual(makeMapping(vitrine.id, checkout.id, '2'));

  const storefront = fakeStorefront(echoCart({ '91': '39.90', '92': '59.90' }));
  const metrics = fakeMetrics();
  const alerter = fakeAlerter();
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    await opts.sleepHook?.(ms, sleeps.length);
  };
  const service = createCheckoutService({
    repos: t.repos,
    storefront,
    config: { sessionTtlMinutes: 15, encryptionKey: Buffer.alloc(32, 7) },
    logger,
    metrics,
    alerter,
    clock: t.clock,
    sleep,
  });
  const request = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    shopDomain: vitrine.shopDomain,
    lines: [{ variantId: '1', quantity: 2 }],
    cartToken: 'carrinho-1',
    country: 'BR',
    ...overrides,
  });
  return { ...t, vitrine, checkout, link, storefront, metrics, alerter, sleeps, service, request };
}

type Harness = ReturnType<typeof harness>;

async function expectCode(promise: Promise<unknown>, code: BridgeErrorCode): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(isBridgeError(err), `esperava BridgeError('${code}'), veio: ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`esperava BridgeError('${code}'), mas a promessa resolveu`);
}

function lastSession(h: Harness) {
  const sessions = h.repos.sessions.list({ limit: 10, offset: 0 });
  assert.equal(sessions.length, 1, 'esperava exatamente uma sessão');
  return sessions[0]!;
}

function attr(input: CartCreateInput, key: string): string | undefined {
  return input.attributes.find((a) => a.key === key)?.value;
}

describe('createCheckout: caminho feliz', () => {
  it('cria o carrinho na loja checkout, grava a sessão e devolve a URL', async () => {
    const h = harness();
    const response = await h.service.createCheckout(
      h.request({
        lines: [
          { variantId: '1', quantity: 2 },
          { variantId: '2', quantity: 1 },
        ],
        attribution: { utm_source: 'meta', fbclid: 'clique', fbp: 'fb.1.cookie' },
        discountCodes: ['PROMO'],
        language: 'pt-BR',
        consent: { analytics: true, marketing: false, preferences: true, saleOfData: false },
      }),
      CTX,
    );
    assert.equal(response.reused, false);
    assert.equal(response.strategy, 'storefront_cart');
    assert.match(response.sessionId, /^cs_[0-9a-f]{24}$/);
    const url = new URL(response.checkoutUrl);
    assert.equal(url.origin, 'https://checkout.loja.com.br');
    assert.equal(url.searchParams.get('key'), 'segredo');
    assert.equal(url.searchParams.get('utm_source'), 'meta');
    assert.equal(url.searchParams.has('fbclid'), false);

    assert.equal(h.storefront.calls.length, 1);
    const call = h.storefront.calls[0]!;
    assert.equal(call.store.id, h.checkout.id);
    assert.deepEqual(call.input.lines, [
      { variantId: '91', quantity: 2 },
      { variantId: '92', quantity: 1 },
    ]);
    assert.equal(attr(call.input, 'bridge_session'), response.sessionId);
    assert.equal(attr(call.input, 'bridge_source'), h.vitrine.shopDomain);
    assert.equal(attr(call.input, 'utm_source'), 'meta');
    assert.equal(attr(call.input, 'fbclid'), 'clique');
    assert.equal(attr(call.input, 'fbp'), 'fb.1.cookie');
    assert.equal(call.input.countryCode, 'BR');
    assert.deepEqual(call.input.discountCodes, ['PROMO']);
    assert.equal(call.input.buyerIp, CTX.buyerIp);
    assert.equal(call.input.language, 'pt-BR');
    assert.deepEqual(call.input.consent, { analytics: true, marketing: false, preferences: true, saleOfData: false });

    const session = lastSession(h);
    assert.equal(session.id, response.sessionId);
    assert.equal(session.status, 'created');
    assert.equal(session.strategy, 'storefront_cart');
    assert.equal(session.checkoutUrl, response.checkoutUrl);
    assert.equal(session.cartId, 'gid://shopify/Cart/tok123', 'a chave do carrinho não é guardada');
    assert.equal(session.subtotal, '79.80');
    assert.equal(session.currency, 'BRL');
    assert.equal(session.country, 'BR');
    assert.equal(session.linkId, h.link.id);
    assert.deepEqual(session.lines, [
      { vitrineVariantId: '1', checkoutVariantId: '91', quantity: 2 },
      { vitrineVariantId: '2', checkoutVariantId: '92', quantity: 1 },
    ]);
    assert.match(session.ipHash ?? '', /^[0-9a-f]{32}$/);
    assert.equal(session.expiresAt, new Date(Date.parse(session.createdAt) + 15 * 60_000).toISOString());

    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'created', strategy: 'storefront_cart', code: 'ok' }), 1);
    assert.equal(h.metrics.observes.filter((o) => o.name === 'bridge_checkout_ms').length, 1);
    assert.equal(h.alerter.alerts.length, 0);
  });

  it('sem IP, país, cupom e atribuição funciona e não grava ipHash', async () => {
    const h = harness();
    const response = await h.service.createCheckout(h.request({ country: undefined, cartToken: undefined }), {
      requestId: 'req_2',
      buyerIp: null,
      userAgent: null,
    });
    assert.equal(response.checkoutUrl, CART_URL);
    const call = h.storefront.calls[0]!;
    assert.equal(call.input.countryCode, undefined);
    assert.equal(call.input.discountCodes, undefined);
    assert.equal(call.input.buyerIp, null);
    assert.equal(lastSession(h).ipHash, null);
    assert.equal(lastSession(h).country, null);
  });
});

describe('createCheckout: loja e rota (passos 1 e 2)', () => {
  it('loja desconhecida -> store_not_found, sem sessão', async () => {
    const h = harness();
    await expectCode(h.service.createCheckout(h.request({ shopDomain: 'outra.myshopify.com' }), CTX), 'store_not_found');
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'failed', code: 'store_not_found', strategy: 'none' }), 1);
  });

  it('loja que não é vitrine -> forbidden', async () => {
    const h = harness();
    await expectCode(h.service.createCheckout(h.request({ shopDomain: h.checkout.shopDomain }), CTX), 'forbidden');
  });

  it('vitrine desativada -> store_disabled', async () => {
    const h = harness();
    h.repos.stores.update(h.vitrine.id, { status: 'disabled' });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'store_disabled');
  });

  it('sem rota ativa -> no_route com alerta', async () => {
    const h = harness();
    h.repos.links.update(h.link.id, { enabled: false });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'no_route');
    assert.equal(h.alerter.alerts.length, 1);
    assert.equal(h.alerter.alerts[0]?.key, `no_route:${h.vitrine.id}`);
    assert.equal(h.storefront.calls.length, 0);
  });

  it('rota por país vence a default e país desconhecido cai na default', async () => {
    const h = harness();
    const outra = makeStore(h.repos, 'checkout');
    h.repos.catalog.upsertVariants([makeVariant(outra.id, '81', { productId: '800' })]);
    h.repos.mappings.setManual(makeMapping(h.vitrine.id, outra.id, '1', { checkoutVariantId: '81' }));
    const usLink = h.repos.links.create({ vitrineStoreId: h.vitrine.id, checkoutStoreId: outra.id, kind: 'country', countries: ['US'] });

    await h.service.createCheckout(h.request({ country: 'us', cartToken: 'a' }), CTX);
    assert.equal(h.storefront.calls[0]?.store.id, outra.id);
    assert.deepEqual(h.storefront.calls[0]?.input.lines, [{ variantId: '81', quantity: 2 }]);
    assert.equal(h.storefront.calls[0]?.input.countryCode, 'US');

    await h.service.createCheckout(h.request({ country: 'PT', cartToken: 'b' }), CTX);
    assert.equal(h.storefront.calls[1]?.store.id, h.checkout.id);
    const sessions = h.repos.sessions.list({ limit: 10, offset: 0 });
    assert.deepEqual(new Set(sessions.map((s) => s.linkId)), new Set([usLink.id, h.link.id]));
  });

  it('loja checkout desativada -> store_disabled', async () => {
    const h = harness();
    h.repos.stores.update(h.checkout.id, { status: 'disabled' });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'store_disabled');
    assert.equal(h.storefront.calls.length, 0);
  });
});

describe('createCheckout: limites e planos (passo 3)', () => {
  it('mais linhas que o limite da rota -> quantity_exceeded', async () => {
    const h = harness({ link: { maxLines: 1 } });
    const err = await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 1 }, { variantId: '2', quantity: 1 }] }), CTX),
      'quantity_exceeded',
    );
    assert.equal(err.details['reason'], 'too_many_lines');
  });

  it('o teto absoluto é 100 linhas mesmo com a rota permitindo mais', async () => {
    const h = harness({ link: { maxLines: 250, maxQuantityPerLine: 500 } });
    const lines = Array.from({ length: 101 }, () => ({ variantId: '1', quantity: 1 }));
    const err = await expectCode(h.service.createCheckout(h.request({ lines }), CTX), 'quantity_exceeded');
    assert.equal(err.details['maxLines'], 100);
  });

  it('quantidade acima do limite da rota -> quantity_exceeded', async () => {
    const h = harness({ link: { maxQuantityPerLine: 3 } });
    const err = await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 4 }] }), CTX), 'quantity_exceeded');
    assert.deepEqual(err.details['vitrineVariantIds'], ['1']);
  });

  it('dividir a quantidade em linhas iguais não escapa do limite', async () => {
    const h = harness({ link: { maxQuantityPerLine: 3 } });
    const err = await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 2 }, { variantId: '1', quantity: 2 }] }), CTX),
      'quantity_exceeded',
    );
    assert.deepEqual(err.details['checkoutVariantIds'], ['91']);
  });

  it('dividir a quantidade em linhas com propriedades distintas não escapa do limite', async () => {
    const h = harness({ link: { maxQuantityPerLine: 3 } });
    // Política CONTINUE sem estoque: a checagem de estoque em cache não segura nada aqui.
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', inventoryPolicy: 'CONTINUE', inventoryQuantity: 0 })]);
    const lines = Array.from({ length: 10 }, (_, i) => ({ variantId: '1', quantity: 3, properties: { n: String(i) } }));
    const err = await expectCode(h.service.createCheckout(h.request({ lines }), CTX), 'quantity_exceeded');
    assert.equal(err.details['reason'], 'quantity_per_line');
    assert.equal(err.details['maxQuantityPerLine'], 3);
    assert.deepEqual(err.details['checkoutVariantIds'], ['91']);
    assert.equal(h.storefront.calls.length, 0);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
    // Uma linha com propriedades e outra sem, da mesma variante, também somam.
    await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 2, properties: { n: '1' } }, { variantId: '1', quantity: 2 }] }), CTX),
      'quantity_exceeded',
    );
    assert.equal(h.storefront.calls.length, 0);
  });

  it('linhas com propriedades distintas dentro do limite seguem separadas para a Shopify', async () => {
    const h = harness({ link: { maxQuantityPerLine: 4 } });
    const response = await h.service.createCheckout(
      h.request({ lines: [{ variantId: '1', quantity: 2, properties: { nome: 'Ana' } }, { variantId: '1', quantity: 2, properties: { nome: 'Bia' } }] }),
      CTX,
    );
    assert.equal(response.reused, false);
    assert.equal(h.storefront.calls.length, 1);
    const sent = h.storefront.calls[0]!.input.lines;
    assert.deepEqual(
      sent.map((line) => ({ variantId: line.variantId, quantity: line.quantity, attributes: line.attributes })),
      [
        { variantId: '91', quantity: 2, attributes: [{ key: 'nome', value: 'Ana' }] },
        { variantId: '91', quantity: 2, attributes: [{ key: 'nome', value: 'Bia' }] },
      ],
    );
  });

  it('duas variantes da vitrine mapeadas para o mesmo destino contam juntas no limite', async () => {
    const h = harness({ link: { maxQuantityPerLine: 3 } });
    h.repos.mappings.setManual(makeMapping(h.vitrine.id, h.checkout.id, '2', { checkoutVariantId: '91' }));
    const err = await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 2 }, { variantId: '2', quantity: 2 }] }), CTX),
      'quantity_exceeded',
    );
    assert.deepEqual(err.details['checkoutVariantIds'], ['91']);
    assert.equal(h.storefront.calls.length, 0);
  });

  it('linha com plano de assinatura -> selling_plan_unsupported', async () => {
    const h = harness();
    await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 1, hasSellingPlan: true }] }), CTX),
      'selling_plan_unsupported',
    );
    assert.equal(h.storefront.calls.length, 0);
  });

  it('pedido malformado que escapou do schema -> invalid_request', async () => {
    const h = harness();
    await expectCode(h.service.createCheckout(h.request({ lines: [] }), CTX), 'invalid_request');
    await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: 'abc', quantity: 1 }] }), CTX), 'invalid_request');
    await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 0 }] }), CTX), 'invalid_request');
  });
});

describe('createCheckout: catálogo e mapeamento (passos 4 a 6)', () => {
  it('variante fora do catálogo da vitrine (ID inventado) -> unmapped_variant sem alerta', async () => {
    const h = harness();
    const err = await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: '999', quantity: 1 }] }), CTX), 'unmapped_variant');
    assert.equal(err.details['reason'], 'not_in_vitrine_catalog');
    assert.equal(h.alerter.alerts.length, 0);
    assert.equal(h.storefront.calls.length, 0);
  });

  it('variante do catálogo sem mapeamento ativo -> unmapped_variant com alerta', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.vitrine.id, '3', { productId: '100' })]);
    h.repos.mappings.setManual(makeMapping(h.vitrine.id, h.checkout.id, '3', { status: 'suggested' }));
    const err = await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: '3', quantity: 1 }] }), CTX), 'unmapped_variant');
    assert.equal(err.details['reason'], 'no_active_mapping');
    assert.equal(h.alerter.alerts[0]?.key, `unmapped:${h.link.id}`);
    // A sessão não chegou a existir: a recusa acontece antes da idempotência.
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
  });

  it('mapeamento aponta para variante ausente no catálogo do checkout -> unmapped_variant', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.vitrine.id, '4', { productId: '100' })]);
    h.repos.mappings.setManual(makeMapping(h.vitrine.id, h.checkout.id, '4', { checkoutVariantId: '94' }));
    const err = await expectCode(h.service.createCheckout(h.request({ lines: [{ variantId: '4', quantity: 1 }] }), CTX), 'unmapped_variant');
    assert.equal(err.details['reason'], 'not_in_checkout_catalog');
    assert.equal(h.alerter.alerts.length, 1);
  });

  it('variante do checkout com produto não ativo, não vendável ou sem estoque -> variant_unavailable', async () => {
    const cases: Array<[Partial<ReturnType<typeof makeVariant>>, string]> = [
      [{ productStatus: 'DRAFT' }, 'product_status'],
      [{ productStatus: 'ARCHIVED' }, 'product_status'],
      [{ availableForSale: false }, 'not_available_for_sale'],
      [{ inventoryQuantity: 1 }, 'insufficient_stock'],
    ];
    for (const [overrides, reason] of cases) {
      const h = harness();
      h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', ...overrides })]);
      const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'variant_unavailable');
      assert.deepEqual(err.details['items'], [{ vitrineVariantId: '1', checkoutVariantId: '91', reason }]);
      assert.equal(h.storefront.calls.length, 0);
    }
  });

  it('o estoque é comparado com a soma de todas as linhas da mesma variante', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', inventoryQuantity: 5 })]);
    await expectCode(
      h.service.createCheckout(
        h.request({ lines: [{ variantId: '1', quantity: 3 }, { variantId: '1', quantity: 3, properties: { a: 'b' } }] }),
        CTX,
      ),
      'variant_unavailable',
    );
  });

  it('UNLISTED, política CONTINUE, estoque desconhecido ou não rastreado passam', async () => {
    for (const overrides of [
      { productStatus: 'UNLISTED' as const },
      { inventoryPolicy: 'CONTINUE' as const, inventoryQuantity: 0 },
      { inventoryQuantity: null },
      { tracked: false, inventoryQuantity: 0 },
    ]) {
      const h = harness();
      h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', ...overrides })]);
      const response = await h.service.createCheckout(h.request(), CTX);
      assert.equal(response.reused, false);
    }
  });
});

describe('createCheckout: paridade de preço em cache (passo 7)', () => {
  it('política block: preço diferente -> price_divergence com alerta e sem chamada à Shopify', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', price: '41.90' })]);
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'price_divergence');
    assert.equal(err.details['stage'], 'cached');
    assert.deepEqual(err.details['divergences'], [
      { vitrineVariantId: '1', checkoutVariantId: '91', kind: 'price', vitrine: '39.90', checkout: '41.90' },
    ]);
    assert.equal(h.alerter.alerts[0]?.key, `price_divergence:${h.link.id}`);
    assert.equal(h.alerter.alerts[0]?.severity, 'critical');
    assert.equal(h.storefront.calls.length, 0);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
  });

  it('política block: moeda diferente também bloqueia', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', currency: 'USD' })]);
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'price_divergence');
    assert.equal((err.details['divergences'] as Array<{ kind: string }>)[0]?.kind, 'currency');
  });

  it('dentro da tolerância passa; fora, bloqueia', async () => {
    const h = harness({ link: { priceToleranceBps: 100 } });
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', price: '40.20' })]);
    await h.service.createCheckout(h.request({ cartToken: 'a' }), CTX);
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', price: '40.40' })]);
    await expectCode(h.service.createCheckout(h.request({ cartToken: 'b' }), CTX), 'price_divergence');
  });

  it('política warn: segue, registra métrica, não alerta', async () => {
    const h = harness({ link: { parityPolicy: 'warn' } });
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', price: '41.90' })]);
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.reused, false);
    assert.equal(h.metrics.count('bridge_checkout_parity_warnings_total', { stage: 'cached' }), 1);
    assert.equal(h.alerter.alerts.length, 0);
  });

  it('política off: nem compara', async () => {
    const h = harness({ link: { parityPolicy: 'off' } });
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '91', { productId: '900', price: '99.00', currency: 'USD' })]);
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.reused, false);
    assert.equal(h.metrics.count('bridge_checkout_parity_warnings_total'), 0);
  });
});

describe('createCheckout: idempotência (passo 8)', () => {
  it('a mesma requisição repetida devolve a mesma URL sem criar outro carrinho', async () => {
    const h = harness();
    const first = await h.service.createCheckout(h.request({ attribution: { utm_source: 'x' } }), CTX);
    const second = await h.service.createCheckout(h.request({ attribution: { utm_source: 'x' } }), { ...CTX, requestId: 'req_outro' });
    assert.equal(second.reused, true);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.checkoutUrl, first.checkoutUrl);
    assert.equal(second.strategy, 'storefront_cart');
    assert.equal(h.storefront.calls.length, 1);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 1);
    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'reused', code: 'ok' }), 1);
  });

  it('a ordem das linhas não muda a chave; token, país ou cupom diferentes mudam', async () => {
    const h = harness();
    const lines = [{ variantId: '1', quantity: 2 }, { variantId: '2', quantity: 1 }];
    const base = await h.service.createCheckout(h.request({ lines }), CTX);
    const reordered = await h.service.createCheckout(h.request({ lines: [...lines].reverse() }), CTX);
    assert.equal(reordered.sessionId, base.sessionId);
    const otherToken = await h.service.createCheckout(h.request({ lines, cartToken: 'carrinho-2' }), CTX);
    assert.notEqual(otherToken.sessionId, base.sessionId);
    const otherCountry = await h.service.createCheckout(h.request({ lines, country: 'PT' }), CTX);
    assert.notEqual(otherCountry.sessionId, base.sessionId);
    const withCode = await h.service.createCheckout(h.request({ lines, discountCodes: ['X'] }), CTX);
    assert.notEqual(withCode.sessionId, base.sessionId);
    assert.equal(h.storefront.calls.length, 4);
  });

  it('a janela de idempotência termina com o TTL da sessão', async () => {
    const h = harness();
    const first = await h.service.createCheckout(h.request(), CTX);
    h.clock.advance(15 * 60_000 + 1);
    const later = await h.service.createCheckout(h.request(), CTX);
    assert.notEqual(later.sessionId, first.sessionId);
    assert.equal(later.reused, false);
  });

  it('sem token: clique duplo do mesmo navegador reaproveita; outro IP não', async () => {
    const h = harness();
    const first = await h.service.createCheckout(h.request({ cartToken: undefined, source: 'buy_now' }), CTX);
    const double = await h.service.createCheckout(h.request({ cartToken: undefined, source: 'buy_now' }), CTX);
    assert.equal(double.sessionId, first.sessionId);
    const other = await h.service.createCheckout(h.request({ cartToken: undefined, source: 'buy_now' }), { ...CTX, buyerIp: '198.51.100.7' });
    assert.notEqual(other.sessionId, first.sessionId);
    // Sem IP não há como distinguir compradores: cada clique vira um carrinho.
    const anon = { requestId: 'r', buyerIp: null, userAgent: null };
    const a = await h.service.createCheckout(h.request({ cartToken: undefined }), anon);
    const b = await h.service.createCheckout(h.request({ cartToken: undefined }), anon);
    assert.notEqual(a.sessionId, b.sessionId);
  });

  it('sem token: nonces diferentes atrás do mesmo IP criam duas sessões; o mesmo nonce reaproveita na janela', async () => {
    const h = harness();
    const buyNow = (clientNonce: string) => h.request({ cartToken: undefined, source: 'buy_now', clientNonce });
    const a = await h.service.createCheckout(buyNow('navegador-aaaa'), CTX);
    const b = await h.service.createCheckout(buyNow('navegador-bbbb'), CTX);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(h.storefront.calls.length, 2);
    // Mesmo nonce, mesmas linhas, outra requisição (clique duplo): reaproveita.
    const again = await h.service.createCheckout(buyNow('navegador-aaaa'), { ...CTX, requestId: 'req_2' });
    assert.equal(again.reused, true);
    assert.equal(again.sessionId, a.sessionId);
    // Sem IP o nonce ainda separa compradores e ainda reaproveita o clique duplo.
    const anon = { requestId: 'r', buyerIp: null, userAgent: null };
    const c = await h.service.createCheckout(buyNow('navegador-cccc'), anon);
    assert.equal((await h.service.createCheckout(buyNow('navegador-cccc'), anon)).sessionId, c.sessionId);
    assert.notEqual(c.sessionId, a.sessionId);
    // A janela de tempo continua valendo: um nonce velho não prende o checkout.
    h.clock.advance(10_001);
    const later = await h.service.createCheckout(buyNow('navegador-aaaa'), CTX);
    assert.notEqual(later.sessionId, a.sessionId);
    assert.equal(later.reused, false);
    // Com token do carrinho o nonce não entra na chave.
    const withToken = await h.service.createCheckout(h.request({ clientNonce: 'navegador-aaaa' }), CTX);
    const otherNonce = await h.service.createCheckout(h.request({ clientNonce: 'navegador-bbbb' }), CTX);
    assert.equal(otherNonce.sessionId, withToken.sessionId);
  });

  it('uma sessão pendente concorrente é aguardada e reaproveitada quando termina', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      sleepHook: () => {
        release?.();
      },
    });
    const echo = h.storefront.fallback;
    h.storefront.queue.push(async (store, input) => {
      await gate;
      return echo(store, input);
    });
    const first = h.service.createCheckout(h.request(), CTX);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await h.service.createCheckout(h.request(), { ...CTX, requestId: 'req_2' });
    const firstResponse = await first;
    assert.equal(second.reused, true);
    assert.equal(second.sessionId, firstResponse.sessionId);
    assert.equal(second.checkoutUrl, firstResponse.checkoutUrl);
    assert.equal(h.storefront.calls.length, 1);
    assert.ok(h.sleeps.length >= 1);
  });

  it('sessão pendente que não termina -> upstream_unavailable depois de cerca de 3 s de espera', async () => {
    const h = harness();
    h.storefront.queue.push(() => new Promise<CartCreateResult>(() => {}));
    void h.service.createCheckout(h.request(), CTX).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    const err = await expectCode(h.service.createCheckout(h.request(), { ...CTX, requestId: 'req_2' }), 'upstream_unavailable');
    assert.equal(err.details['concurrentStatus'], 'pending');
    const waited = h.sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited >= 2900 && waited <= 3200, `esperou ${waited} ms`);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 1);
  });

  it('sessão pendente concorrente que falha -> upstream_unavailable sem esperar os 3 s', async () => {
    let fail: ((err: Error) => void) | null = null;
    const h = harness({
      sleepHook: () => {
        fail?.(new TypeError('fetch failed'));
      },
    });
    h.storefront.queue.push(
      () =>
        new Promise<CartCreateResult>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const first = h.service.createCheckout(h.request(), CTX).catch((err: unknown) => err);
    await new Promise((resolve) => setImmediate(resolve));
    const err = await expectCode(h.service.createCheckout(h.request(), { ...CTX, requestId: 'req_2' }), 'upstream_unavailable');
    assert.equal(err.details['concurrentStatus'], 'failed');
    assert.ok(h.sleeps.length <= 3);
    const firstErr = await first;
    assert.ok(isBridgeError(firstErr) && firstErr.code === 'internal');
  });
});

describe('createCheckout: recusa de negócio da sessão concorrente', () => {
  it('a requisição concorrente que falha por preço repassa price_divergence, não upstream_unavailable', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      sleepHook: () => {
        release?.();
      },
    });
    const echo = h.storefront.fallback;
    h.storefront.queue.push(async (store, input) => {
      await gate;
      const result = await echo(store, input);
      result.lines[0]!.unitPrice = '49.90';
      return result;
    });
    const first = h.service.createCheckout(h.request(), CTX).catch((err: unknown) => err);
    await new Promise((resolve) => setImmediate(resolve));
    const err = await expectCode(h.service.createCheckout(h.request(), { ...CTX, requestId: 'req_2' }), 'price_divergence');
    assert.equal(err.details['concurrentStatus'], 'failed');
    assert.equal(err.details['concurrentErrorCode'], 'price_divergence');
    assert.equal(err.publicMessage, new BridgeErrorClass('price_divergence').publicMessage);
    const firstErr = await first;
    assert.ok(isBridgeError(firstErr) && firstErr.code === 'price_divergence');
    // Só a dona da sessão cria carrinho e grava sessão; a concorrente não tenta de novo.
    assert.equal(h.storefront.calls.length, 1);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 1);
    assert.equal(lastSession(h).errorCode, 'price_divergence');
  });
});

describe('createCheckout: linhas do carrinho (passo 9)', () => {
  it('funde linhas sem propriedades da mesma variante e separa as com propriedades', async () => {
    const h = harness();
    const response = await h.service.createCheckout(
      h.request({
        lines: [
          { variantId: '1', quantity: 1 },
          { variantId: '2', quantity: 1 },
          { variantId: '1', quantity: 2 },
          { variantId: '1', quantity: 1, properties: { Gravação: 'Ana', __oculta: 'x' } },
        ],
      }),
      CTX,
    );
    assert.deepEqual(h.storefront.calls[0]?.input.lines, [
      { variantId: '91', quantity: 3 },
      { variantId: '92', quantity: 1 },
      { variantId: '91', quantity: 1, attributes: [{ key: 'Gravação', value: 'Ana' }] },
    ]);
    const session = h.repos.sessions.get(response.sessionId)!;
    assert.deepEqual(session.lines, [
      { vitrineVariantId: '1', checkoutVariantId: '91', quantity: 4 },
      { vitrineVariantId: '2', checkoutVariantId: '92', quantity: 1 },
    ]);
  });
});

/** Resposta do echo alterada por `mutate` antes de voltar ao serviço. */
function tampered(h: Harness, mutate: (result: CartCreateResult) => void): void {
  const echo = h.storefront.fallback;
  h.storefront.queue.push(async (store, input) => {
    const result = await echo(store, input);
    mutate(result);
    return result;
  });
}

describe('createCheckout: conferência do carrinho criado (passo 10)', () => {
  const twoLines = [
    { variantId: '1', quantity: 2 },
    { variantId: '2', quantity: 1 },
  ];

  it('linha que sumiu sem aviso -> variant_unavailable com alerta de publicação', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines = result.lines.filter((line) => line.variantId !== '92');
    });
    const err = await expectCode(h.service.createCheckout(h.request({ lines: twoLines }), CTX), 'variant_unavailable');
    assert.deepEqual(err.details['mismatches'], [{ checkoutVariantId: '92', requested: 1, returned: 0 }]);
    assert.deepEqual(err.details['silentlyDropped'], ['92']);
    assert.equal(h.alerter.alerts.length, 1);
    assert.equal(h.alerter.alerts[0]?.key, `cart_line_dropped:${h.link.id}`);
    assert.match(h.alerter.alerts[0]?.title ?? '', /publicado no canal/);
    assert.equal(lastSession(h).status, 'failed');
    assert.equal(lastSession(h).errorCode, 'variant_unavailable');
  });

  it('linha com quantidade 0 ou menor que a pedida -> variant_unavailable', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines[0]!.quantity = 0;
    });
    await expectCode(h.service.createCheckout(h.request({ lines: twoLines, cartToken: 'a' }), CTX), 'variant_unavailable');
    tampered(h, (result) => {
      result.lines[0]!.quantity = 1;
    });
    const err = await expectCode(h.service.createCheckout(h.request({ lines: twoLines, cartToken: 'b' }), CTX), 'variant_unavailable');
    assert.deepEqual(err.details['mismatches'], [{ checkoutVariantId: '91', requested: 2, returned: 1 }]);
  });

  for (const code of ['MERCHANDISE_OUT_OF_STOCK', 'MERCHANDISE_NOT_ENOUGH_STOCK', 'PRODUCT_UNAVAILABLE_IN_BUYER_LOCATION']) {
    it(`aviso ${code} -> variant_unavailable, sem alerta de publicação`, async () => {
      const h = harness();
      tampered(h, (result) => {
        result.lines[0]!.quantity = 0;
        result.warnings.push({ code, message: 'aviso', target: result.lines[0]!.lineId });
      });
      const err = await expectCode(h.service.createCheckout(h.request({ lines: twoLines }), CTX), 'variant_unavailable');
      assert.deepEqual(err.details['warningCodes'], [code]);
      assert.deepEqual(err.details['checkoutVariantIds'], ['91']);
      assert.deepEqual(err.details['silentlyDropped'], []);
      assert.equal(h.alerter.alerts.length, 0);
    });
  }

  it('aviso de estoque mesmo com quantidades certas bloqueia', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.warnings.push({ code: 'MERCHANDISE_NOT_ENOUGH_STOCK', message: 'aviso', target: null });
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'variant_unavailable');
  });

  it('linha devolvida como não vendável bloqueia', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines[0]!.availableForSale = false;
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'variant_unavailable');
  });

  it('linha que ninguém pediu -> upstream_rejected com alerta', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines.push({ lineId: 'gid://shopify/CartLine/x', variantId: '777', quantity: 1, unitPrice: '1.00', currency: 'BRL', availableForSale: true });
    });
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.equal(err.details['reason'], 'unexpected_cart_lines');
    assert.equal(h.alerter.alerts[0]?.key, `cart_unexpected:${h.link.id}`);
  });

  it('preço cobrado diferente do da vitrine -> price_divergence (block) com alerta', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines[0]!.unitPrice = '44.90';
    });
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'price_divergence');
    assert.equal(err.details['stage'], 'live');
    assert.deepEqual(err.details['divergences'], [
      { vitrineVariantId: '1', checkoutVariantId: '91', kind: 'price', vitrine: '39.90', checkout: '44.90' },
    ]);
    assert.equal(h.alerter.alerts[0]?.key, `price_divergence:${h.link.id}`);
    assert.equal(lastSession(h).errorCode, 'price_divergence');
  });

  it('preço cobrado diferente com política warn segue e conta métrica', async () => {
    const h = harness({ link: { parityPolicy: 'warn' } });
    tampered(h, (result) => {
      result.lines[0]!.unitPrice = '44.90';
    });
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.reused, false);
    assert.equal(h.metrics.count('bridge_checkout_parity_warnings_total', { stage: 'live' }), 1);
    assert.equal(h.alerter.alerts.length, 0);
  });

  it('preço cobrado diferente com política off nem é olhado', async () => {
    const h = harness({ link: { parityPolicy: 'off' } });
    tampered(h, (result) => {
      result.lines[0]!.unitPrice = '0.01';
    });
    await h.service.createCheckout(h.request(), CTX);
    assert.equal(h.metrics.count('bridge_checkout_parity_warnings_total'), 0);
  });

  it('moeda do carrinho diferente da vitrine: comparação pulada, métrica contada', async () => {
    const h = harness();
    tampered(h, (result) => {
      for (const line of result.lines) {
        line.currency = 'USD';
        line.unitPrice = '7.99';
      }
    });
    const response = await h.service.createCheckout(h.request({ lines: twoLines }), CTX);
    assert.equal(response.reused, false);
    assert.equal(h.metrics.count('bridge_checkout_parity_skipped_total', { reason: 'currency_mismatch' }), 2);
    assert.equal(h.metrics.count('bridge_checkout_parity_warnings_total'), 0);
  });

  it('avisos de cupom não bloqueiam', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.warnings.push({ code: 'DISCOUNT_NOT_FOUND', message: 'cupom', target: null });
      result.discountCodes = [{ code: 'X', applicable: false }];
    });
    const response = await h.service.createCheckout(h.request({ discountCodes: ['X'] }), CTX);
    assert.equal(response.reused, false);
  });

  it('URL de checkout inválida devolvida pela loja -> upstream_rejected', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.checkoutUrl = 'http://checkout.loja.com.br/cart/c/x';
    });
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.equal(err.details['reason'], 'invalid_checkout_url');
  });

  it('URL de checkout em outro host -> upstream_rejected com alerta, sessão failed e sem redirecionamento', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.checkoutUrl = 'https://outra-loja.myshopify.com/cart/c/x?key=k';
    });
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.equal(err.details['reason'], 'checkout_url_host');
    assert.equal(err.details['checkoutStoreId'], h.checkout.id);
    assert.equal(lastSession(h).status, 'failed');
    assert.equal(lastSession(h).checkoutUrl, null);
    assert.deepEqual(h.alerter.alerts.map((a) => a.key), [`upstream_rejected:${h.link.id}`]);
    assert.equal((h.alerter.alerts[0]?.detail?.['details'] as Record<string, unknown>)['reason'], 'checkout_url_host');
    // Com domínio público conhecido, um host parecido não serve.
    tampered(h, (result) => {
      result.checkoutUrl = 'https://checkout.loja.com.br.exemplo.com/cart/c/x';
    });
    await expectCode(h.service.createCheckout(h.request({ cartToken: 'carrinho-2' }), CTX), 'upstream_rejected');
    tampered(h, (result) => {
      result.checkoutUrl = 'https://checkout.loja.com.br:8443/cart/c/x';
    });
    await expectCode(h.service.createCheckout(h.request({ cartToken: 'carrinho-3' }), CTX), 'upstream_rejected');
  });

  it('aceita o domínio canônico, o domínio público e, sem domínio público, qualquer *.myshopify.com', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.checkoutUrl = `https://${h.checkout.shopDomain.toUpperCase()}/cart/c/x`;
    });
    assert.equal((await h.service.createCheckout(h.request(), CTX)).reused, false);
    tampered(h, (result) => {
      result.checkoutUrl = 'https://CHECKOUT.loja.com.br/cart/c/y';
    });
    assert.equal((await h.service.createCheckout(h.request({ cartToken: 'carrinho-2' }), CTX)).reused, false);
    h.repos.stores.update(h.checkout.id, { publicDomain: null });
    tampered(h, (result) => {
      result.checkoutUrl = 'https://qualquer-loja.myshopify.com/cart/c/z';
    });
    assert.equal((await h.service.createCheckout(h.request({ cartToken: 'carrinho-3' }), CTX)).reused, false);
    // Sem domínio público o antigo host público deixa de ser aceito.
    tampered(h, (result) => {
      result.checkoutUrl = 'https://checkout.loja.com.br/cart/c/w';
    });
    const err = await expectCode(h.service.createCheckout(h.request({ cartToken: 'carrinho-4' }), CTX), 'upstream_rejected');
    assert.equal(err.details['reason'], 'checkout_url_host');
    assert.equal(h.alerter.alerts.length, 1);
  });
});

describe('createCheckout: permalink e fallback (passos 10 e 11)', () => {
  const unavailable = (): CartHandler => () => {
    throw new BridgeErrorClass('upstream_unavailable', 'timeout');
  };

  it('rota por permalink monta a URL no domínio público da loja checkout, sem chamar a Shopify', async () => {
    const h = harness({ link: { strategy: 'permalink' } });
    const response = await h.service.createCheckout(
      h.request({
        lines: [
          { variantId: '1', quantity: 2 },
          { variantId: '1', quantity: 1 },
          { variantId: '2', quantity: 1 },
        ],
        discountCodes: ['PROMO'],
        attribution: { utm_source: 'meta', utm_campaign: 'verão', fbclid: 'clique', fbp: 'fb.1.cookie', ga: 'GA1.1' },
      }),
      CTX,
    );
    assert.equal(response.strategy, 'permalink');
    assert.equal(h.storefront.calls.length, 0);
    const url = new URL(response.checkoutUrl);
    assert.equal(url.origin, 'https://checkout.loja.com.br');
    assert.equal(url.pathname, '/cart/91:3,92:1');
    assert.equal(url.searchParams.get('discount'), 'PROMO');
    assert.equal(url.searchParams.get('attributes[bridge_session]'), response.sessionId);
    assert.equal(url.searchParams.get('attributes[bridge_source]'), h.vitrine.shopDomain);
    assert.equal(url.searchParams.get('attributes[utm_source]'), 'meta');
    assert.equal(url.searchParams.get('attributes[fbclid]'), 'clique');
    // Identificadores de cookie não vão para a URL.
    assert.equal(url.searchParams.has('attributes[fbp]'), false);
    assert.equal(url.searchParams.has('attributes[ga]'), false);
    // utm_* também na própria URL (passo 12).
    assert.equal(url.searchParams.get('utm_source'), 'meta');
    assert.equal(url.searchParams.get('utm_campaign'), 'verão');
    const session = lastSession(h);
    assert.equal(session.status, 'created');
    assert.equal(session.strategy, 'permalink');
    assert.equal(session.cartId, null);
    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'created', strategy: 'permalink', code: 'ok' }), 1);
  });

  it('sem domínio público usa o myshopify.com', async () => {
    const h = harness({ link: { strategy: 'permalink' } });
    h.repos.stores.update(h.checkout.id, { publicDomain: null });
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(new URL(response.checkoutUrl).host, h.checkout.shopDomain);
  });

  it('permalink com propriedades de linha -> upstream_rejected', async () => {
    const h = harness({ link: { strategy: 'permalink' } });
    const err = await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 1, properties: { a: 'b' } }] }), CTX),
      'upstream_rejected',
    );
    assert.equal(err.details['reason'], 'line_properties_unsupported_in_permalink');
    assert.equal(lastSession(h).errorCode, 'upstream_rejected');
  });

  it('Storefront indisponível com fallback permitido -> permalink na MESMA loja, com métrica', async () => {
    const h = harness({ link: { allowPermalinkFallback: true } });
    h.storefront.queue.push(unavailable());
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.strategy, 'permalink');
    assert.equal(new URL(response.checkoutUrl).host, 'checkout.loja.com.br');
    assert.equal(new URL(response.checkoutUrl).pathname, '/cart/91:2');
    assert.equal(h.metrics.count('bridge_checkout_permalink_fallback_total'), 1);
    assert.equal(lastSession(h).strategy, 'permalink');
    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'created', strategy: 'permalink' }), 1);
  });

  it('sem fallback permitido -> upstream_unavailable e sessão marcada', async () => {
    const h = harness();
    h.storefront.queue.push(unavailable());
    await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_unavailable');
    assert.equal(h.metrics.count('bridge_checkout_permalink_fallback_total'), 0);
    assert.equal(lastSession(h).status, 'failed');
    assert.equal(lastSession(h).errorCode, 'upstream_unavailable');
  });

  it('fallback permitido mas com propriedades de linha -> upstream_unavailable', async () => {
    const h = harness({ link: { allowPermalinkFallback: true } });
    h.storefront.queue.push(unavailable());
    await expectCode(
      h.service.createCheckout(h.request({ lines: [{ variantId: '1', quantity: 1, properties: { a: 'b' } }] }), CTX),
      'upstream_unavailable',
    );
    assert.equal(h.metrics.count('bridge_checkout_permalink_fallback_total'), 0);
  });

  it('recusa da Shopify (upstream_rejected) nunca cai no permalink', async () => {
    const h = harness({ link: { allowPermalinkFallback: true } });
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_rejected', 'userErrors', { userErrors: [{ code: 'INVALID' }] });
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.equal(h.metrics.count('bridge_checkout_permalink_fallback_total'), 0);
    assert.equal(lastSession(h).errorCode, 'upstream_rejected');
  });
});

describe('createCheckout: UTM na URL final (passo 12)', () => {
  it('acrescenta utm_* sem tocar nos parâmetros existentes nem repetir os que já estão', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.checkoutUrl = 'https://checkout.loja.com.br/cart/c/tok?key=seg&_cs=a%20b~c&utm_source=existente#frag';
    });
    const response = await h.service.createCheckout(
      h.request({ attribution: { utm_source: 'meta', utm_medium: 'cpc', utm_content: 'a b&c', utm_id: 'ignorado', gclid: 'g' } }),
      CTX,
    );
    assert.equal(
      response.checkoutUrl,
      'https://checkout.loja.com.br/cart/c/tok?key=seg&_cs=a%20b~c&utm_source=existente&utm_medium=cpc&utm_content=a%20b%26c#frag',
    );
  });

  it('sem atribuição a URL volta exatamente como veio', async () => {
    const h = harness();
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.checkoutUrl, CART_URL);
  });
});

describe('createCheckout: erros depois da sessão (passo 13)', () => {
  it('erro inesperado vira internal, marca a sessão e não vaza a mensagem', async () => {
    const h = harness();
    h.storefront.queue.push(() => {
      throw new TypeError('fetch failed');
    });
    const err = await expectCode(h.service.createCheckout(h.request(), CTX), 'internal');
    assert.equal(err.publicMessage, 'Erro inesperado. Tente novamente.');
    assert.equal(lastSession(h).status, 'failed');
    assert.equal(lastSession(h).errorCode, 'internal');
    assert.equal(h.metrics.count('bridge_checkout_sessions_total', { result: 'failed', code: 'internal', strategy: 'storefront_cart' }), 1);
  });

  it('recusa da Shopify (upstream_rejected) alerta por rota com o motivo nos detalhes', async () => {
    const h = harness();
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_rejected', 'userErrors', { userErrors: [{ code: 'INVALID', field: ['lines', '0', 'merchandiseId'] }] });
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.equal(lastSession(h).errorCode, 'upstream_rejected');
    assert.equal(h.alerter.alerts.length, 1);
    const alert = h.alerter.alerts[0]!;
    assert.equal(alert.key, `upstream_rejected:${h.link.id}`);
    assert.equal(alert.severity, 'warning');
    assert.equal(alert.detail?.['linkId'], h.link.id);
    assert.equal(alert.detail?.['checkoutStoreId'], h.checkout.id);
    assert.deepEqual((alert.detail?.['details'] as Record<string, unknown>)['userErrors'], [{ code: 'INVALID', field: ['lines', '0', 'merchandiseId'] }]);
    // Loja inativa chega como upstream_rejected com código nos detalhes e alerta do mesmo jeito.
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_rejected', 'A loja checkout está inativa', { code: 'SHOP_INACTIVE' });
    });
    await expectCode(h.service.createCheckout(h.request({ cartToken: 'carrinho-2' }), CTX), 'upstream_rejected');
    assert.equal(h.alerter.alerts.length, 2);
    assert.equal((h.alerter.alerts[1]?.detail?.['details'] as Record<string, unknown>)['code'], 'SHOP_INACTIVE');
  });

  it('linha inesperada no carrinho alerta uma vez só; indisponibilidade não alerta aqui', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.lines.push({ lineId: 'gid://shopify/CartLine/x', variantId: '777', quantity: 1, unitPrice: '1.00', currency: 'BRL', availableForSale: true });
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_rejected');
    assert.deepEqual(h.alerter.alerts.map((a) => a.key), [`cart_unexpected:${h.link.id}`]);
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_unavailable', 'timeout');
    });
    await expectCode(h.service.createCheckout(h.request({ cartToken: 'carrinho-2' }), CTX), 'upstream_unavailable');
    assert.equal(h.alerter.alerts.length, 1);
  });

  it('uma sessão falha não impede uma nova tentativa do mesmo carrinho', async () => {
    const h = harness();
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_unavailable', 'timeout');
    });
    await expectCode(h.service.createCheckout(h.request(), CTX), 'upstream_unavailable');
    const response = await h.service.createCheckout(h.request(), CTX);
    assert.equal(response.reused, false);
    assert.equal(h.storefront.calls.length, 2);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 2);
  });
});

describe('testLink', () => {
  it('rota inexistente -> ok false sem lançar', async () => {
    const h = harness();
    const result = await h.service.testLink('ln_nao_existe');
    assert.equal(result.ok, false);
    assert.equal(result.tested, 0);
    assert.equal(result.detail, 'Rota não encontrada.');
  });

  it('sem mapeamentos ativos disponíveis -> ok false com explicação', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([
      makeVariant(h.checkout.id, '91', { productId: '900', productStatus: 'DRAFT' }),
      makeVariant(h.checkout.id, '92', { productId: '900', availableForSale: false }),
    ]);
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.ok, false);
    assert.equal(result.tested, 0);
    assert.match(result.detail ?? '', /Nenhuma variante para testar/);
    assert.equal(h.storefront.calls.length, 0);
  });

  it('carrinho de teste com tudo certo -> ok true, sem sessão gravada', async () => {
    const h = harness();
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'storefront_cart');
    assert.equal(result.tested, 2);
    assert.deepEqual(result.problems, []);
    const call = h.storefront.calls[0]!;
    assert.equal(call.store.id, h.checkout.id);
    assert.deepEqual(call.input.lines, [
      { variantId: '91', quantity: 1 },
      { variantId: '92', quantity: 1 },
    ]);
    assert.deepEqual(call.input.attributes, [{ key: 'bridge_test', value: '1' }]);
    assert.equal(call.input.buyerIp, null);
    assert.equal(call.input.countryCode, undefined);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
  });

  it('respeita o tamanho da amostra e usa o país da rota por país', async () => {
    const h = harness({ link: { kind: 'country', countries: ['PT', 'ES'] } });
    const result = await h.service.testLink(h.link.id, 1);
    assert.equal(result.tested, 1);
    assert.equal(h.storefront.calls[0]?.input.lines.length, 1);
    assert.equal(h.storefront.calls[0]?.input.countryCode, 'ES');
    assert.match(result.detail ?? '', /país ES/);
  });

  it('relata um problema por variante, em português', async () => {
    const h = harness();
    h.repos.catalog.upsertVariants([makeVariant(h.vitrine.id, '3', { productId: '100', price: '10.00' }), makeVariant(h.checkout.id, '93', { productId: '900', price: '10.00' })]);
    h.repos.mappings.setManual(makeMapping(h.vitrine.id, h.checkout.id, '3'));
    tampered(h, (result) => {
      // 91 sumiu sem aviso; 92 sem estoque; 93 com preço diferente.
      result.lines = result.lines.filter((line) => line.variantId !== '91');
      const l92 = result.lines.find((line) => line.variantId === '92')!;
      l92.quantity = 0;
      result.warnings.push({ code: 'MERCHANDISE_OUT_OF_STOCK', message: 'x', target: l92.lineId });
      result.lines.find((line) => line.variantId === '93')!.unitPrice = '12.50';
    });
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.ok, false);
    assert.equal(result.tested, 3);
    assert.equal(result.problems.length, 3);
    const byId = new Map(result.problems.map((p) => [p.checkoutVariantId, p]));
    assert.equal(byId.get('91')?.vitrineVariantId, '1');
    assert.match(byId.get('91')?.problem ?? '', /Não entrou no carrinho de teste.*publicado no canal/);
    assert.match(byId.get('92')?.problem ?? '', /Sem estoque/);
    assert.match(byId.get('93')?.problem ?? '', /Preço diferente da vitrine/);
    assert.match(byId.get('93')?.problem ?? '', /10,00/);
    assert.match(byId.get('93')?.problem ?? '', /12,50/);
    assert.equal(tableCount(h.db, 'checkout_sessions'), 0);
  });

  it('indisponível no país do comprador tem texto próprio', async () => {
    const h = harness();
    tampered(h, (result) => {
      result.warnings.push({ code: 'PRODUCT_UNAVAILABLE_IN_BUYER_LOCATION', message: 'x', target: result.lines[0]!.lineId });
    });
    const result = await h.service.testLink(h.link.id, 1);
    assert.equal(result.ok, false);
    assert.match(result.problems[0]?.problem ?? '', /país do comprador/);
  });

  it('rota por permalink confere só o cache e avisa que o link não é validado no servidor', async () => {
    const h = harness({ link: { strategy: 'permalink' } });
    h.repos.catalog.upsertVariants([makeVariant(h.checkout.id, '92', { productId: '900', price: '61.00' })]);
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.strategy, 'permalink');
    assert.equal(result.tested, 2);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]?.checkoutVariantId, '92');
    assert.match(result.problems[0]?.problem ?? '', /Preço diferente/);
    assert.match(result.detail ?? '', /não pode ser validado pelo servidor/);
    assert.equal(h.storefront.calls.length, 0);
  });

  it('erro da Storefront vira ok false com a mensagem pública', async () => {
    const h = harness();
    h.storefront.queue.push(() => {
      throw new BridgeErrorClass('upstream_unavailable', 'timeout');
    });
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.ok, false);
    assert.equal(result.detail, new BridgeErrorClass('upstream_unavailable').publicMessage);
    h.storefront.queue.push(() => {
      throw new Error('boom');
    });
    const unexpected = await h.service.testLink(h.link.id);
    assert.equal(unexpected.ok, false);
    assert.equal(unexpected.detail, 'Erro inesperado ao testar a rota.');
  });

  it('loja checkout desativada -> ok false', async () => {
    const h = harness();
    h.repos.stores.update(h.checkout.id, { status: 'disabled' });
    const result = await h.service.testLink(h.link.id);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /desativada/);
  });
});
