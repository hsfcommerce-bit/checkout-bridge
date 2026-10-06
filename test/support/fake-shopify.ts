import type { InventoryPolicy, ProductStatus, VariantOption } from '../../src/types.ts';

/**
 * Shopify falsa para os testes de ponta a ponta: um `fetch` roteirizado que emula, por
 * domínio de loja, o endpoint de token (client credentials), a Admin GraphQL (dados da
 * loja, páginas de variantes, produto por id, assinaturas de webhook) e a mutação
 * cartCreate da Storefront API.
 *
 * Não é um arquivo de teste (não termina em .test.ts). Os preços do carrinho saem SEMPRE do
 * catálogo da própria loja falsa (ou do preço "ao vivo" configurado para simular uma
 * mudança), nunca do pedido, exatamente como a Shopify real faria. Cada requisição fica
 * gravada em `requests` para que os testes confirmem cabeçalhos e corpos.
 */

export interface FakeVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  productHandle: string;
  productStatus: ProductStatus;
  variantTitle: string;
  options: VariantOption[];
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryPolicy: InventoryPolicy;
  inventoryQuantity: number | null;
  tracked: boolean;
}

/**
 * Comportamento da Storefront API da loja. 'ok' responde normalmente; os demais simulam
 * limite de requisições (THROTTLED), rejeição de segurança (HTTP 430), queda (HTTP 503) e
 * falha de rede. O modo vale até ser trocado pelo teste.
 */
export type StorefrontMode = 'ok' | 'throttled' | 'security_rejected' | 'outage' | 'network_error';

export interface FakeWebhookSubscription {
  id: string;
  topic: string;
  uri: string;
  format: string;
}

export interface FakeShopInit {
  domain: string;
  clientId: string;
  clientSecret: string;
  name?: string;
  currency?: string;
  primaryDomainHost?: string | null;
  scopes?: string[];
  /** Token de Storefront aceito pela loja; null aceita só chamadas sem token. */
  storefrontToken?: string | null;
  variants?: FakeVariant[];
}

export interface FakeShop {
  readonly domain: string;
  clientId: string;
  clientSecret: string;
  name: string;
  currency: string;
  primaryDomainHost: string | null;
  scopes: string[];
  storefrontToken: string | null;
  variants: FakeVariant[];
  webhooks: FakeWebhookSubscription[];
  /** Tokens emitidos pelo endpoint de client credentials e ainda aceitos na Admin API. */
  issuedTokens: Set<string>;
  storefront: {
    mode: StorefrontMode;
    /** Variantes que o carrinho devolve com quantidade 0 e aviso MERCHANDISE_OUT_OF_STOCK. */
    outOfStock: Set<string>;
    /** Variantes que somem do carrinho sem erro nem aviso (produto não publicado no canal). */
    vanished: Set<string>;
    /** Preço cobrado no carrinho quando difere do catálogo sincronizado (mudança de preço). */
    livePrice: Map<string, string>;
    /** Quantos carrinhos foram criados; também numera os tokens de carrinho. */
    cartsCreated: number;
  };
  /** Tempo de queda da Admin API (HTTP 503 em toda chamada) quando true. */
  adminOutage: boolean;
}

export type RequestKind = 'token' | 'admin' | 'storefront' | 'unknown';

export interface RecordedRequest {
  kind: RequestKind;
  shop: string | null;
  method: string;
  url: string;
  /** Cabeçalhos em minúsculas. */
  headers: Record<string, string>;
  body: string;
  /** Corpo interpretado como JSON quando possível. */
  json: unknown;
  /** Nome da operação GraphQL (BridgeShopInfo, CartCreate...), quando identificável. */
  operation: string | null;
}

export interface FakeShopify {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  addShop(init: FakeShopInit): FakeShop;
  shop(domain: string): FakeShop;
  /** Requisições de um tipo, opcionalmente de uma loja. */
  requestsOf(kind: RequestKind, domain?: string): RecordedRequest[];
  /** Limpa só o registro de requisições; as lojas continuam. */
  clearRequests(): void;
}

const API_VERSION_RE = /^\/admin\/api\/(\d{4}-\d{2})\/graphql\.json$/;
const STOREFRONT_RE = /^\/api\/(\d{4}-\d{2})\/graphql\.json$/;

