import type { Config } from '../config.ts';
import { systemClock } from '../lib/clock.ts';
import { deriveKey, randomId, sha256Hex } from '../lib/crypto.ts';
import { hashIp } from '../lib/http.ts';
import { formatMoney, withinTolerance } from '../lib/money.ts';
import { isValidVariantId, normalizeCountryCode } from '../lib/shop.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type {
  Alerter,
  BridgeErrorCode,
  CartCreateResult,
  CartLineInput,
  CatalogVariant,
  CheckoutRequest,
  CheckoutResponse,
  CheckoutService,
  CheckoutSession,
  Clock,
  Link,
  LinkTestProblem,
  LinkTestResult,
  Logger,
  Metrics,
  Repos,
  RequestContext,
  SessionLine,
  SessionStrategy,
  Store,
  StorefrontClient,
  VariantMapping,
} from '../types.ts';
import { computeIdempotencyKey } from './idempotency.ts';
import { buildCartPermalink } from './permalink.ts';
import { resolveLink } from './routing.ts';
import { ATTRIBUTION_KEYS } from './schema.ts';

/**
 * Serviço de checkout: recebe as linhas do carrinho da vitrine (variante e quantidade,
 * nunca preço), resolve a rota e o mapeamento e cria o checkout na loja de destino.
 *
 * Duas garantias orientam o código:
 * - preço vem sempre do catálogo da loja checkout; o que chega do navegador serve só
 *   para identificar variantes e quantidades;
 * - o comprador nunca é mandado para um checkout diferente do que a vitrine mostrou sem
 *   que o lojista fique sabendo: na dúvida o checkout é recusado e um alerta é emitido.
 *
 * A loja de destino sai da rota configurada pelo lojista e de mais nada. Uma falha da
 * loja checkout faz o checkout falhar; nunca desvia o comprador para outra loja.
 */

