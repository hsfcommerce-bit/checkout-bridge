import { isIP } from 'node:net';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { systemClock } from '../lib/clock.ts';
import { safeJsonParse, truncate } from '../lib/http.ts';
import {
  CircuitOpenError,
  HttpStatusError,
  TimeoutError,
  createBreakerRegistry,
  fetchWithTimeout,
  isRetryableError,
  parseRetryAfterMs,
  retry,
} from '../lib/resilience.ts';
import type { BreakerState } from '../lib/resilience.ts';
import { fromGid, normalizeCountryCode, toGid } from '../lib/shop.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type {
  Alerter,
  BridgeErrorCode,
  CartCreateInput,
  CartCreateResult,
  CartLineResult,
  CartWarning,
  Clock,
  Logger,
  Metrics,
  Store,
  StoreRepo,
  StorefrontClient,
  VisitorConsent,
} from '../types.ts';

/**
 * Cliente da Storefront API da loja checkout: uma única operação, cartCreate.
 *
 * Este módulo só transporta e traduz. Ele NÃO decide se o carrinho devolvido corresponde
 * ao que foi pedido: userErrors vazio não significa carrinho correto (falta de estoque
 * chega em `warnings`, e há relato de variante não publicada sumir sem erro). Quem compara
 * linhas, quantidades e avisos é o serviço de checkout.
 *
 * O circuit breaker daqui protege a API de UMA loja contra chamadas inúteis enquanto ela
 * está fora do ar. Circuito aberto significa erro de indisponibilidade para o comprador;
 * ele nunca é usado para escolher outra loja de destino.
 */

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * $first é o número de linhas enviadas (1 a 250): o custo da consulta cresce com o tamanho
 * da página pedida, e o acesso sem token tem limite de complexidade 1000.
 */
const SELECTION = `{
  cartCreate(input: $input) {
    cart {
      id
      checkoutUrl
      totalQuantity
      cost {
        subtotalAmount { amount currencyCode }
        totalAmount { amount currencyCode }
      }
      lines(first: $first) {
        nodes {
          id
          quantity
          cost { amountPerQuantity { amount currencyCode } }
          merchandise { ... on ProductVariant { id availableForSale } }
        }
      }
      discountCodes { code applicable }
    }
    userErrors { code field message }
    warnings { code message target }
  }
}`;

/**
 * Textos fixos, montados uma vez na carga do módulo. Nenhum valor de requisição entra no
 * texto da consulta; idioma e consentimento viajam como variáveis GraphQL.
 *
 * @inContext só leva idioma e consentimento. O país vai em buyerIdentity.countryCode, que
 * em carrinhos tem precedência sobre o país da diretiva (um país na diretiva seria ignorado).
 */
const QUERIES = {
  plain: `mutation CartCreate($input: CartInput!, $first: Int!) ${SELECTION}`,
  language: `mutation CartCreate($input: CartInput!, $first: Int!, $language: LanguageCode) @inContext(language: $language) ${SELECTION}`,
  consent: `mutation CartCreate($input: CartInput!, $first: Int!, $visitorConsent: VisitorConsent) @inContext(visitorConsent: $visitorConsent) ${SELECTION}`,
  language_consent: `mutation CartCreate($input: CartInput!, $first: Int!, $language: LanguageCode, $visitorConsent: VisitorConsent) @inContext(language: $language, visitorConsent: $visitorConsent) ${SELECTION}`,
} as const;

type QueryKey = keyof typeof QUERIES;

const MAX_LINES = 250;
const RETRIES = 2;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 1000;
const THROTTLE_WAIT_MS = 1000;
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;
const REDACTED = '[redigido]';

const BREAKER_GAUGE: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

// ---------------------------------------------------------------------------
// Idioma e consentimento
// ---------------------------------------------------------------------------

const LANGUAGE_TAG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/;

/**
 * Únicos valores de LanguageCode com região. Para os demais idiomas o enum só tem o código
 * primário, então "en-US" vira "EN" (mandar "EN_US" faria a Shopify recusar a consulta).
 * A lista completa do enum não é copiada para cá: um código primário que a Shopify não
 * conheça cai na nova tentativa sem @inContext.
 */
const REGIONAL_LANGUAGE_CODES = new Set(['PT_BR', 'PT_PT', 'ZH_CN', 'ZH_TW']);

/** "pt-BR" -> "PT_BR". Devolve null (idioma descartado) quando a entrada não é uma tag de idioma. */
function toLanguageCode(language: unknown): string | null {
  if (typeof language !== 'string') return null;
  const tag = language.trim();
  if (!LANGUAGE_TAG_RE.test(tag)) return null;
  const parts = tag.split(/[-_]/);
  const primary = (parts[0] ?? '').toUpperCase();
  const region = parts.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
  if (region !== undefined) {
    const regional = `${primary}_${region.toUpperCase()}`;
    if (REGIONAL_LANGUAGE_CODES.has(regional)) return regional;
  }
  return primary;
}