export function makeFakeVariant(variantId: string, overrides: Partial<FakeVariant> = {}): FakeVariant {
  return {
    variantId,
    productId: `10${variantId}`,
    productTitle: `Produto ${variantId}`,
    productHandle: `produto-${variantId}`,
    productStatus: 'ACTIVE',
    variantTitle: 'Default Title',
    options: [{ name: 'Title', value: 'Default Title' }],
    sku: `SKU-${variantId}`,
    barcode: null,
    price: '39.90',
    compareAtPrice: null,
    availableForSale: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 100,
    tracked: true,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationName(json: unknown): string | null {
  if (!isRecord(json) || typeof json['query'] !== 'string') return null;
  const match = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(json['query']);
  return match?.[1] ?? null;
}

function headersToRecord(init: RequestInit | undefined, input: string | URL | Request): Record<string, string> {
  const out: Record<string, string> = {};
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (source === undefined) return out;
  new Headers(source).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function bodyText(init: RequestInit | undefined, input: string | URL | Request): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body === undefined || body === null) {
    return input instanceof Request ? await input.clone().text() : '';
  }
  return String(body);
}

/** Custo de consulta plausível para a Admin API; os clientes só precisam de números finitos. */
function costExtension(requested: number): Record<string, unknown> {
  return {
    cost: {
      requestedQueryCost: requested,
      actualQueryCost: requested,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2000 - requested, restoreRate: 100 },
    },
  };
}

function variantGid(id: string): string {
  return `gid://shopify/ProductVariant/${id}`;
}

function productGid(id: string): string {
  return `gid://shopify/Product/${id}`;
}

function fromGidLoose(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /\/(\d+)$/.exec(value);
  return match?.[1] ?? null;
}

function variantNode(variant: FakeVariant, withProduct: boolean): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: variantGid(variant.variantId),
    title: variant.variantTitle,
    sku: variant.sku,
    barcode: variant.barcode,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    availableForSale: variant.availableForSale,
    inventoryPolicy: variant.inventoryPolicy,
    inventoryQuantity: variant.inventoryQuantity,
    selectedOptions: variant.options,
    inventoryItem: { tracked: variant.tracked },
  };
  if (withProduct) {
    node['product'] = {
      id: productGid(variant.productId),
      title: variant.productTitle,
      handle: variant.productHandle,
      status: variant.productStatus,
    };
  }
  return node;
}

/** Paginação por índice: o cursor é a posição do próximo item, em texto. */
function page<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const size = typeof first === 'number' && first > 0 ? Math.floor(first) : 50;
  const start = typeof after === 'string' && /^\d+$/.test(after) ? Number(after) : 0;
  const nodes = items.slice(start, start + size);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length > 0 ? String(end) : null } };
}

// ---------------------------------------------------------------------------
// Admin GraphQL
// ---------------------------------------------------------------------------

function adminGraphql(shop: FakeShop, headers: Record<string, string>, json: unknown): Response {
  const versionHeader = { 'X-Shopify-API-Version': '2026-10' };
  if (shop.adminOutage) return jsonResponse(503, { errors: 'Service Unavailable' }, versionHeader);
  const token = headers['x-shopify-access-token'];
  if (token === undefined || !shop.issuedTokens.has(token)) {
    return jsonResponse(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' }, versionHeader);
  }
  if (!isRecord(json)) return jsonResponse(400, { errors: 'Bad request' }, versionHeader);
  const variables = isRecord(json['variables']) ? json['variables'] : {};
  const ok = (data: Record<string, unknown>, cost = 10): Response =>
    jsonResponse(200, { data, extensions: costExtension(cost) }, versionHeader);

  switch (operationName(json)) {
    case 'BridgeShopInfo':
      return ok({
        shop: {
          name: shop.name,
          currencyCode: shop.currency,
          myshopifyDomain: shop.domain,
          primaryDomain: { host: shop.primaryDomainHost ?? shop.domain },
        },
      });
    case 'BridgeVariantsPage': {
      const result = page(shop.variants, variables['first'], variables['after']);
      return ok(
        { productVariants: { nodes: result.nodes.map((v) => variantNode(v, true)), pageInfo: result.pageInfo } },
        2 + result.nodes.length * 4,
      );
    }
    case 'BridgeProductVariants': {
      const productId = fromGidLoose(variables['id']);
      const variants = shop.variants.filter((v) => v.productId === productId);
      if (productId === null || variants.length === 0) return ok({ product: null });
      const first = variants[0] as FakeVariant;
      const result = page(variants, variables['first'], variables['after']);
      return ok({
        product: {
          id: productGid(productId),
          title: first.productTitle,
          handle: first.productHandle,
          status: first.productStatus,
          variants: { nodes: result.nodes.map((v) => variantNode(v, false)), pageInfo: result.pageInfo },
        },
      });
    }
    case 'BridgeWebhookSubscriptions': {
      const topics = Array.isArray(variables['topics']) ? (variables['topics'] as unknown[]) : null;
      const matching = shop.webhooks.filter((w) => topics === null || topics.includes(w.topic));
      const result = page(matching, variables['first'], variables['after']);
      return ok({ webhookSubscriptions: { nodes: result.nodes, pageInfo: result.pageInfo } });
    }
    case 'BridgeWebhookSubscriptionCreate': {
      const topic = typeof variables['topic'] === 'string' ? variables['topic'] : '';
      const input = isRecord(variables['webhookSubscription']) ? variables['webhookSubscription'] : {};
      const uri = typeof input['uri'] === 'string' ? input['uri'] : '';
      if (topic === '' || uri === '') {
        return ok({ webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['topic'], message: 'Topic is invalid' }] } });
      }
      const created: FakeWebhookSubscription = {
        id: `gid://shopify/WebhookSubscription/${shop.webhooks.length + 1}`,
        topic,
        uri,
        format: typeof input['format'] === 'string' ? input['format'] : 'JSON',
      };
      shop.webhooks.push(created);
      return ok({ webhookSubscriptionCreate: { webhookSubscription: { id: created.id, topic, uri }, userErrors: [] } });
    }
    default:
      return jsonResponse(200, { errors: [{ message: 'Operação desconhecida na Shopify falsa', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }, versionHeader);
  }
}

