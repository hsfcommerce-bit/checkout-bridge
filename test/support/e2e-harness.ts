import assert from 'node:assert/strict';
import { ADMIN_COOKIE } from '../../src/admin/auth.ts';
import { createApp } from '../../src/app.ts';
import type { App } from '../../src/app.ts';
import type { QueueTimers } from '../../src/catalog/queue.ts';
import { testConfig } from '../../src/config.ts';
import type { Config } from '../../src/config.ts';
import { fakeClock } from '../../src/lib/clock.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { signAppProxyQuery } from '../../src/shopify/proxy-signature.ts';
import { signWebhookBody } from '../../src/shopify/webhook-hmac.ts';
import { createFakeShopify, makeFakeVariant } from './fake-shopify.ts';
import type { FakeShop, FakeShopify } from './fake-shopify.ts';

/**
 * Apoio aos testes de ponta a ponta: aplicação inteira (createApp) sobre banco em memória,
 * Shopify falsa, relógio falso, espera que não espera e timers manuais para a fila de
 * catálogo. Toda resposta HTTP e toda linha de log ficam guardadas para as asserções de
 * vazamento (segredo, token, assinatura). Não é um arquivo de teste.
 */

export const PASSWORD = 'senha-de-teste-123';
export const PROXY_PATH = '/apps/checkout-bridge';
export const T0 = '2026-03-01T12:00:00.000Z';
/** Item que a Shopify acrescenta ao fim de X-Forwarded-For ao encaminhar pelo App Proxy (faixa de documentação). */
const SHOPIFY_PROXY_IP = '192.0.2.1';

export interface ManualTimers extends QueueTimers {
  /** Dispara todos os timers pendentes neste momento (os agendados durante o disparo ficam para a próxima). */
  flush(): void;
  size(): number;
}

export function manualTimers(): ManualTimers {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeout(fn) {
      seq += 1;
      pending.set(seq, fn);
      return seq;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    flush() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    size: () => pending.size,
  };
}

export interface AdminAuthState {
  cookie: string;
  csrf: string;
}

export interface ShopRef {
  id: string;
  domain: string;
  secret: string;
  fake: FakeShop;
}

export interface E2E {
  instance: App;
  app: App['app'];
  deps: App['deps'];
  shopify: FakeShopify;
  clock: ReturnType<typeof fakeClock>;
  config: Config;
  timers: ManualTimers;
  logs: string[];
  /** Corpo de toda resposta devolvida por request(). */
  responses: string[];
  request(path: string, init?: RequestInit): Promise<Response>;
  login(): Promise<AdminAuthState>;
  adminGet(path: string, auth: AdminAuthState): Promise<Response>;
  adminPost(path: string, fields: Record<string, string>, auth: AdminAuthState | null): Promise<Response>;
  /** Cadastra a loja pelo painel (o que também a conecta) e devolve o id. */
  createStore(auth: AdminAuthState, fields: Record<string, string>): Promise<string>;
  createLink(auth: AdminAuthState, fields: Record<string, string>): Promise<string>;
  /** Query string assinada como a Shopify assinaria para esta vitrine, agora. */
  proxyQuery(shop: ShopRef, overrides?: Record<string, string | string[]>): string;
  /**
   * POST assinado em /proxy/checkout. `ip` é o IP do comprador: vai em X-Forwarded-For
   * seguido do item que a própria Shopify acrescenta (testConfig tem trustedProxyHops = 1
   * e a rota do proxy conta esse salto a mais), como chega em produção.
   */
  proxyCheckout(
    shop: ShopRef,
    body: unknown,
    opts?: { query?: string; ip?: string; rawBody?: string },
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  webhook(
    shop: ShopRef,
    topic: string,
    body: string,
    opts?: { hmac?: string | null; eventId?: string; webhookId?: string },
  ): Promise<Response>;
  /** Dispara os timers da fila e espera as releituras terminarem. */
  drainQueue(): Promise<void>;
  /**
   * Alertas emitidos até agora, na ordem, lidos das linhas de log do alertador (todo alerta
   * passa pelo log; o webhook é opcional). Alertas suprimidos pelo intervalo não entram.
   */
  alerts(): EmittedAlert[];
  close(): Promise<void>;
}

export interface EmittedAlert {
  key: string;
  severity: string;
  title: string;
}

function alertsFromLogs(logs: string[]): EmittedAlert[] {
  const out: EmittedAlert[] = [];
  for (const line of logs) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = typeof entry['msg'] === 'string' ? entry['msg'] : '';
    if (typeof entry['alertKey'] !== 'string' || !msg.startsWith('alerta: ')) continue;
    out.push({ key: entry['alertKey'], severity: String(entry['severity'] ?? ''), title: msg.slice('alerta: '.length) });
  }
  return out;
}