export interface CheckoutServiceDeps {
  repos: Repos;
  storefront: StorefrontClient;
  config: Pick<Config, 'sessionTtlMinutes' | 'encryptionKey'>;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Teto de linhas por checkout, qualquer que seja o limite da rota. A Shopify aceita 250
 * por chamada, mas a complexidade da consulta de conferência cresce com as linhas e o
 * acesso sem token tem teto de complexidade 1.000.
 */
const HARD_MAX_LINES = 100;

/** Espera por uma requisição concorrente do mesmo carrinho: 30 x 100 ms = cerca de 3 s. */
const PENDING_POLL_MS = 100;
const PENDING_WAIT_MS = 3000;

/**
 * Sem token de carrinho (compra direta), a idempotência só existe para absorver clique
 * duplo. A janela curta reduz a chance de dois compradores atrás do mesmo IP, com o mesmo
 * navegador e o mesmo item, receberem o MESMO carrinho.
 */
const NO_TOKEN_WINDOW_MS = 10_000;

/**
 * Códigos com que uma sessão concorrente pode ter falhado e que NÃO fazem sentido repassar
 * ao segundo comprador: são falhas transitórias ou internas, e "tente de novo em instantes"
 * é a resposta certa. Qualquer outro código (preço, estoque, recusa da Shopify) é repassado.
 */
const RETRY_AGAIN_CODES: ReadonlySet<BridgeErrorCode> = new Set<BridgeErrorCode>([
  'internal',
  'upstream_unavailable',
  'conflict',
  'not_found',
  'rate_limited',
]);

const DEFAULT_TEST_SAMPLE = 10;
const MAX_TEST_SAMPLE = 50;
const SAMPLE_CHUNK = 50;
/** Quantos itens entram em details/alertas; o resto vira só a contagem. */
const MAX_DETAIL_ITEMS = 20;

/** Avisos que significam "o carrinho não tem o que foi pedido". */
const STOCK_WARNING_CODES = new Set([
  'MERCHANDISE_OUT_OF_STOCK',
  'MERCHANDISE_NOT_ENOUGH_STOCK',
  'PRODUCT_UNAVAILABLE_IN_BUYER_LOCATION',
]);

/** Parâmetros acrescentados à URL final para a primeira sessão na loja checkout. */
const UTM_URL_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

/**
 * Identificadores vindos de cookies do navegador (_fbp, _fbc, _ga, _ttp). Seguem como
 * atributos do carrinho pela Storefront API, mas ficam fora do permalink: lá o único
 * transporte é a própria URL, que passa por redirecionamentos, logs e Referer.
 */
const COOKIE_ID_KEYS = new Set(['fbp', 'fbc', 'ga', 'ttp']);

type Attribute = { key: string; value: string };

/** Linha do pedido já resolvida contra rota, mapeamento e os dois catálogos. */
interface ResolvedLine {
  vitrineVariantId: string;
  checkoutVariantId: string;
  quantity: number;
  /** null quando a linha não tem propriedades (e pode ser fundida com outras). */
  properties: Attribute[] | null;
  vitrine: CatalogVariant;
  checkout: CatalogVariant;
}

interface Prepared {
  vitrine: Store;
  checkoutStore: Store;
  link: Link;
  country: string | null;
  lines: ResolvedLine[];
  /** Quantidade total pedida por variante da loja checkout. */
  requested: Map<string, number>;
  hasProperties: boolean;
}

/** O que já se sabe da requisição, para a métrica e o log finais mesmo em caso de erro. */
interface Trace {
  vitrineStoreId: string | null;
  checkoutStoreId: string | null;
  linkId: string | null;
  strategy: SessionStrategy | 'none';
  lineCount: number;
  /** Preenchido só quando ESTA requisição inseriu a sessão (e deve marcá-la em caso de erro). */
  ownedSessionId: string | null;
}

interface PriceDivergence {
  vitrineVariantId: string;
  checkoutVariantId: string;
  kind: 'price' | 'currency';
  vitrine: string;
  checkout: string;
}

interface Outcome {
  strategy: SessionStrategy;
  checkoutUrl: string;
  cartId: string | null;
  subtotal: string | null;
  currency: string | null;
}

interface CartInspection {
  /** Variantes pedidas cuja quantidade devolvida é diferente da pedida. */
  mismatches: Array<{ checkoutVariantId: string; requested: number; returned: number }>;
  /** Variantes no carrinho que ninguém pediu. */
  unexpected: string[];
  /** Avisos de estoque/disponibilidade; a variante é null quando o alvo não está no carrinho. */
  stockWarnings: Array<{ code: string; checkoutVariantId: string | null }>;
  /** Linhas com a quantidade pedida, mas marcadas como não vendáveis. */
  notForSale: string[];
  otherWarningCodes: string[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** true quando o preço do checkout sai da tolerância. Preço ilegível conta como divergente. */
function priceDiverges(vitrinePrice: string, checkoutPrice: string, toleranceBps: number): boolean {
  try {
    return !withinTolerance(vitrinePrice, checkoutPrice, toleranceBps);
  } catch {
    return true;
  }
}

/**
 * Motivo pelo qual a variante não pode ser vendida segundo o catálogo em cache, ou null.
 * Estoque só bloqueia quando é rastreado, a política é DENY e a quantidade é conhecida.
 */
function unavailableReason(variant: CatalogVariant, quantity: number): string | null {
  if (variant.productStatus !== 'ACTIVE' && variant.productStatus !== 'UNLISTED') return 'product_status';
  if (!variant.availableForSale) return 'not_available_for_sale';
  if (
    variant.tracked &&
    variant.inventoryPolicy === 'DENY' &&
    variant.inventoryQuantity !== null &&
    variant.inventoryQuantity < quantity
  ) {
    return 'insufficient_stock';
  }
  return null;
}

function attributionEntries(attribution: Record<string, string> | undefined): Attribute[] {
  if (attribution === undefined || attribution === null || typeof attribution !== 'object') return [];
  const out: Attribute[] = [];
  // A lista de permissão é reaplicada aqui: o serviço não depende de quem o chamou ter
  // passado pelo schema.
  for (const key of ATTRIBUTION_KEYS) {
    if (!Object.hasOwn(attribution, key)) continue;
    const value = attribution[key];
    if (typeof value === 'string' && value !== '') out.push({ key, value });
  }
  return out;
}

/**
 * Linhas do carrinho na loja checkout. Linhas sem propriedades que caem na mesma variante
 * do checkout viram uma só; linha com propriedades (personalização) fica separada e leva
 * as propriedades como atributos da linha.
 */
function buildCartLines(lines: ResolvedLine[]): CartLineInput[] {
  const out: CartLineInput[] = [];
  const plainIndex = new Map<string, number>();
  for (const line of lines) {
    if (line.properties !== null) {
      out.push({ variantId: line.checkoutVariantId, quantity: line.quantity, attributes: line.properties });
      continue;
    }
    const index = plainIndex.get(line.checkoutVariantId);
    const existing = index === undefined ? undefined : out[index];
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      plainIndex.set(line.checkoutVariantId, out.length);
      out.push({ variantId: line.checkoutVariantId, quantity: line.quantity });
    }
  }
  return out;
}

/** Linhas gravadas na sessão: uma por variante da vitrine, sem propriedades (dado do comprador). */
function buildSessionLines(lines: ResolvedLine[]): SessionLine[] {
  const byVariant = new Map<string, SessionLine>();
  for (const line of lines) {
    const existing = byVariant.get(line.vitrineVariantId);
    if (existing) existing.quantity += line.quantity;
    else {
      byVariant.set(line.vitrineVariantId, {
        vitrineVariantId: line.vitrineVariantId,
        checkoutVariantId: line.checkoutVariantId,
        quantity: line.quantity,
      });
    }
  }
  return [...byVariant.values()];
}

/**
 * Compara o carrinho devolvido com o que foi pedido. userErrors vazio não quer dizer que o
 * carrinho está certo: problema de estoque chega em `warnings` com a mutação bem-sucedida,
 * e há relato (fórum, não documentação) de variante não publicada no canal sumir do
 * carrinho sem erro nem aviso. Por isso a conferência é por quantidade, variante a variante.
 */
function inspectCart(requested: Map<string, number>, result: CartCreateResult): CartInspection {
  const returned = new Map<string, number>();
  const variantByLine = new Map<string, string>();
  const notForSale = new Set<string>();
  for (const line of result.lines) {
    variantByLine.set(line.lineId, line.variantId);
    // Linha esgotada pode continuar no carrinho com quantidade 0 (exemplo da documentação).
    const quantity = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    returned.set(line.variantId, (returned.get(line.variantId) ?? 0) + quantity);
    if (quantity > 0 && line.availableForSale === false) notForSale.add(line.variantId);
  }
  const mismatches: CartInspection['mismatches'] = [];
  for (const [checkoutVariantId, quantity] of requested) {
    const got = returned.get(checkoutVariantId) ?? 0;
    if (got !== quantity) mismatches.push({ checkoutVariantId, requested: quantity, returned: got });
  }
  const unexpected: string[] = [];
  for (const [variantId, quantity] of returned) {
    if (quantity > 0 && !requested.has(variantId)) unexpected.push(variantId);
  }
  const stockWarnings: CartInspection['stockWarnings'] = [];
  const otherWarningCodes: string[] = [];
  for (const warning of result.warnings) {
    if (STOCK_WARNING_CODES.has(warning.code)) {
      const variantId = warning.target === null ? undefined : variantByLine.get(warning.target);
      stockWarnings.push({ code: warning.code, checkoutVariantId: variantId ?? null });
    } else {
      otherWarningCodes.push(warning.code);
    }
  }
  return { mismatches, unexpected, stockWarnings, notForSale: [...notForSale], otherWarningCodes };
}

/**
 * Variantes que sumiram do carrinho (quantidade devolvida 0) sem aviso de estoque que as
 * explique. Um aviso cujo alvo não está no carrinho pode ser justamente o da linha que
 * sumiu; havendo algum, não dá para afirmar que o sumiço foi silencioso.
 */
function silentlyDropped(inspection: CartInspection): string[] {
  if (inspection.stockWarnings.some((warning) => warning.checkoutVariantId === null)) return [];
  const explained = new Set(inspection.stockWarnings.map((warning) => warning.checkoutVariantId));
  return inspection.mismatches
    .filter((mismatch) => mismatch.returned === 0 && !explained.has(mismatch.checkoutVariantId))
    .map((mismatch) => mismatch.checkoutVariantId);
}

/**
 * Acrescenta os utm_* à URL final sem tocar no que já está lá. A URL do carrinho traz
 * parâmetros da Shopify (a chave do carrinho, o consentimento em _cs): o acréscimo é feito
 * na string da query, porque regravar por searchParams reserializaria os valores
 * existentes com outra codificação.
 *
 * PRECISA DE TESTE EM LOJA REAL: a Shopify mostra utm_* numa URL de checkout desse formato,
 * mas não documenta que eles sobrevivem ao redirecionamento nem que chegam ao pedido.
 */
function appendUtm(rawUrl: string, attribution: Record<string, string> | undefined): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BridgeError('upstream_rejected', 'URL de checkout inválida', { reason: 'invalid_checkout_url' });
  }
  if (url.protocol !== 'https:') {
    throw new BridgeError('upstream_rejected', 'URL de checkout inválida', { reason: 'invalid_checkout_url' });
  }
  const pairs: string[] = [];
  for (const key of UTM_URL_KEYS) {
    if (attribution === undefined || !Object.hasOwn(attribution, key)) continue;
    const value = attribution[key];
    if (typeof value !== 'string' || value === '') continue;
    if (url.searchParams.has(key)) continue;
    pairs.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (pairs.length === 0) return rawUrl;
  url.search = url.search === '' ? `?${pairs.join('&')}` : `${url.search}&${pairs.join('&')}`;
  return url.toString();
}

/**
 * A URL final precisa apontar para a loja checkout da rota: https e host igual ao domínio
 * canônico (xxx.myshopify.com), ao domínio público ou, enquanto o domínio público não é
 * conhecido, a qualquer host *.myshopify.com. Qualquer outra coisa (resposta adulterada,
 * configuração errada) não vira redirecionamento: o comprador nunca é mandado para fora da
 * loja checkout.
 */
function assertCheckoutHost(rawUrl: string, store: Store): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BridgeError('upstream_rejected', 'URL de checkout inválida', { reason: 'invalid_checkout_url' });
  }
  const host = url.host.toLowerCase();
  const publicDomain = store.publicDomain === null ? null : store.publicDomain.toLowerCase();
  const allowed =
    url.protocol === 'https:' &&
    (host === store.shopDomain.toLowerCase() ||
      (publicDomain !== null ? host === publicDomain : host.endsWith('.myshopify.com')));
  if (!allowed) {
    throw new BridgeError('upstream_rejected', 'URL de checkout fora da loja checkout', {
      reason: 'checkout_url_host',
      checkoutStoreId: store.id,
      host,
    });
  }
}