/** Só segue adiante um consentimento completo e bem formado; o resto é descartado. */
function toVisitorConsent(consent: unknown): VisitorConsent | null {
  if (typeof consent !== 'object' || consent === null) return null;
  const c = consent as Record<string, unknown>;
  if (
    typeof c.analytics !== 'boolean' ||
    typeof c.marketing !== 'boolean' ||
    typeof c.preferences !== 'boolean' ||
    typeof c.saleOfData !== 'boolean'
  ) {
    return null;
  }
  return { analytics: c.analytics, marketing: c.marketing, preferences: c.preferences, saleOfData: c.saleOfData };
}

function pickQuery(hasLanguage: boolean, hasConsent: boolean): QueryKey {
  if (hasLanguage && hasConsent) return 'language_consent';
  if (hasLanguage) return 'language';
  return hasConsent ? 'consent' : 'plain';
}

/**
 * Erro GraphQL de topo causado pelos argumentos da diretiva (idioma fora do enum, versão
 * sem visitorConsent). O formato exato desses erros não é documentado; o casamento é pelo
 * nome dos argumentos e tipos na mensagem ou em extensions. Precisa de teste em loja real.
 */
const CONTEXT_ERROR_RE = /\b(?:inContext|language|LanguageCode|visitorConsent|VisitorConsent)\b/i;

// ---------------------------------------------------------------------------
// Formato da resposta
// ---------------------------------------------------------------------------

const moneySchema = z.object({
  // Decimal chega como string ("39.99"); número é aceito por defesa e convertido.
  amount: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .pipe(z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/)),
  currencyCode: z.string().min(1),
});

const cartSchema = z.object({
  id: z.string().min(1),
  checkoutUrl: z.string(),
  totalQuantity: z.number().nullish(),
  cost: z.object({ subtotalAmount: moneySchema, totalAmount: moneySchema }),
  lines: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        quantity: z.number().int(),
        cost: z.object({ amountPerQuantity: moneySchema }),
        merchandise: z.object({ id: z.string(), availableForSale: z.boolean() }),
      }),
    ),
  }),
  discountCodes: z.array(z.object({ code: z.string(), applicable: z.boolean() })).nullish(),
});

const payloadSchema = z.object({
  cart: z.unknown(),
  userErrors: z
    .array(z.object({ code: z.string().nullish(), field: z.array(z.string()).nullish(), message: z.string() }))
    .nullish(),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), target: z.string().nullish() })).nullish(),
});

const graphqlErrorsSchema = z.array(
  z.object({ message: z.string().nullish(), extensions: z.record(z.string(), z.unknown()).nullish() }),
);

// ---------------------------------------------------------------------------
// Erros internos
// ---------------------------------------------------------------------------

type UpstreamFailureKind = 'security_rejection' | 'throttled' | 'server_error' | 'bad_response' | 'network';

/**
 * Falha de DISPONIBILIDADE da loja (conta para o circuito e vira upstream_unavailable).
 * Recusas da Shopify (userErrors, token, escopo) saem direto como BridgeError e não contam.
 */
class UpstreamFailure extends Error {
  readonly kind: UpstreamFailureKind;
  readonly retryable: boolean;
  /** Lido pelo retry() de lib/resilience.ts como espera mínima antes da nova tentativa. */
  readonly retryAfterMs: number | null;