function cookieFrom(res: Response, name: string): string | null {
  const header = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;,]+)`).exec(header);
  return match?.[1] ?? null;
}

export function createE2E(overrides: Partial<Config> = {}): E2E {
  const config = testConfig({ adminPassword: PASSWORD, ...overrides });
  const clock = fakeClock(T0);
  const shopify = createFakeShopify();
  const timers = manualTimers();
  const logs: string[] = [];
  const responses: string[] = [];
  const logger = createLogger({
    level: 'trace',
    env: 'test',
    destination: {
      write(chunk: string) {
        logs.push(chunk);
      },
    },
  });
  const instance = createApp({
    config,
    fetchImpl: shopify.fetch,
    clock,
    logger,
    sleep: async () => undefined,
    random: () => 0.5,
    queueTimers: timers,
  });
  const { app, deps } = instance;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await app.request(path, init);
    responses.push(await res.clone().text());
    return res;
  }

  async function adminPost(path: string, fields: Record<string, string>, auth: AdminAuthState | null): Promise<Response> {
    const body = new URLSearchParams(auth === null ? fields : { _csrf: auth.csrf, ...fields }).toString();
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth === null ? {} : { cookie: auth.cookie }) },
      body,
    });
  }

  async function login(): Promise<AdminAuthState> {
    const res = await request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    assert.equal(res.status, 303, 'login deveria redirecionar');
    const token = cookieFrom(res, ADMIN_COOKIE);
    assert.ok(token !== null, 'login não devolveu o cookie de sessão');
    const cookie = `${ADMIN_COOKIE}=${token}`;
    const session = deps.adminAuth.authenticate(cookie);
    assert.ok(session !== null, 'cookie de sessão não autentica');
    return { cookie, csrf: session.csrfToken };
  }

  async function createEntity(auth: AdminAuthState, path: string, fields: Record<string, string>): Promise<string> {
    const res = await adminPost(path, fields, auth);
    const location = res.headers.get('location') ?? '';
    assert.equal(res.status, 303, `${path}: esperava redirect, veio ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const id = location.split('/').pop() ?? '';
    assert.ok(id.length > 0, `${path}: redirect sem id (${location})`);
    return id;
  }

  async function drainQueue(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      timers.flush();
      // A releitura é assíncrona (fetch falso); alguns giros do event loop bastam.
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (timers.size() === 0) break;
    }
    await deps.queue.idle();
  }

  return {
    instance,
    app,
    deps,
    shopify,
    clock,
    config,
    timers,
    logs,
    responses,
    request,
    login,
    adminGet: (path, auth) => request(path, { headers: { cookie: auth.cookie } }),
    adminPost,
    createStore: (auth, fields) => createEntity(auth, '/admin/stores', fields),
    createLink: (auth, fields) => createEntity(auth, '/admin/links', fields),
    proxyQuery(shop, overrides = {}) {
      return signAppProxyQuery(
        {
          shop: shop.domain,
          path_prefix: PROXY_PATH,
          timestamp: String(Math.floor(clock.now().getTime() / 1000)),
          logged_in_customer_id: '',
          ...overrides,
        },
        shop.secret,
      );
    },
    async proxyCheckout(shop, body, opts = {}) {
      const query = opts.query ?? this.proxyQuery(shop);
      const res = await request(`/proxy/checkout?${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.ip === undefined ? {} : { 'x-forwarded-for': `${opts.ip}, ${SHOPIFY_PROXY_IP}` }),
        },
        body: opts.rawBody ?? JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    webhook(shop, topic, body, opts = {}) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': shop.domain,
        'x-shopify-webhook-id': opts.webhookId ?? `wh-${Math.random().toString(16).slice(2)}`,
        'x-shopify-event-id': opts.eventId ?? `ev-${Math.random().toString(16).slice(2)}`,
      };
      const hmac = opts.hmac === undefined ? signWebhookBody(body, shop.secret) : opts.hmac;
      if (hmac !== null) headers['x-shopify-hmac-sha256'] = hmac;
      return request('/webhooks/shopify', { method: 'POST', headers, body });
    },
    drainQueue,
    alerts: () => alertsFromLogs(logs),
    close: () => instance.close(),
  };
}

// ---------------------------------------------------------------------------
// Cenário padrão: uma vitrine, duas lojas checkout e duas rotas (padrão e por país)
// ---------------------------------------------------------------------------

/** Catálogo compartilhado por SKU: mesma oferta nas três lojas, ids de variante distintos. */
export const CATALOG = [
  { sku: 'CAM-AZUL-M', title: 'Camiseta Azul', price: '50.00' },
  { sku: 'BONE-PRETO', title: 'Boné Preto', price: '30.00' },
  { sku: 'TENIS-42', title: 'Tênis Corrida', price: '200.00' },
] as const;

export function catalogFor(prefix: string): ReturnType<typeof makeFakeVariant>[] {
  return CATALOG.map((item, index) =>
    makeFakeVariant(`${prefix}0${index + 1}`, {
      sku: item.sku,
      productTitle: item.title,
      productHandle: item.title.toLowerCase().replace(/\s+/g, '-'),
      price: item.price,
    }),
  );
}

export interface Scenario {
  auth: AdminAuthState;
  vitrine: ShopRef;
  checkoutA: ShopRef;
  checkoutB: ShopRef;
  /** Rota padrão vitrine -> A. */
  defaultLinkId: string;
  /** Rota BR vitrine -> B. */
  countryLinkId: string;
}

export function linkForm(vitrineId: string, checkoutId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    vitrineStoreId: vitrineId,
    checkoutStoreId: checkoutId,
    kind: 'default',
    countries: '',
    strategy: 'storefront_cart',
    parityPolicy: 'block',
    tolerancePercent: '0',
    maxQuantityPerLine: '10',
    maxLines: '20',
    enabled: '1',
    ...overrides,
  };
}

export async function setupScenario(e2e: E2E, opts: { linkOverrides?: Record<string, string> } = {}): Promise<Scenario> {
  const auth = await e2e.login();
  const defs = [
    { key: 'vitrine', domain: 'vitrine-teste.myshopify.com', role: 'vitrine', prefix: '1' },
    { key: 'checkoutA', domain: 'checkout-a.myshopify.com', role: 'checkout', prefix: '2' },
    { key: 'checkoutB', domain: 'checkout-b.myshopify.com', role: 'checkout', prefix: '3' },
  ] as const;
  const refs: Partial<Record<(typeof defs)[number]['key'], ShopRef>> = {};
  for (const def of defs) {
    const secret = `shpss_${def.key}_segredo_nao_vaza`;
    const fake = e2e.shopify.addShop({
      domain: def.domain,
      clientId: `client-${def.key}`,
      clientSecret: secret,
      scopes: def.role === 'vitrine' ? ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders'] : ['read_products', 'read_inventory', 'read_orders'],
      variants: catalogFor(def.prefix),
    });
    const id = await e2e.createStore(auth, {
      role: def.role,
      name: `Loja ${def.key}`,
      shopDomain: def.domain,
      clientId: `client-${def.key}`,
      clientSecret: secret,
      publicDomain: '',
      proxyPath: def.role === 'vitrine' ? PROXY_PATH : '',
      storefrontAuthMode: 'tokenless',
      storefrontToken: '',
    });
    refs[def.key] = { id, domain: def.domain, secret, fake };
  }
  const vitrine = refs.vitrine as ShopRef;
  const checkoutA = refs.checkoutA as ShopRef;
  const checkoutB = refs.checkoutB as ShopRef;
  const defaultLinkId = await e2e.createLink(auth, linkForm(vitrine.id, checkoutA.id, opts.linkOverrides));
  const countryLinkId = await e2e.createLink(
    auth,
    linkForm(vitrine.id, checkoutB.id, { kind: 'country', countries: 'BR', ...opts.linkOverrides }),
  );
  return { auth, vitrine, checkoutA, checkoutB, defaultLinkId, countryLinkId };
}