/**
 * O ID do carrinho tem o formato "<token>?key=<segredo>". O segredo dá acesso de escrita
 * ao carrinho e não tem uso depois do redirecionamento, então só o token é guardado.
 */
function cartIdWithoutKey(cartId: string): string | null {
  if (typeof cartId !== 'string') return null;
  const cut = cartId.indexOf('?');
  const bare = cut === -1 ? cartId : cartId.slice(0, cut);
  return bare === '' ? null : bare;
}

function limited<T>(items: T[]): T[] {
  return items.slice(0, MAX_DETAIL_ITEMS);
}

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const { repos, storefront, config, metrics, alerter } = deps;
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? defaultSleep;
  const ipHashKey = deriveKey(config.encryptionKey, 'ip-hash');

  /**
   * Divergência de preço entre vitrine e checkout, do catálogo em cache ('cached') ou do
   * carrinho recém-criado ('live'). 'block' recusa o checkout e alerta o lojista; 'warn'
   * registra e segue. Com 'off' esta função nem é chamada.
   */
  function handleDivergences(stage: 'cached' | 'live', divergences: PriceDivergence[], p: Prepared, log: Logger): void {
    if (divergences.length === 0) return;
    const detail = {
      stage,
      linkId: p.link.id,
      vitrineStoreId: p.vitrine.id,
      checkoutStoreId: p.checkoutStore.id,
      toleranceBps: p.link.priceToleranceBps,
      count: divergences.length,
      divergences: limited(divergences),
    };
    if (p.link.parityPolicy === 'block') {
      alerter.notify({
        key: `price_divergence:${p.link.id}`,
        severity: 'critical',
        title: 'Checkout bloqueado: preço na loja checkout diferente do preço mostrado na vitrine',
        detail,
      });
      throw new BridgeError('price_divergence', 'Preço divergente entre vitrine e checkout', detail);
    }
    metrics.inc('bridge_checkout_parity_warnings_total', { stage }, divergences.length);
    log.warn(detail, 'preço divergente entre vitrine e checkout (política warn: checkout segue)');
  }

  /** Passos 1 a 7: tudo o que dá para decidir sem falar com a Shopify. Síncrono. */
  function prepare(request: CheckoutRequest, trace: Trace, log: Logger): Prepared {
    // 1. Loja vitrine. O domínio vem dos parâmetros assinados do App Proxy.
    const vitrine = repos.stores.getByShopDomain(request.shopDomain);
    if (!vitrine) throw new BridgeError('store_not_found', 'Loja vitrine não cadastrada');
    trace.vitrineStoreId = vitrine.id;
    if (vitrine.role !== 'vitrine') throw new BridgeError('forbidden', 'A loja não é uma vitrine', { storeId: vitrine.id });
    if (vitrine.status === 'disabled') {
      throw new BridgeError('store_disabled', 'Loja vitrine desativada', { storeId: vitrine.id });
    }

    // 2. Rota. Só a configuração do lojista decide o destino (veja routing.ts).
    const country = normalizeCountryCode(request.country);
    const link = resolveLink(repos.links.list({ vitrineStoreId: vitrine.id, enabledOnly: true }), country);
    if (!link) {
      alerter.notify({
        key: `no_route:${vitrine.id}`,
        severity: 'critical',
        title: 'Checkout recusado: a vitrine não tem rota ativa para o comprador',
        detail: { vitrineStoreId: vitrine.id, country },
      });
      throw new BridgeError('no_route', 'Vitrine sem rota ativa', { vitrineStoreId: vitrine.id, country });
    }
    trace.linkId = link.id;
    trace.strategy = link.strategy;
    trace.checkoutStoreId = link.checkoutStoreId;
    const checkoutStore = repos.stores.get(link.checkoutStoreId);
    if (!checkoutStore || checkoutStore.role !== 'checkout' || checkoutStore.status === 'disabled') {
      throw new BridgeError('store_disabled', 'Loja checkout da rota ausente ou desativada', {
        linkId: link.id,
        checkoutStoreId: link.checkoutStoreId,
      });
    }

    // 3. Forma e limites. O schema já validou a forma; o serviço não depende disso.
    if (!Array.isArray(request.lines) || request.lines.length === 0) {
      throw new BridgeError('invalid_request', 'Carrinho sem linhas');
    }
    for (const line of request.lines) {
      const validQuantity = typeof line?.quantity === 'number' && Number.isSafeInteger(line.quantity) && line.quantity >= 1;
      if (typeof line?.variantId !== 'string' || !isValidVariantId(line.variantId) || !validQuantity) {
        throw new BridgeError('invalid_request', 'Linha de carrinho inválida');
      }
    }
    const maxLines = Math.min(link.maxLines, HARD_MAX_LINES);
    if (request.lines.length > maxLines) {
      throw new BridgeError('quantity_exceeded', 'Carrinho com linhas demais', {
        reason: 'too_many_lines',
        lineCount: request.lines.length,
        maxLines,
      });
    }
    const overQuantity = request.lines.filter((line) => line.quantity > link.maxQuantityPerLine);
    if (overQuantity.length > 0) {
      throw new BridgeError('quantity_exceeded', 'Quantidade acima do limite da rota', {
        reason: 'quantity_per_line',
        maxQuantityPerLine: link.maxQuantityPerLine,
        vitrineVariantIds: limited(unique(overQuantity.map((line) => line.variantId))),
      });
    }
    const withPlan = request.lines.filter((line) => line.hasSellingPlan === true);
    if (withPlan.length > 0) {
      throw new BridgeError('selling_plan_unsupported', 'Linha com plano de assinatura', {
        vitrineVariantIds: limited(unique(withPlan.map((line) => line.variantId))),
      });
    }

    // 4. Toda variante precisa existir no catálogo sincronizado da vitrine. Um ID inventado
    // ou de outra loja para aqui; sem alerta, porque qualquer visitante consegue provocar.
    const vitrineIds = unique(request.lines.map((line) => line.variantId));
    const vitrineCatalog = repos.catalog.getVariants(vitrine.id, vitrineIds);
    const unknownIds = vitrineIds.filter((id) => !vitrineCatalog.has(id));
    if (unknownIds.length > 0) {
      throw new BridgeError('unmapped_variant', 'Variante fora do catálogo sincronizado da vitrine', {
        reason: 'not_in_vitrine_catalog',
        vitrineVariantIds: limited(unknownIds),
      });
    }

    // 5. Mapeamento do par. Só 'active' com destino serve; sugestão e conflito esperam o lojista.
    const mappings = repos.mappings.getMany(vitrine.id, checkoutStore.id, vitrineIds);
    const unmapped = vitrineIds.filter((id) => {
      const mapping = mappings.get(id);
      return !mapping || mapping.status !== 'active' || !mapping.checkoutVariantId;
    });
    if (unmapped.length > 0) {
      const detail = {
        reason: 'no_active_mapping',
        linkId: link.id,
        vitrineStoreId: vitrine.id,
        checkoutStoreId: checkoutStore.id,
        vitrineVariantIds: limited(unmapped),
      };
      alerter.notify({
        key: `unmapped:${link.id}`,
        severity: 'warning',
        title: 'Checkout recusado: variante da vitrine sem par ativo na loja checkout',
        detail,
      });
      throw new BridgeError('unmapped_variant', 'Variante sem mapeamento ativo', detail);
    }

    // 6. Catálogo em cache da loja checkout: a variante de destino existe e pode ser vendida.
    const checkoutIdByVitrine = new Map<string, string>();
    for (const id of vitrineIds) {
      const checkoutVariantId = mappings.get(id)?.checkoutVariantId;
      if (checkoutVariantId) checkoutIdByVitrine.set(id, checkoutVariantId);
    }
    const checkoutCatalog = repos.catalog.getVariants(checkoutStore.id, unique(checkoutIdByVitrine.values()));
    const stale = vitrineIds.filter((id) => !checkoutCatalog.has(checkoutIdByVitrine.get(id) ?? ''));
    if (stale.length > 0) {
      const detail = {
        reason: 'not_in_checkout_catalog',
        linkId: link.id,
        vitrineStoreId: vitrine.id,
        checkoutStoreId: checkoutStore.id,
        vitrineVariantIds: limited(stale),
        checkoutVariantIds: limited(stale.map((id) => checkoutIdByVitrine.get(id) ?? '')),
      };
      alerter.notify({
        key: `unmapped:${link.id}`,
        severity: 'warning',
        title: 'Checkout recusado: mapeamento aponta para variante que não está no catálogo da loja checkout',
        detail,
      });
      throw new BridgeError('unmapped_variant', 'Variante de destino fora do catálogo da loja checkout', detail);
    }

    const lines: ResolvedLine[] = [];
    const requested = new Map<string, number>();
    for (const line of request.lines) {
      const checkoutVariantId = checkoutIdByVitrine.get(line.variantId);
      const vitrineVariant = vitrineCatalog.get(line.variantId);
      const checkoutVariant = checkoutVariantId === undefined ? undefined : checkoutCatalog.get(checkoutVariantId);
      if (checkoutVariantId === undefined || !vitrineVariant || !checkoutVariant) {
        // Inalcançável depois das checagens acima; fica para o compilador e para o futuro.
        throw new BridgeError('internal', 'Linha sem variante resolvida');
      }
      const properties: Attribute[] = [];
      if (line.properties !== undefined && line.properties !== null && typeof line.properties === 'object') {
        for (const [key, value] of Object.entries(line.properties)) {
          if (key === '' || key.startsWith('__') || typeof value !== 'string' || value === '') continue;
          properties.push({ key, value });
        }
      }
      lines.push({
        vitrineVariantId: line.variantId,
        checkoutVariantId,
        quantity: line.quantity,
        properties: properties.length > 0 ? properties : null,
        vitrine: vitrineVariant,
        checkout: checkoutVariant,
      });
      requested.set(checkoutVariantId, (requested.get(checkoutVariantId) ?? 0) + line.quantity);
    }

    // O limite da rota vale para o TOTAL pedido de cada variante do checkout, somando todas
    // as linhas, com ou sem propriedades: sem isto, dividir a quantidade em várias linhas
    // (iguais, ou iguais a menos de uma propriedade descartável) passaria pelo limite. Como a
    // soma é por variante do checkout, duas variantes da vitrine mapeadas para o mesmo
    // destino também contam juntas.
    const totalOver = [...requested].filter(([, total]) => total > link.maxQuantityPerLine);
    if (totalOver.length > 0) {
      throw new BridgeError('quantity_exceeded', 'Quantidade acima do limite da rota', {
        reason: 'quantity_per_line',
        maxQuantityPerLine: link.maxQuantityPerLine,
        checkoutVariantIds: limited(totalOver.map(([checkoutVariantId]) => checkoutVariantId)),
      });
    }

    const unavailable: Array<{ vitrineVariantId: string; checkoutVariantId: string; reason: string }> = [];
    const seenUnavailable = new Set<string>();
    for (const line of lines) {
      if (seenUnavailable.has(line.checkoutVariantId)) continue;
      // O estoque é comparado com o TOTAL pedido daquela variante, somando todas as linhas.
      const reason = unavailableReason(line.checkout, requested.get(line.checkoutVariantId) ?? line.quantity);
      if (reason === null) continue;
      seenUnavailable.add(line.checkoutVariantId);
      unavailable.push({ vitrineVariantId: line.vitrineVariantId, checkoutVariantId: line.checkoutVariantId, reason });
    }
    if (unavailable.length > 0) {
      throw new BridgeError('variant_unavailable', 'Variante indisponível no catálogo da loja checkout', {
        stage: 'cached',
        linkId: link.id,
        items: limited(unavailable),
      });
    }

    const prepared: Prepared = {
      vitrine,
      checkoutStore,
      link,
      country,
      lines,
      requested,
      hasProperties: lines.some((line) => line.properties !== null),
    };

    // 7. Paridade de preço pelo catálogo em cache. A conferência com o preço que a loja
    // checkout de fato vai cobrar acontece depois, sobre o carrinho criado.
    if (link.parityPolicy !== 'off') {
      const divergences: PriceDivergence[] = [];
      const seenPairs = new Set<string>();
      for (const line of lines) {
        if (seenPairs.has(line.vitrineVariantId)) continue;
        seenPairs.add(line.vitrineVariantId);
        const ids = { vitrineVariantId: line.vitrineVariantId, checkoutVariantId: line.checkoutVariantId };
        if (line.vitrine.currency !== line.checkout.currency) {
          divergences.push({ ...ids, kind: 'currency', vitrine: line.vitrine.currency, checkout: line.checkout.currency });
        } else if (priceDiverges(line.vitrine.price, line.checkout.price, link.priceToleranceBps)) {
          divergences.push({ ...ids, kind: 'price', vitrine: line.vitrine.price, checkout: line.checkout.price });
        }
      }
      handleDivergences('cached', divergences, prepared, log);
    }
    return prepared;
  }

  /**
   * Outra requisição com a mesma chave está no meio do caminho. Espera um pouco por ela:
   * se terminar com checkout, devolve o mesmo; se terminar com uma recusa de negócio
   * (preço, estoque, recusa da Shopify), responde com a MESMA recusa, porque tentar de novo
   * não vai mudar nada; senão o comprador tenta de novo em instantes (a sessão 'pending'
   * deixa de contar como viva depois de 60 s).
   */
  async function awaitConcurrent(existing: CheckoutSession, link: Link, log: Logger): Promise<CheckoutResponse> {
    let current: CheckoutSession | null = existing;
    let waited = 0;
    for (;;) {
      if (current && current.status === 'created' && current.checkoutUrl) {
        return { sessionId: current.id, checkoutUrl: current.checkoutUrl, strategy: current.strategy ?? link.strategy, reused: true };
      }
      if (!current || current.status === 'failed' || waited >= PENDING_WAIT_MS) break;
      await sleep(PENDING_POLL_MS);
      waited += PENDING_POLL_MS;
      current = repos.sessions.get(current.id);
    }
    const ownerCode = current?.status === 'failed' ? current.errorCode : null;
    const detail = {
      concurrentSessionId: existing.id,
      concurrentStatus: current?.status ?? null,
      concurrentErrorCode: ownerCode,
      waitedMs: waited,
    };
    if (ownerCode !== null && !RETRY_AGAIN_CODES.has(ownerCode)) {
      log.warn(detail, 'carrinho recusado pela requisição concorrente; mesma recusa devolvida');
      throw new BridgeError(ownerCode, 'Carrinho recusado pela requisição concorrente', detail);
    }
    log.warn(detail, 'carrinho em processamento por outra requisição; comprador deve tentar de novo');
    throw new BridgeError('upstream_unavailable', 'Carrinho em processamento por outra requisição', detail);
  }

  /** Passo 8: sessão 'pending' com a chave de idempotência, ou a sessão viva já existente. */
  function openSession(
    request: CheckoutRequest,
    ctx: RequestContext,
    p: Prepared,
  ): { inserted: boolean; session: CheckoutSession } {
    const now = clock.now();
    const ipHash = hashIp(ctx.buyerIp, ipHashKey);
    const cartToken = typeof request.cartToken === 'string' && request.cartToken !== '' ? request.cartToken : null;
    const clientNonce = typeof request.clientNonce === 'string' && request.clientNonce !== '' ? request.clientNonce : null;
    // Sem token: o escopo de reserva é o nonce do navegador (gerado pelo script do tema) numa
    // janela curta de tempo, para um nonce velho não prender o checkout para sempre. Sem
    // nonce, IP (em hash) + navegador + janela: dois navegadores atrás do mesmo IP dividem o
    // escopo. Sem IP não há como distinguir compradores e cada clique vira um carrinho novo.
    const bucket = Math.floor(now.getTime() / NO_TOKEN_WINDOW_MS);
    const fallbackScope =
      clientNonce !== null
        ? `nonce:${clientNonce}:${bucket}`
        : ipHash === null
          ? `req:${randomId('nk')}`
          : `ip:${ipHash}:${sha256Hex(ctx.userAgent ?? '').slice(0, 32)}:${bucket}`;
    const idempotencyKey = computeIdempotencyKey({
      vitrineStoreId: p.vitrine.id,
      linkId: p.link.id,
      cartToken,
      lines: request.lines,
      country: p.country,
      discountCodes: request.discountCodes ?? [],
      source: request.source === 'buy_now' ? 'buy_now' : 'cart',
      fallbackScope,
    });
    const session: CheckoutSession = {
      id: randomId('cs'),
      idempotencyKey,
      vitrineStoreId: p.vitrine.id,
      checkoutStoreId: p.checkoutStore.id,
      linkId: p.link.id,
      status: 'pending',
      strategy: null,
      lines: buildSessionLines(p.lines),
      country: p.country,
      orderId: null,
      checkoutUrl: null,
      cartId: null,
      subtotal: null,
      currency: null,
      errorCode: null,
      ipHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.sessionTtlMinutes * 60_000).toISOString(),
    };
    return repos.sessions.insertPending(session, now.toISOString());
  }

  /**
   * Passo 10 (conferência): o carrinho devolvido tem exatamente o que foi pedido, nada
   * está sem estoque e o preço unitário que a loja checkout vai cobrar bate com a vitrine.
   */
  function verifyCart(p: Prepared, result: CartCreateResult, log: Logger): void {
    const inspection = inspectCart(p.requested, result);
    const base = { linkId: p.link.id, vitrineStoreId: p.vitrine.id, checkoutStoreId: p.checkoutStore.id };

    if (inspection.otherWarningCodes.length > 0) {
      // Cupom inválido ou não aplicável não impede o checkout; o comprador vê o total lá.
      log.info({ ...base, warningCodes: unique(inspection.otherWarningCodes) }, 'avisos do carrinho (não bloqueantes)');
    }
    const notApplicable = result.discountCodes.filter((code) => !code.applicable).length;
    if (notApplicable > 0) log.info({ ...base, notApplicable }, 'cupons não aplicáveis na loja checkout');

    if (inspection.unexpected.length > 0) {
      // Linha que ninguém pediu muda o checkout em relação à vitrine: recusa e avisa.
      const detail = { ...base, reason: 'unexpected_cart_lines', checkoutVariantIds: limited(inspection.unexpected) };
      alerter.notify({
        key: `cart_unexpected:${p.link.id}`,
        severity: 'critical',
        title: 'Checkout recusado: o carrinho criado na loja checkout trouxe itens que não foram pedidos',
        detail,
      });
      throw new BridgeError('upstream_rejected', 'Carrinho com linhas inesperadas', detail);
    }

    const stockVariantIds = inspection.stockWarnings
      .map((warning) => warning.checkoutVariantId)
      .filter((id): id is string => id !== null);
    if (inspection.mismatches.length > 0 || inspection.stockWarnings.length > 0 || inspection.notForSale.length > 0) {
      const dropped = silentlyDropped(inspection);
      const detail = {
        ...base,
        stage: 'live',
        warningCodes: unique(inspection.stockWarnings.map((warning) => warning.code)),
        checkoutVariantIds: limited(
          unique([...stockVariantIds, ...inspection.notForSale, ...inspection.mismatches.map((m) => m.checkoutVariantId)]),
        ),
        mismatches: limited(inspection.mismatches),
        silentlyDropped: limited(dropped),
      };
      if (dropped.length > 0) {
        alerter.notify({
          key: `cart_line_dropped:${p.link.id}`,
          severity: 'critical',
          title:
            'Variante sumiu do carrinho sem aviso de estoque: verifique se o produto está publicado no canal de vendas que a Storefront API da loja checkout lê',
          detail,
        });
      }
      throw new BridgeError('variant_unavailable', 'Carrinho criado não corresponde ao pedido', detail);
    }

    if (p.link.parityPolicy === 'off') return;
    const divergences: PriceDivergence[] = [];
    const seenPairs = new Set<string>();
    for (const line of p.lines) {
      for (const returned of result.lines) {
        if (returned.variantId !== line.checkoutVariantId || !(returned.quantity > 0)) continue;
        const pairKey = `${line.vitrineVariantId}:${returned.lineId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        if (returned.currency !== line.vitrine.currency) {
          // Moeda do carrinho (mercado do comprador) diferente da moeda da vitrine: não há
          // base para comparar sem câmbio. Fica na métrica para o lojista acompanhar.
          metrics.inc('bridge_checkout_parity_skipped_total', { reason: 'currency_mismatch' });
          continue;
        }
        if (priceDiverges(line.vitrine.price, returned.unitPrice, p.link.priceToleranceBps)) {
          divergences.push({
            vitrineVariantId: line.vitrineVariantId,
            checkoutVariantId: line.checkoutVariantId,
            kind: 'price',
            vitrine: line.vitrine.price,
            checkout: returned.unitPrice,
          });
        }
      }
    }
    handleDivergences('live', divergences, p, log);
  }

  /** Passo 11: permalink de carrinho na MESMA loja checkout da rota. */
  function permalinkOutcome(p: Prepared, sessionId: string, request: CheckoutRequest): Outcome {
    if (p.hasProperties) {
      throw new BridgeError('upstream_rejected', 'Permalink não transporta propriedades de linha', {
        reason: 'line_properties_unsupported_in_permalink',
        linkId: p.link.id,
      });
    }
    const host = p.checkoutStore.publicDomain ?? p.checkoutStore.shopDomain;
    const lines = buildCartLines(p.lines).map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
    const essential: Attribute[] = [
      { key: 'bridge_session', value: sessionId },
      { key: 'bridge_source', value: p.vitrine.shopDomain },
    ];
    const marketing = attributionEntries(request.attribution).filter((entry) => !COOKIE_ID_KEYS.has(entry.key));
    const discountCodes = request.discountCodes && request.discountCodes.length > 0 ? request.discountCodes : undefined;

    const build = (attributes: Attribute[]): string => buildCartPermalink({ host, lines, attributes, discountCodes });
    let checkoutUrl: string;
    try {
      checkoutUrl = build([...essential, ...marketing]);
    } catch (err) {
      const reason = isBridgeError(err) ? err.details['reason'] : null;
      if (reason !== 'permalink_too_long') {
        // IDs e quantidades já foram validados; sobrou configuração errada (host) ou bug.
        throw new BridgeError('internal', 'Falha ao montar o permalink', { linkId: p.link.id, reason });
      }
      // Sem a atribuição de marketing a URL encolhe bastante; a correlação da sessão fica.
      try {
        checkoutUrl = build(essential);
      } catch {
        throw new BridgeError('upstream_rejected', 'Permalink longo demais', {
          reason: 'permalink_too_long',
          linkId: p.link.id,
          lineCount: lines.length,
        });
      }
    }
    return { strategy: 'permalink', checkoutUrl, cartId: null, subtotal: null, currency: null };
  }

  /** Passos 9 a 13 para uma sessão recém-inserida. */
  async function fulfil(request: CheckoutRequest, ctx: RequestContext, p: Prepared, session: CheckoutSession, log: Logger): Promise<Outcome> {
    const cartLines = buildCartLines(p.lines);
    const attributes: Attribute[] = [
      { key: 'bridge_session', value: session.id },
      { key: 'bridge_source', value: p.vitrine.shopDomain },
      ...attributionEntries(request.attribution),
    ];

    if (p.link.strategy === 'permalink') return permalinkOutcome(p, session.id, request);

    let cart: CartCreateResult | null = null;
    try {
      cart = await storefront.createCart(p.checkoutStore, {
        lines: cartLines,
        attributes,
        countryCode: p.country ?? undefined,
        discountCodes: request.discountCodes && request.discountCodes.length > 0 ? request.discountCodes : undefined,
        buyerIp: ctx.buyerIp,
        language: typeof request.language === 'string' ? request.language : undefined,
        consent: request.consent,
      });
    } catch (err) {
      // Só indisponibilidade (rede, timeout, circuito aberto) admite o permalink, e só na
      // MESMA loja checkout. Recusa da Shopify (userErrors) não é caso de fallback.
      const canFallBack =
        isBridgeError(err) && err.code === 'upstream_unavailable' && p.link.allowPermalinkFallback && !p.hasProperties;
      if (!canFallBack) throw err;
      metrics.inc('bridge_checkout_permalink_fallback_total', { checkoutStoreId: p.checkoutStore.id });
      log.warn(
        { linkId: p.link.id, checkoutStoreId: p.checkoutStore.id, upstreamCode: err.code },
        'Storefront API indisponível; usando permalink na mesma loja checkout',
      );
      return permalinkOutcome(p, session.id, request);
    }

    verifyCart(p, cart, log);
    return {
      strategy: 'storefront_cart',
      checkoutUrl: cart.checkoutUrl,
      cartId: cartIdWithoutKey(cart.cartId),
      subtotal: cart.subtotal,
      currency: cart.currency,
    };
  }

  async function run(request: CheckoutRequest, ctx: RequestContext, trace: Trace, log: Logger): Promise<CheckoutResponse> {
    const p = prepare(request, trace, log);
    const opened = openSession(request, ctx, p);
    if (!opened.inserted) return awaitConcurrent(opened.session, p.link, log);
    const session = opened.session;
    trace.ownedSessionId = session.id;

    const outcome = await fulfil(request, ctx, p, session, log);
    trace.strategy = outcome.strategy;
    const checkoutUrl = appendUtm(outcome.checkoutUrl, request.attribution);
    assertCheckoutHost(checkoutUrl, p.checkoutStore);
    repos.sessions.markCreated(session.id, {
      strategy: outcome.strategy,
      checkoutUrl,
      cartId: outcome.cartId,
      subtotal: outcome.subtotal,
      currency: outcome.currency,
    });
    return { sessionId: session.id, checkoutUrl, strategy: outcome.strategy, reused: false };
  }

  function record(trace: Trace, result: 'created' | 'reused' | 'failed', code: string, startedMs: number): void {
    const labels = { result, strategy: trace.strategy, code };
    metrics.inc('bridge_checkout_sessions_total', labels);
    metrics.observe('bridge_checkout_ms', Math.max(0, clock.now().getTime() - startedMs), { result, strategy: trace.strategy });
  }

  async function createCheckout(request: CheckoutRequest, ctx: RequestContext): Promise<CheckoutResponse> {
    const startedMs = clock.now().getTime();
    const log = deps.logger.child({ requestId: ctx?.requestId ?? null });
    const trace: Trace = {
      vitrineStoreId: null,
      checkoutStoreId: null,
      linkId: null,
      strategy: 'none',
      lineCount: Array.isArray(request?.lines) ? request.lines.length : 0,
      ownedSessionId: null,
    };
    try {
      const response = await run(request, ctx, trace, log);
      const result = response.reused ? 'reused' : 'created';
      record(trace, result, 'ok', startedMs);
      log.info(
        {
          vitrineStoreId: trace.vitrineStoreId,
          checkoutStoreId: trace.checkoutStoreId,
          linkId: trace.linkId,
          lineCount: trace.lineCount,
          strategy: response.strategy,
          sessionId: response.sessionId,
          reused: response.reused,
          code: 'ok',
        },
        'checkout criado',
      );
      return response;
    } catch (err) {
      const bridgeError = isBridgeError(err)
        ? err
        : new BridgeError('internal', 'Falha inesperada ao criar o checkout', { requestId: ctx?.requestId ?? null });
      if (trace.ownedSessionId !== null) {
        try {
          repos.sessions.markFailed(trace.ownedSessionId, bridgeError.code);
        } catch (markErr) {
          log.error({ err: markErr, sessionId: trace.ownedSessionId }, 'não foi possível marcar a sessão como falha');
        }
      }
      record(trace, 'failed', bridgeError.code, startedMs);
      const context = {
        vitrineStoreId: trace.vitrineStoreId,
        checkoutStoreId: trace.checkoutStoreId,
        linkId: trace.linkId,
        lineCount: trace.lineCount,
        strategy: trace.strategy,
        sessionId: trace.ownedSessionId,
        code: bridgeError.code,
        details: bridgeError.details,
      };
      if (isBridgeError(err)) log.warn(context, 'checkout recusado');
      else log.error({ ...context, err }, 'erro inesperado ao criar o checkout');
      alertRejected(trace, bridgeError);
      throw bridgeError;
    }
  }

  /**
   * Recusa da Shopify (userErrors, loja inativa/congelada/bloqueada, carrinho truncado,
   * URL inválida...) fica fora do circuit breaker de propósito, então o alerta de circuito
   * nunca a cobre. Sem este aviso, todo comprador da rota veria "não foi possível criar o
   * checkout" até o lojista reparar nas falhas do painel. Um alerta por rota, com o motivo
   * nos detalhes; a deduplicação por chave limita o volume. A linha inesperada no carrinho
   * já emite o próprio alerta crítico e não é repetida aqui.
   */
  function alertRejected(trace: Trace, bridgeError: BridgeError): void {
    if (bridgeError.code !== 'upstream_rejected' || trace.linkId === null) return;
    if (bridgeError.details['reason'] === 'unexpected_cart_lines') return;
    alerter.notify({
      key: `upstream_rejected:${trace.linkId}`,
      severity: 'warning',
      title: `A Shopify recusou o checkout da rota ${trace.linkId}: ${bridgeError.message}. Veja o motivo nos detalhes e confira a loja checkout e os mapeamentos.`,
      detail: {
        linkId: trace.linkId,
        vitrineStoreId: trace.vitrineStoreId,
        checkoutStoreId: trace.checkoutStoreId,
        strategy: trace.strategy,
        code: bridgeError.code,
        message: bridgeError.message,
        details: bridgeError.details,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Diagnóstico de rota
  // -------------------------------------------------------------------------

  interface Sample {
    mapping: VariantMapping;
    checkoutVariantId: string;
    checkout: CatalogVariant;
    vitrine: CatalogVariant | null;
  }

  /**
   * Amostra de mapeamentos ativos cuja variante de destino está disponível no catálogo em
   * cache, uma por variante do checkout. O catálogo é lido em blocos para não carregar o
   * catálogo inteiro de uma loja grande por causa de dez variantes.
   */
  function sampleMappings(link: Link, size: number): Sample[] {
    const active = repos.mappings
      .listAll(link.vitrineStoreId, link.checkoutStoreId)
      .filter((mapping) => mapping.status === 'active' && mapping.checkoutVariantId !== null);
    const sample: Sample[] = [];
    const seen = new Set<string>();
    for (let start = 0; start < active.length && sample.length < size; start += SAMPLE_CHUNK) {
      const chunk = active.slice(start, start + SAMPLE_CHUNK);
      const variants = repos.catalog.getVariants(
        link.checkoutStoreId,
        chunk.map((mapping) => mapping.checkoutVariantId ?? ''),
      );
      for (const mapping of chunk) {
        if (sample.length >= size) break;
        const checkoutVariantId = mapping.checkoutVariantId;
        if (checkoutVariantId === null || seen.has(checkoutVariantId)) continue;
        const checkout = variants.get(checkoutVariantId);
        if (!checkout || unavailableReason(checkout, 1) !== null) continue;
        seen.add(checkoutVariantId);
        sample.push({ mapping, checkoutVariantId, checkout, vitrine: null });
      }
    }
    const vitrineVariants = repos.catalog.getVariants(
      link.vitrineStoreId,
      sample.map((item) => item.mapping.vitrineVariantId),
    );
    for (const item of sample) item.vitrine = vitrineVariants.get(item.mapping.vitrineVariantId) ?? null;
    return sample;
  }

  function priceProblem(item: Sample, price: string, currency: string, toleranceBps: number): string | null {
    if (!item.vitrine || item.vitrine.currency !== currency) return null;
    if (!priceDiverges(item.vitrine.price, price, toleranceBps)) return null;
    return `Preço diferente da vitrine: vitrine ${formatMoney(item.vitrine.price, item.vitrine.currency)}, checkout ${formatMoney(price, currency)}.`;
  }

  function problemFor(item: Sample, text: string): LinkTestProblem {
    return { vitrineVariantId: item.mapping.vitrineVariantId, checkoutVariantId: item.checkoutVariantId, problem: text };
  }

  async function testLink(linkId: string, sampleSize: number = DEFAULT_TEST_SAMPLE): Promise<LinkTestResult> {
    const size =
      typeof sampleSize === 'number' && Number.isFinite(sampleSize)
        ? Math.min(MAX_TEST_SAMPLE, Math.max(1, Math.floor(sampleSize)))
        : DEFAULT_TEST_SAMPLE;
    const base = (strategy: SessionStrategy): LinkTestResult => ({ linkId, ok: false, strategy, tested: 0, problems: [], detail: null });
    try {
      const link = repos.links.get(linkId);
      if (!link) return { ...base('storefront_cart'), detail: 'Rota não encontrada.' };
      const result = base(link.strategy);
      const checkoutStore = repos.stores.get(link.checkoutStoreId);
      if (!checkoutStore || checkoutStore.role !== 'checkout') return { ...result, detail: 'Loja checkout da rota não encontrada.' };
      if (checkoutStore.status === 'disabled') return { ...result, detail: 'Loja checkout da rota está desativada.' };

      const sample = sampleMappings(link, size);
      if (sample.length === 0) {
        return {
          ...result,
          detail:
            'Nenhuma variante para testar: a rota não tem mapeamentos ativos cuja variante de destino esteja ativa, disponível e com estoque no catálogo sincronizado da loja checkout. Sincronize os catálogos e aprove os mapeamentos.',
        };
      }
      result.tested = sample.length;
      const comparePrices = link.parityPolicy !== 'off';

      if (link.strategy === 'permalink') {
        if (comparePrices) {
          for (const item of sample) {
            const text = priceProblem(item, item.checkout.price, item.checkout.currency, link.priceToleranceBps);
            if (text !== null) result.problems.push(problemFor(item, text));
          }
        }
        result.ok = result.problems.length === 0;
        result.detail =
          'Rota por permalink: foram conferidos só os dados do catálogo sincronizado (disponibilidade e preço em cache). O permalink em si não pode ser validado pelo servidor, porque a Shopify não devolve nada ao montá-lo; abra-o em um navegador para confirmar que o carrinho carrega.';
        return result;
      }

      // Rota por país: o carrinho de teste usa o primeiro país da rota, como um comprador de lá.
      const countryCode = link.kind === 'country' ? link.countries[0] : undefined;
      const requested = new Map(sample.map((item) => [item.checkoutVariantId, 1]));
      const cart = await storefront.createCart(checkoutStore, {
        lines: sample.map((item) => ({ variantId: item.checkoutVariantId, quantity: 1 })),
        attributes: [{ key: 'bridge_test', value: '1' }],
        countryCode,
        buyerIp: null,
      });
      const inspection = inspectCart(requested, cart);
      const stockByVariant = new Map<string, string>();
      for (const warning of inspection.stockWarnings) {
        if (warning.checkoutVariantId !== null && !stockByVariant.has(warning.checkoutVariantId)) {
          stockByVariant.set(warning.checkoutVariantId, warning.code);
        }
      }
      const mismatched = new Map(inspection.mismatches.map((m) => [m.checkoutVariantId, m]));
      const notForSale = new Set(inspection.notForSale);
      let skippedCurrency = 0;
      for (const item of sample) {
        const id = item.checkoutVariantId;
        const stockCode = stockByVariant.get(id);
        const mismatch = mismatched.get(id);
        if (stockCode === 'PRODUCT_UNAVAILABLE_IN_BUYER_LOCATION') {
          result.problems.push(problemFor(item, 'Indisponível para o país do comprador na loja checkout: verifique os mercados e a publicação do produto.'));
        } else if (stockCode !== undefined || notForSale.has(id) || (mismatch && mismatch.returned > 0)) {
          result.problems.push(problemFor(item, 'Sem estoque na loja checkout.'));
        } else if (mismatch) {
          result.problems.push(
            problemFor(item, 'Não entrou no carrinho de teste: verifique se o produto está publicado no canal de vendas que a Storefront API da loja checkout lê.'),
          );
        } else if (comparePrices) {
          const line = cart.lines.find((candidate) => candidate.variantId === id && candidate.quantity > 0);
          if (line && item.vitrine && line.currency !== item.vitrine.currency) skippedCurrency += 1;
          const text = line ? priceProblem(item, line.unitPrice, line.currency, link.priceToleranceBps) : null;
          if (text !== null) result.problems.push(problemFor(item, text));
        }
      }
      const notes: string[] = [];
      if (countryCode !== undefined) notes.push(`Carrinho de teste criado no contexto do país ${countryCode}.`);
      if (skippedCurrency > 0) notes.push(`${skippedCurrency} variante(s) voltaram em moeda diferente da vitrine; o preço não foi comparado.`);
      if (inspection.unexpected.length > 0) {
        result.problems.push({
          vitrineVariantId: '',
          checkoutVariantId: null,
          problem: `O carrinho de teste trouxe ${inspection.unexpected.length} item(ns) que não foram pedidos.`,
        });
      }
      result.ok = result.problems.length === 0;
      result.detail = notes.length > 0 ? notes.join(' ') : result.ok ? 'Todas as variantes da amostra entraram no carrinho como pedido.' : null;
      return result;
    } catch (err) {
      const detail = isBridgeError(err) ? err.publicMessage : 'Erro inesperado ao testar a rota.';
      deps.logger.warn({ linkId, code: isBridgeError(err) ? err.code : 'internal' }, 'teste de rota falhou');
      return { ...base('storefront_cart'), detail };
    }
  }

  return { createCheckout, testLink };
}