  constructor(kind: UpstreamFailureKind, opts: { retryable: boolean; retryAfterMs?: number | null }) {
    super(`Storefront API indisponível (${kind})`);
    this.name = 'UpstreamFailure';
    this.kind = kind;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** A Shopify recusou a consulta por causa de @inContext; a operação não chegou a rodar. */
class ContextArgumentError extends Error {
  constructor() {
    super('Argumento de @inContext recusado');
    this.name = 'ContextArgumentError';
  }
}

function isAvailabilityFailure(err: unknown): boolean {
  return err instanceof UpstreamFailure || isRetryableError(err);
}

// ---------------------------------------------------------------------------
// Segredos fora de textos
// ---------------------------------------------------------------------------

/** O id do carrinho é "<token>?key=<segredo>". O carrinho não é reutilizado, então a chave é descartada. */
function stripCartKey(cartId: string): string {
  const cut = cartId.indexOf('?');
  return cut === -1 ? cartId : cartId.slice(0, cut);
}

/**
 * Remove só o parâmetro "key" de um id (linha de carrinho, alvo de aviso), preservando o
 * resto: o id de linha traz "?cart=<token>" e precisa continuar igual ao `target` dos avisos.
 */
function stripKeyParam(id: string): string {
  const cut = id.indexOf('?');
  if (cut === -1) return id;
  const kept = id
    .slice(cut + 1)
    .split('&')
    .filter((part) => part !== '' && !/^key(?:=|$)/i.test(part));
  return kept.length > 0 ? `${id.slice(0, cut)}?${kept.join('&')}` : id.slice(0, cut);
}

/** Texto vindo da Shopify, pronto para details e log: sem chave de carrinho, sem token, curto. */
function makeScrubber(token: string | null): (text: string) => string {
  return (text) => {
    let out = text.replace(/([?&]key=)[^&\s"'<>]+/gi, `$1${REDACTED}`);
    if (token !== null && token !== '') out = out.split(token).join(REDACTED);
    return truncate(out, 300);
  };
}

// ---------------------------------------------------------------------------
// Recusas e tradução da resposta
// ---------------------------------------------------------------------------

/**
 * Classes de CartErrorCode que são determinísticas para o MESMO carrinho: repetir não
 * resolve, então cada uma vira o código de negócio próprio (e não upstream_rejected, cuja
 * mensagem pública manda tentar de novo) e avisa o lojista. Qualquer outro código (INVALID,
 * CART_TOO_LARGE, SERVICE_UNAVAILABLE...) continua upstream_rejected.
 * Fonte: https://shopify.dev/docs/api/storefront/latest/enums/CartErrorCode
 */
type UserErrorKind = 'quantity_rule' | 'selling_plan' | 'merchandise' | 'validation_custom';

const USER_ERROR_KIND: Readonly<Record<string, UserErrorKind>> = {
  // Regras de quantidade do catálogo (mínimo, máximo, incremento) [PT-85].
  MAXIMUM_EXCEEDED: 'quantity_rule',
  MINIMUM_NOT_MET: 'quantity_rule',
  INVALID_INCREMENT: 'quantity_rule',
  // Planos de venda / assinaturas [PT-50].
  VARIANT_REQUIRES_SELLING_PLAN: 'selling_plan',
  SELLING_PLAN_NOT_APPLICABLE: 'selling_plan',
  // Mercadoria recusada para esta linha.
  MERCHANDISE_NOT_APPLICABLE: 'merchandise',
  INVALID_MERCHANDISE_LINE: 'merchandise',
  // Function de validação de checkout instalada na loja checkout.
  VALIDATION_CUSTOM: 'validation_custom',
};

const USER_ERROR_CODE: Readonly<Record<UserErrorKind, BridgeErrorCode>> = {
  quantity_rule: 'quantity_exceeded',
  selling_plan: 'selling_plan_unsupported',
  merchandise: 'variant_unavailable',
  validation_custom: 'checkout_validation',
};

/** O primeiro userError com código conhecido decide a classe; sem nenhum, null. */
function classifyUserErrors(codes: Array<string | null>): UserErrorKind | null {
  for (const code of codes) {
    if (code !== null && Object.hasOwn(USER_ERROR_KIND, code)) return USER_ERROR_KIND[code] ?? null;
  }
  return null;
}

/**
 * Recusa da Shopify: upstream_rejected por padrão, ou o código de negócio de um userError
 * determinístico. Carrega o rótulo usado na métrica de requisições.
 */
class StorefrontRejection extends BridgeError {
  readonly label: 'rejected' | 'user_errors' | 'auth';
  /** Classe do userError determinístico, para o alerta ao lojista; null nas demais recusas. */
  readonly userErrorKind: UserErrorKind | null;

  constructor(
    label: 'rejected' | 'user_errors' | 'auth',
    message: string,
    details: Record<string, unknown>,
    classified: { code: BridgeErrorCode; kind: UserErrorKind } | null = null,
  ) {
    super(classified?.code ?? 'upstream_rejected', message, details);
    this.label = label;
    this.userErrorKind = classified?.kind ?? null;
  }
}

function unexpectedResponse(extra: Record<string, unknown> = {}): StorefrontRejection {
  return new StorefrontRejection('rejected', 'Resposta do cartCreate em formato inesperado', {
    reason: 'unexpected_response',
    ...extra,
  });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Traduz o payload de cartCreate. Lança upstream_rejected para userErrors, carrinho nulo,
 * checkoutUrl que não é https e formato inesperado. Não compara o carrinho com o pedido.
 */
function mapPayload(raw: unknown, first: number, scrub: (text: string) => string): CartCreateResult {
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) throw unexpectedResponse();

  const userErrors = payload.data.userErrors ?? [];
  if (userErrors.length > 0) {
    const safeErrors = userErrors.slice(0, 20).map((e) => ({
      code: e.code ?? null,
      field: e.field ?? null,
      message: scrub(e.message),
    }));
    const kind = classifyUserErrors(userErrors.map((e) => e.code ?? null));
    if (kind === null) {
      throw new StorefrontRejection('user_errors', 'A Shopify recusou a criação do carrinho', { userErrors: safeErrors });
    }
    throw new StorefrontRejection(
      'user_errors',
      `A Shopify recusou o carrinho por motivo determinístico (${kind})`,
      { userErrors: safeErrors, kind },
      { code: USER_ERROR_CODE[kind], kind },
    );
  }
  if (payload.data.cart === null || payload.data.cart === undefined) {
    throw new StorefrontRejection('rejected', 'A Shopify não devolveu o carrinho', { reason: 'null_cart' });
  }

  const parsedCart = cartSchema.safeParse(payload.data.cart);
  if (!parsedCart.success) {
    // Só os caminhos dos campos: as mensagens do validador podem citar valores recebidos.
    throw unexpectedResponse({ paths: parsedCart.error.issues.slice(0, 5).map((issue) => issue.path.join('.')) });
  }
  const cart = parsedCart.data;
  // checkoutUrl é opaca (o host não é documentado) e carrega a chave do carrinho: é
  // devolvida a quem chamou para o redirecionamento, mas nunca entra em log nem em details.
  if (!isHttpsUrl(cart.checkoutUrl)) {
    throw new StorefrontRejection('rejected', 'A Shopify devolveu uma URL de checkout inválida', {
      reason: 'invalid_checkout_url',
    });
  }

  let quantitySum = 0;
  const lines: CartLineResult[] = cart.lines.nodes.map((node) => {
    let variantId: string;
    try {
      variantId = fromGid(node.merchandise.id);
    } catch {
      throw unexpectedResponse({ paths: ['lines.nodes.merchandise.id'] });
    }
    quantitySum += node.quantity;
    return {
      lineId: stripKeyParam(node.id),
      variantId,
      quantity: node.quantity,
      unitPrice: node.cost.amountPerQuantity.amount,
      currency: node.cost.amountPerQuantity.currencyCode,
      availableForSale: node.merchandise.availableForSale,
    };
  });

  // Página cheia e total maior que a soma lida: o carrinho tem linhas além de $first e a
  // leitura está incompleta. CartCreateResult não tem como expressar isso, e devolver um
  // carrinho parcial faria a conferência do serviço aprovar algo que ela não viu.
  if (lines.length >= first && typeof cart.totalQuantity === 'number' && cart.totalQuantity > quantitySum) {
    throw new StorefrontRejection('rejected', 'O carrinho tem mais linhas do que as lidas', {
      reason: 'cart_lines_truncated',
      requestedLines: first,
      totalQuantity: cart.totalQuantity,
      readQuantity: quantitySum,
    });
  }

  const warnings: CartWarning[] = (payload.data.warnings ?? []).map((warning) => ({
    code: warning.code,
    message: scrub(warning.message),
    target: typeof warning.target === 'string' ? stripKeyParam(warning.target) : null,
  }));

  return {
    cartId: stripCartKey(cart.id),
    checkoutUrl: cart.checkoutUrl,
    currency: cart.cost.totalAmount.currencyCode,
    subtotal: cart.cost.subtotalAmount.amount,
    total: cart.cost.totalAmount.amount,
    lines,
    warnings,
    discountCodes: (cart.discountCodes ?? []).map((d) => ({ code: d.code, applicable: d.applicable })),
  };
}

interface GraphqlTopError {
  code: string | null;
  message: string;
  /** Mensagem mais os campos de extensions que nomeiam variável, argumento ou tipo. */
  probe: string;
}

/** null quando `errors` existe mas não é a lista de erros GraphQL esperada. */
function parseTopErrors(raw: unknown): GraphqlTopError[] | null {
  if (raw === undefined || raw === null) return [];
  const parsed = graphqlErrorsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.map((error) => {
    const ext = error.extensions ?? {};
    const message = error.message ?? '';
    // extensions.value (eco das variáveis enviadas) fica de fora de propósito: atributos
    // do carrinho poderiam conter a palavra "language" e confundir a classificação.
    const named = ['variableName', 'argumentName', 'typeName', 'directiveName', 'name']
      .map((key) => ext[key])
      .filter((value): value is string => typeof value === 'string');
    return {
      code: typeof ext.code === 'string' ? ext.code : null,
      message,
      probe: [message, ...named].join(' '),
    };
  });
}

function attributeList(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { key, value } = item as { key?: unknown; value?: unknown };
    // Só key e value seguem: um campo a mais faria a Shopify recusar o AttributeInput.
    if (typeof key === 'string' && typeof value === 'string') out.push({ key, value });
  }
  return out;
}

function invalidInput(message: string, details: Record<string, unknown> = {}): BridgeError {
  return new BridgeError('invalid_request', message, details);
}

/** Monta CartInput. Preço não existe em CartLineInput: ele sempre vem do catálogo da loja checkout. */
function buildCartInput(input: CartCreateInput): { input: Record<string, unknown>; first: number } {
  const rawLines: unknown = input?.lines;
  if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > MAX_LINES) {
    throw invalidInput('O carrinho deve ter de 1 a 250 linhas', { field: 'lines' });
  }
  const lines = input.lines.map((line, index) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw invalidInput('Quantidade inválida', { field: `lines.${index}.quantity` });
    }
    let merchandiseId: string;
    try {
      merchandiseId = toGid('ProductVariant', line.variantId);
    } catch {
      throw invalidInput('ID de variante inválido', { field: `lines.${index}.variantId` });
    }
    return { merchandiseId, quantity: line.quantity, attributes: attributeList(line.attributes) };
  });