// ---------------------------------------------------------------------------
// Storefront API (cartCreate)
// ---------------------------------------------------------------------------

interface CartLineOut {
  id: string;
  quantity: number;
  cost: { amountPerQuantity: { amount: string; currencyCode: string } };
  merchandise: { id: string; availableForSale: boolean };
}

function money(amount: number): string {
  return amount.toFixed(2);
}

function storefrontGraphql(shop: FakeShop, headers: Record<string, string>, json: unknown): Response {
  const { storefront } = shop;
  if (storefront.mode === 'network_error') throw new TypeError('fetch failed');
  if (storefront.mode === 'outage') return jsonResponse(503, { errors: 'Service Unavailable' });
  if (storefront.mode === 'security_rejected') return new Response('Request rejected', { status: 430 });
  if (storefront.mode === 'throttled') {
    return jsonResponse(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
  }

  const token = headers['x-shopify-storefront-access-token'] ?? headers['shopify-storefront-private-token'];
  if (token !== undefined && token !== shop.storefrontToken) {
    return jsonResponse(401, { errors: [{ message: 'Invalid Storefront access token', extensions: { code: 'UNAUTHORIZED' } }] });
  }
  if (!isRecord(json) || operationName(json) !== 'CartCreate') {
    return jsonResponse(200, { errors: [{ message: 'Operação desconhecida', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });
  }
  const variables = isRecord(json['variables']) ? json['variables'] : {};
  const input = isRecord(variables['input']) ? variables['input'] : {};
  const requestedLines = Array.isArray(input['lines']) ? (input['lines'] as unknown[]) : [];

  storefront.cartsCreated += 1;
  const cartToken = `c1-${shop.domain.split('.')[0]}-${String(storefront.cartsCreated).padStart(4, '0')}`;
  const key = `k${storefront.cartsCreated}abcdef`;
  const lines: CartLineOut[] = [];
  const warnings: Array<{ code: string; message: string; target: string | null }> = [];
  let subtotal = 0;
  let lineSeq = 0;

  for (const raw of requestedLines) {
    if (!isRecord(raw)) continue;
    const variantId = fromGidLoose(raw['merchandiseId']);
    const quantity = typeof raw['quantity'] === 'number' ? raw['quantity'] : 0;
    const variant = variantId === null ? undefined : shop.variants.find((v) => v.variantId === variantId);
    if (variantId === null || variant === undefined) {
      return jsonResponse(200, {
        data: {
          cartCreate: {
            cart: null,
            userErrors: [{ code: 'INVALID', field: ['input', 'lines'], message: 'The merchandise with id does not exist' }],
            warnings: [],
          },
        },
      });
    }
    // Variante não publicada no canal: some do carrinho sem deixar rastro (relato de fórum).
    if (storefront.vanished.has(variantId)) continue;
    lineSeq += 1;
    const lineId = `gid://shopify/CartLine/${lineSeq}?cart=${cartToken}`;
    const unitPrice = storefront.livePrice.get(variantId) ?? variant.price;
    if (storefront.outOfStock.has(variantId)) {
      warnings.push({ code: 'MERCHANDISE_OUT_OF_STOCK', message: 'The merchandise is out of stock', target: lineId });
      lines.push({ id: lineId, quantity: 0, cost: { amountPerQuantity: { amount: unitPrice, currencyCode: shop.currency } }, merchandise: { id: variantGid(variantId), availableForSale: false } });
      continue;
    }
    subtotal += Number(unitPrice) * quantity;
    lines.push({
      id: lineId,
      quantity,
      cost: { amountPerQuantity: { amount: unitPrice, currencyCode: shop.currency } },
      merchandise: { id: variantGid(variantId), availableForSale: variant.availableForSale },
    });
  }

  const discountCodes = Array.isArray(input['discountCodes'])
    ? (input['discountCodes'] as unknown[]).filter((c): c is string => typeof c === 'string').map((code) => ({ code, applicable: false }))
    : [];
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  return jsonResponse(200, {
    data: {
      cartCreate: {
        cart: {
          id: `gid://shopify/Cart/${cartToken}?key=${key}`,
          // Como na Shopify real, a URL de checkout fica no domínio principal da loja.
          checkoutUrl: `https://${shop.primaryDomainHost ?? shop.domain}/cart/c/${cartToken}?key=${key}`,
          totalQuantity,
          cost: {
            subtotalAmount: { amount: money(subtotal), currencyCode: shop.currency },
            totalAmount: { amount: money(subtotal), currencyCode: shop.currency },
          },
          lines: { nodes: lines },
          discountCodes,
        },
        userErrors: [],
        warnings,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Token (client credentials) e o fetch roteirizado
// ---------------------------------------------------------------------------

function tokenEndpoint(shop: FakeShop, body: string): Response {
  const params = new URLSearchParams(body);
  if (params.get('grant_type') !== 'client_credentials') {
    return jsonResponse(400, { error: 'unsupported_grant_type' });
  }
  if (params.get('client_id') !== shop.clientId || params.get('client_secret') !== shop.clientSecret) {
    return jsonResponse(401, { error: 'invalid_client' });
  }
  const token = `shpat_fake_${shop.domain.split('.')[0]}_${shop.issuedTokens.size + 1}`;
  shop.issuedTokens.add(token);
  return jsonResponse(200, { access_token: token, scope: shop.scopes.join(','), expires_in: 86399 });
}

export function createFakeShopify(): FakeShopify {
  const shops = new Map<string, FakeShop>();
  const requests: RecordedRequest[] = [];

  function addShop(init: FakeShopInit): FakeShop {
    const shop: FakeShop = {
      domain: init.domain,
      clientId: init.clientId,
      clientSecret: init.clientSecret,
      name: init.name ?? `Loja ${init.domain}`,
      currency: init.currency ?? 'BRL',
      primaryDomainHost: init.primaryDomainHost === undefined ? null : init.primaryDomainHost,
      scopes: init.scopes ?? ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders'],
      storefrontToken: init.storefrontToken ?? null,
      variants: init.variants ?? [],
      webhooks: [],
      issuedTokens: new Set(),
      storefront: { mode: 'ok', outOfStock: new Set(), vanished: new Set(), livePrice: new Map(), cartsCreated: 0 },
      adminOutage: false,
    };
    shops.set(shop.domain, shop);
    return shop;
  }

  function shop(domain: string): FakeShop {
    const found = shops.get(domain);
    if (found === undefined) throw new Error(`Shopify falsa: loja desconhecida ${domain}`);
    return found;
  }

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = headersToRecord(init, input);
    const body = await bodyText(init, input);
    let json: unknown = null;
    try {
      json = body === '' ? null : JSON.parse(body);
    } catch {
      json = null;
    }
    const target = shops.get(url.hostname) ?? null;
    let kind: RequestKind = 'unknown';
    if (url.pathname === '/admin/oauth/access_token') kind = 'token';
    else if (API_VERSION_RE.test(url.pathname)) kind = 'admin';
    else if (STOREFRONT_RE.test(url.pathname)) kind = 'storefront';
    requests.push({ kind, shop: target?.domain ?? null, method, url: urlText, headers, body, json, operation: operationName(json) });

    if (target === null) return new Response('Not Found', { status: 404 });
    if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    switch (kind) {
      case 'token':
        return tokenEndpoint(target, body);
      case 'admin':
        return adminGraphql(target, headers, json);
      case 'storefront':
        return storefrontGraphql(target, headers, json);
      default:
        return new Response('Not Found', { status: 404 });
    }
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    addShop,
    shop,
    requestsOf: (kind, domain) => requests.filter((r) => r.kind === kind && (domain === undefined || r.shop === domain)),
    clearRequests: () => {
      requests.length = 0;
    },
  };
}