  const cartInput: Record<string, unknown> = { lines, attributes: attributeList(input.attributes) };

  if (input.countryCode !== undefined && input.countryCode !== null && input.countryCode !== '') {
    // País define mercado e moeda do carrinho. Um valor ilegível não é descartado em
    // silêncio: sem ele a Shopify precificaria pelo mercado principal.
    const countryCode = normalizeCountryCode(input.countryCode);
    if (countryCode === null) throw invalidInput('País inválido', { field: 'countryCode' });
    cartInput.buyerIdentity = { countryCode };
  }

  const discountCodes = Array.isArray(input.discountCodes)
    ? input.discountCodes.filter((code): code is string => typeof code === 'string' && code.trim() !== '')
    : [];
  if (discountCodes.length > 0) cartInput.discountCodes = discountCodes;

  return { input: cartInput, first: lines.length };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

/** Tudo o que uma chamada precisa, resolvido antes do primeiro acesso à rede. */
interface CallContext {
  store: Store;
  url: string;
  headers: Record<string, string>;
  variables: { input: Record<string, unknown>; first: number };
  language: string | null;
  consent: VisitorConsent | null;
  buyerIpSent: boolean;
  scrub: (text: string) => string;
}

const TOKEN_RE = /^[\x21-\x7e]+$/;

function resultLabel(err: unknown): string {
  if (err instanceof StorefrontRejection) return err.label;
  if (err instanceof UpstreamFailure) return err.kind;
  if (err instanceof ContextArgumentError) return 'context_error';
  if (err instanceof TimeoutError) return 'timeout';
  if (err instanceof HttpStatusError) return 'http_error';
  return isRetryableError(err) ? 'network' : 'error';
}

export function createStorefrontClient(deps: {
  stores: StoreRepo;
  config: Pick<Config, 'shopifyApiVersion' | 'upstreamTimeoutMs'>;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): StorefrontClient {
  const { logger, metrics, alerter } = deps;
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = deps.clock ?? systemClock;
  /** Domínio da loja por id, só para dar contexto aos alertas de circuito. */
  const domains = new Map<string, string>();

  const breakers = createBreakerRegistry({
    failureThreshold: BREAKER_FAILURE_THRESHOLD,
    openMs: BREAKER_OPEN_MS,
    clock,
    onStateChange(storeId, state) {
      const shopDomain = domains.get(storeId) ?? null;
      metrics.gauge('bridge_storefront_circuit_state', BREAKER_GAUGE[state], { store: storeId });
      logger.warn({ storeId, shopDomain, state }, 'storefront: circuito mudou de estado');
      const title =
        state === 'open'
          ? `Storefront API da loja ${shopDomain ?? storeId} indisponível: circuito aberto por ${BREAKER_OPEN_MS / 1000} s. O checkout dessa loja fica fora do ar até ela voltar.`
          : state === 'half_open'
            ? `Storefront API da loja ${shopDomain ?? storeId}: circuito em teste (uma chamada de verificação).`
            : `Storefront API da loja ${shopDomain ?? storeId} voltou a responder: circuito fechado.`;
      alerter.notify({
        key: `storefront_circuit:${storeId}:${state}`,
        severity: state === 'open' ? 'critical' : 'info',
        title,
        detail: { storeId, shopDomain, state },
      });
    },
  });

  function alertAuth(store: Store, cause: Record<string, unknown>): void {
    alerter.notify({
      key: `storefront_auth:${store.id}`,
      severity: 'critical',
      title: `Storefront API da loja ${store.shopDomain} recusou o acesso. Confira o token de Storefront e os escopos unauthenticated_* do app.`,
      detail: { storeId: store.id, shopDomain: store.shopDomain, authMode: store.storefrontAuthMode, ...cause },
    });
  }

  const USER_ERROR_TITLE: Readonly<Record<UserErrorKind, (shopDomain: string) => string>> = {
    quantity_rule: (shopDomain) =>
      `A loja checkout ${shopDomain} recusou um carrinho por regra de quantidade (mínimo, máximo ou incremento) de uma variante. Confira as regras de quantidade do catálogo dessa loja e o maxQuantityPerLine da rota; o comprador não consegue finalizar esse item.`,
    selling_plan: (shopDomain) =>
      `A loja checkout ${shopDomain} recusou um carrinho porque uma variante só pode ser comprada com plano de venda (assinatura), que a ponte não suporta. Confira o mapeamento dessa variante.`,
    merchandise: (shopDomain) =>
      `A loja checkout ${shopDomain} recusou uma variante do carrinho como não aplicável. Confira se a variante existe, está publicada no canal e continua mapeada.`,
    validation_custom: (shopDomain) =>
      `Uma validação de checkout (Function) instalada na loja checkout ${shopDomain} recusou um carrinho. Enquanto ela estiver ativa, os checkouts afetados não vão passar.`,
  };

  /** userError determinístico: o lojista precisa agir; a chave por classe evita repetição. */
  function alertUserErrors(store: Store, err: StorefrontRejection): void {
    const kind = err.userErrorKind;
    if (kind === null) return;
    const userErrors = Array.isArray(err.details.userErrors) ? err.details.userErrors.slice(0, 5) : [];
    alerter.notify({
      key: `storefront_user_errors:${store.id}:${kind}`,
      severity: 'warning',
      title: USER_ERROR_TITLE[kind](store.shopDomain),
      detail: { storeId: store.id, shopDomain: store.shopDomain, kind, code: err.code, userErrors },
    });
  }

  /**
   * Loja congelada (HTTP 402), bloqueada (HTTP 423) ou inativa (SHOP_INACTIVE): recusa que
   * fica fora do circuit breaker de propósito, então o alerta de circuito nunca a cobre.
   * Sem este alerta todo comprador da loja ficaria sem checkout até o lojista reparar.
   */
  function alertShopState(store: Store, cause: Record<string, unknown>): void {
    alerter.notify({
      key: `storefront_shop_state:${store.id}`,
      severity: 'critical',
      title: `A loja checkout ${store.shopDomain} está congelada, bloqueada ou inativa na Shopify (HTTP 402/423 ou SHOP_INACTIVE). O checkout dessa loja fica fora do ar até a loja ser regularizada.`,
      detail: { storeId: store.id, shopDomain: store.shopDomain, ...cause },
    });
  }

  /** Cabeçalhos por modo de autenticação. Lança antes de qualquer chamada de rede. */
  function prepare(store: Store, input: CartCreateInput): CallContext {
    const variables = buildCartInput(input);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    let token: string | null = null;
    let buyerIpSent = false;

    if (store.storefrontAuthMode !== 'tokenless') {
      token = deps.stores.getSecrets(store.id).storefrontToken;
      // Token com espaço ou quebra de linha faria o fetch falhar ao montar o cabeçalho e
      // seria contado como falha de rede; é problema de cadastro, não de disponibilidade.
      if (token === null || !TOKEN_RE.test(token)) {
        const reason = token === null ? 'missing_storefront_token' : 'invalid_storefront_token';
        alertAuth(store, { reason });
        throw new BridgeError('upstream_rejected', 'Loja checkout sem token de Storefront utilizável', {
          reason,
          storeId: store.id,
          authMode: store.storefrontAuthMode,
        });
      }
      if (store.storefrontAuthMode === 'public_token') {
        headers['X-Shopify-Storefront-Access-Token'] = token;
      } else {
        headers['Shopify-Storefront-Private-Token'] = token;
        // Só o IP real do comprador, e só quando é um IP bem formado. Na falta dele o
        // cabeçalho é omitido: nunca se envia um endereço inventado. O cabeçalho só é
        // documentado para chamadas com token privado.
        if (typeof input.buyerIp === 'string' && isIP(input.buyerIp) !== 0) {
          headers['Shopify-Storefront-Buyer-IP'] = input.buyerIp;
          buyerIpSent = true;
        }
      }
    }

    return {
      store,
      url: `https://${store.shopDomain}/api/${deps.config.shopifyApiVersion}/graphql.json`,
      headers,
      variables,
      language: toLanguageCode(input.language),
      consent: toVisitorConsent(input.consent),
      buyerIpSent,
      scrub: makeScrubber(token),
    };
  }

  /** Uma troca HTTP, classificada. Não repete nada. */
  async function exchange(call: CallContext, queryKey: QueryKey): Promise<CartCreateResult> {
    const { store } = call;
    const variables: Record<string, unknown> = { ...call.variables };
    if (queryKey === 'language' || queryKey === 'language_consent') variables.language = call.language;
    if (queryKey === 'consent' || queryKey === 'language_consent') variables.visitorConsent = call.consent;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        call.url,
        {
          method: 'POST',
          headers: call.headers,
          body: JSON.stringify({ query: QUERIES[queryKey], variables }),
          // Redirecionamento não é seguido: o fetch reenviaria o cabeçalho do token ao
          // novo host e trocaria o POST por GET. Um 3xx aqui é tratado como recusa.
          redirect: 'manual',
        },
        deps.config.upstreamTimeoutMs,
      );
    } catch (err) {
      if (isRetryableError(err)) throw err;
      // Erro do fetch que não parece rede (cabeçalho inválido, por exemplo): repetir não
      // resolve. A mensagem original não é propagada porque pode citar o cabeçalho.
      throw new UpstreamFailure('network', { retryable: false });
    }

    const status = res.status;
    if (status === 430) {
      alerter.notify({
        key: `storefront_430:${store.id}`,
        severity: 'critical',
        title: `A Shopify bloqueou a criação de carrinho na loja ${store.shopDomain} (HTTP 430, rejeição de segurança). Use um token privado de Storefront com o cabeçalho Shopify-Storefront-Buyer-IP levando o IP real do comprador.`,
        detail: {
          storeId: store.id,
          shopDomain: store.shopDomain,
          status,
          authMode: store.storefrontAuthMode,
          buyerIpSent: call.buyerIpSent,
        },
      });
      throw new UpstreamFailure('security_rejection', { retryable: false });
    }
    if (status === 401 || status === 403) {
      alertAuth(store, { status });
      throw new StorefrontRejection('auth', 'A Storefront API recusou as credenciais da loja', { status });
    }
    if (status === 429 || status >= 500) {
      // 429 não é documentado para a Storefront API; se vier, vale como indisponibilidade.
      throw new HttpStatusError(status, {
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), clock.now()),
      });
    }
    if (status < 200 || status >= 300) {
      // 402 (loja congelada), 404, 423 (loja bloqueada) e qualquer outro estado: recusa.
      // Os dois estados da loja alertam; 404, 3xx e 400 são erro de configuração que o
      // relatório de conexão já mostra.
      if (status === 402 || status === 423) alertShopState(store, { status });
      throw new StorefrontRejection('rejected', `A Storefront API respondeu HTTP ${status}`, { status });
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new UpstreamFailure('bad_response', { retryable: true });
    }
    const parsed = safeJsonParse<unknown>(text);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      throw new UpstreamFailure('bad_response', { retryable: true });
    }
    const body = parsed.value as { data?: unknown; errors?: unknown };

    // Limite de criação de checkout e falta de acesso chegam com HTTP 200: é preciso ler o corpo.
    const topErrors = parseTopErrors(body.errors);
    if (topErrors === null) throw unexpectedResponse();
    if (topErrors.length > 0) {
      const codes = new Set(topErrors.map((error) => error.code));
      if (codes.has('THROTTLED')) {
        throw new UpstreamFailure('throttled', { retryable: true, retryAfterMs: THROTTLE_WAIT_MS });
      }
      if (codes.has('ACCESS_DENIED')) {
        alertAuth(store, { code: 'ACCESS_DENIED' });
        throw new StorefrontRejection('auth', 'A Storefront API negou o acesso (token ou escopo)', {
          code: 'ACCESS_DENIED',
        });
      }
      if (codes.has('SHOP_INACTIVE')) {
        alertShopState(store, { code: 'SHOP_INACTIVE' });
        throw new StorefrontRejection('rejected', 'A loja checkout está inativa', { code: 'SHOP_INACTIVE' });
      }
      if (codes.has('INTERNAL_SERVER_ERROR')) throw new UpstreamFailure('server_error', { retryable: true });
      if (queryKey !== 'plain' && topErrors.some((error) => CONTEXT_ERROR_RE.test(error.probe))) {
        throw new ContextArgumentError();
      }
      throw new StorefrontRejection('rejected', 'A Storefront API recusou a consulta', {
        graphqlErrors: topErrors.slice(0, 5).map((error) => ({ code: error.code, message: call.scrub(error.message) })),
      });
    }

    const data = body.data;
    const cartCreate =
      typeof data === 'object' && data !== null ? (data as { cartCreate?: unknown }).cartCreate : undefined;
    if (cartCreate === undefined || cartCreate === null) throw unexpectedResponse();
    return mapPayload(cartCreate, call.variables.first, call.scrub);
  }

  async function sendOnce(call: CallContext, queryKey: QueryKey): Promise<CartCreateResult> {
    const startedAt = clock.now().getTime();
    let result = 'ok';
    try {
      return await exchange(call, queryKey);
    } catch (err) {
      result = resultLabel(err);
      throw err;
    } finally {
      metrics.inc('bridge_storefront_requests_total', { result });
      metrics.observe('bridge_storefront_request_ms', Math.max(0, clock.now().getTime() - startedAt));
    }
  }

  /** Converte a falha final em BridgeError. Os details são seguros por construção. */
  function toBridgeError(err: unknown, store: Store): BridgeError {
    if (isBridgeError(err)) return err;
    const unavailable = (message: string, details: Record<string, unknown>): BridgeError =>
      new BridgeError('upstream_unavailable', message, details);
    if (err instanceof CircuitOpenError) {
      // Nenhuma requisição saiu; o rótulo próprio deixa isso visível na métrica.
      metrics.inc('bridge_storefront_requests_total', { result: 'circuit_open' });
      return unavailable('Circuito aberto para a Storefront API da loja', { circuit: 'open' });
    }
    if (err instanceof UpstreamFailure) {
      return err.kind === 'security_rejection'
        ? unavailable('A Shopify rejeitou a chamada por segurança (HTTP 430)', { status: 430 })
        : unavailable('Storefront API indisponível', { reason: err.kind });
    }
    if (err instanceof TimeoutError) return unavailable('Tempo limite na Storefront API', { reason: 'timeout' });
    if (err instanceof HttpStatusError) {
      return unavailable(`Storefront API respondeu HTTP ${err.status}`, { status: err.status });
    }
    if (isRetryableError(err)) return unavailable('Falha de rede na Storefront API', { reason: 'network' });
    // Só defeito de programação chega aqui. Do erro original só o nome vai para o log.
    logger.error({ storeId: store.id, errorName: err instanceof Error ? err.name : typeof err }, 'storefront: falha inesperada');
    return new BridgeError('internal', 'Falha inesperada no cliente da Storefront API', { storeId: store.id });
  }

  return {
    async createCart(store: Store, input: CartCreateInput): Promise<CartCreateResult> {
      const call = prepare(store, input);
      domains.set(store.id, store.shopDomain);
      let queryKey = pickQuery(call.language !== null, call.consent !== null);
      let throttleRetried = false;

      const attempt = async (): Promise<CartCreateResult> => {
        try {
          return await sendOnce(call, queryKey);
        } catch (err) {
          if (!(err instanceof ContextArgumentError)) throw err;
          // A consulta foi recusada na validação, então nenhum carrinho foi criado: repetir
          // é seguro. Vale uma vez só; daqui em diante a chamada segue sem @inContext
          // (o checkout abre no idioma padrão da loja e sem o consentimento da vitrine).
          logger.warn(
            { storeId: store.id, shopDomain: store.shopDomain, query: queryKey },
            'storefront: @inContext recusado, repetindo sem idioma e consentimento',
          );
          queryKey = 'plain';
          return await sendOnce(call, queryKey);
        }
      };

      try {
        // O circuito conta a chamada inteira (já com as novas tentativas) como uma falha.
        return await breakers.get(store.id).exec(
          () =>
            retry(attempt, {
              retries: RETRIES,
              baseDelayMs: RETRY_BASE_MS,
              maxDelayMs: RETRY_MAX_MS,
              sleep: deps.sleep,
              random: deps.random,
              shouldRetry(err) {
                if (!(err instanceof UpstreamFailure)) return isRetryableError(err);
                if (err.kind !== 'throttled') return err.retryable;
                // Limite de criação de checkout: uma única nova tentativa, cerca de 1 s depois.
                if (throttleRetried) return false;
                throttleRetried = true;
                return true;
              },
              onRetry(err, attemptIndex, delayMs) {
                logger.warn(
                  { storeId: store.id, shopDomain: store.shopDomain, attempt: attemptIndex, delayMs, result: resultLabel(err) },
                  'storefront: nova tentativa',
                );
              },
            }),
          isAvailabilityFailure,
        );
      } catch (err) {
        const bridgeError = toBridgeError(err, store);
        if (bridgeError instanceof StorefrontRejection) alertUserErrors(store, bridgeError);
        logger.warn(
          { storeId: store.id, shopDomain: store.shopDomain, code: bridgeError.code, details: bridgeError.details },
          'storefront: cartCreate falhou',
        );
        throw bridgeError;
      }
    },
  };
}
