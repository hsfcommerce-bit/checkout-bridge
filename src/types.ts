/**
 * Contrato central do checkout-bridge.
 *
 * Este arquivo define os tipos de domínio e as "portas" (interfaces) que ligam os módulos.
 * Cada módulo implementa as portas que lhe cabem e depende apenas das portas dos outros,
 * nunca das implementações concretas. A composição acontece em src/app.ts.
 *
 * Convenções:
 * - IDs internos são strings com prefixo (st_, ln_, cs_).
 * - IDs da Shopify são guardados como strings numéricas (sem o prefixo gid://).
 * - Datas são strings ISO 8601 em UTC.
 * - Valores monetários são strings decimais como a Shopify devolve ("39.99"); comparações
 *   passam sempre por src/lib/money.ts.
 * - Preço nunca entra pelo navegador. O navegador envia só variante e quantidade.
 */

import type { Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

// ---------------------------------------------------------------------------
// Lojas
// ---------------------------------------------------------------------------

export type StoreRole = 'vitrine' | 'checkout';
export type StoreStatus = 'pending' | 'connected' | 'error' | 'disabled';

/** Como o servidor se autentica na Storefront API da loja checkout. */
export type StorefrontAuthMode = 'private_token' | 'public_token' | 'tokenless';

export interface Store {
  id: string;
  role: StoreRole;
  name: string;
  /** Domínio canônico xxx.myshopify.com, em minúsculas. */
  shopDomain: string;
  /** Host do domínio público principal (sem protocolo), quando conhecido. */
  publicDomain: string | null;
  /**
   * Só vitrine: caminho do App Proxy no domínio da loja, por exemplo "/apps/checkout-bridge".
   * O script do tema usa esse caminho para falar com o serviço. null em lojas checkout.
   */
  proxyPath: string | null;
  clientId: string;
  currency: string | null;
  status: StoreStatus;
  statusDetail: string | null;
  /** Só checkout: modo de autenticação na Storefront API. */
  storefrontAuthMode: StorefrontAuthMode;
  /** Só checkout: true quando existe um token de Storefront guardado. */
  hasStorefrontToken: boolean;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncDetail: string | null;
  variantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewStore {
  role: StoreRole;
  name: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  publicDomain?: string | null;
  proxyPath?: string | null;
  storefrontAuthMode?: StorefrontAuthMode;
  storefrontToken?: string | null;
}

export interface StorePatch {
  name?: string;
  publicDomain?: string | null;
  proxyPath?: string | null;
  clientId?: string;
  clientSecret?: string;
  currency?: string | null;
  storefrontAuthMode?: StorefrontAuthMode;
  storefrontToken?: string | null;
  status?: StoreStatus;
  statusDetail?: string | null;
}

/** Segredos decifrados. Nunca logar, nunca devolver em respostas HTTP. */
export interface StoreSecrets {
  clientSecret: string;
  storefrontToken: string | null;
}

// ---------------------------------------------------------------------------
// Rotas (ligações vitrine -> checkout)
// ---------------------------------------------------------------------------

/**
 * 'default': destino da vitrine quando nenhuma rota por país se aplica.
 * 'country': destino para compradores dos países listados.
 *
 * O destino é sempre determinístico e definido pelo lojista. Não existe, por decisão de
 * projeto, seleção por volume de vendas, tempo, cota ou falha da loja de destino.
 */
export type LinkKind = 'default' | 'country';

/** O que fazer quando o preço da vitrine e o do checkout divergem além da tolerância. */
export type ParityPolicy = 'block' | 'warn' | 'off';

export interface Link {
  id: string;
  vitrineStoreId: string;
  checkoutStoreId: string;
  kind: LinkKind;
  /** ISO 3166-1 alpha-2 em maiúsculas. Vazio quando kind = 'default'. */
  countries: string[];
  enabled: boolean;
  parityPolicy: ParityPolicy;
  /** Diferença relativa tolerada em pontos-base (0 = preço idêntico, 100 = 1%). */
  priceToleranceBps: number;
  maxQuantityPerLine: number;
  maxLines: number;
  /**
   * Como o checkout é criado na loja de destino.
   * 'storefront_cart': carrinho pela Storefront API, conferido linha a linha (padrão).
   * 'permalink': link direto de carrinho, sem chamada à Shopify no clique.
   */
  strategy: SessionStrategy;
  /** Permite usar permalink de carrinho na MESMA loja checkout se a Storefront API falhar. */
  allowPermalinkFallback: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewLink {
  vitrineStoreId: string;
  checkoutStoreId: string;
  kind: LinkKind;
  countries?: string[];
  enabled?: boolean;
  parityPolicy?: ParityPolicy;
  priceToleranceBps?: number;
  maxQuantityPerLine?: number;
  maxLines?: number;
  strategy?: SessionStrategy;
  allowPermalinkFallback?: boolean;
}

export type LinkPatch = Partial<Omit<NewLink, 'vitrineStoreId' | 'checkoutStoreId'>>;

// ---------------------------------------------------------------------------
// Catálogo sincronizado (fonte confiável de produto/variante/preço)
// ---------------------------------------------------------------------------

export type ProductStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED';
export type InventoryPolicy = 'DENY' | 'CONTINUE';

export interface VariantOption {
  name: string;
  value: string;
}

export interface CatalogVariant {
  storeId: string;
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
  currency: string;
  availableForSale: boolean;
  inventoryPolicy: InventoryPolicy;
  /** null quando o estoque não é rastreado ou o escopo não permite ler. */
  inventoryQuantity: number | null;
  tracked: boolean;
  /** Miniatura da variante (ou do produto, quando a variante não tem imagem própria). */
  imageUrl: string | null;
  /** Momento em que o registro foi lido da Shopify. */
  syncedAt: string;
}

export interface SyncResult {
  storeId: string;
  ok: boolean;
  variants: number;
  removed: number;
  durationMs: number;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Mapeamento de variantes
// ---------------------------------------------------------------------------

/**
 * active:    usado no checkout.
 * suggested: casamento automático menos seguro (por título); precisa de aprovação.
 * conflict:  mais de um candidato; precisa de escolha manual.
 * unmapped:  nenhum candidato encontrado.
 * disabled:  desligado manualmente.
 */
export type MappingStatus = 'active' | 'suggested' | 'conflict' | 'unmapped' | 'disabled';
export type MatchMethod = 'sku' | 'barcode' | 'handle_options' | 'title_options' | 'manual';

export type DivergenceKind =
  | 'price'
  | 'compare_at_price'
  | 'currency'
  | 'title'
  | 'options'
  | 'availability'
  | 'product_status';

export interface Divergence {
  kind: DivergenceKind;
  vitrine: string;
  checkout: string;
}

export interface VariantMapping {
  vitrineStoreId: string;
  checkoutStoreId: string;
  vitrineVariantId: string;
  checkoutVariantId: string | null;
  status: MappingStatus;
  method: MatchMethod | null;
  /** IDs de variantes candidatas no checkout quando status = 'conflict'. */
  candidates: string[];
  divergences: Divergence[];
  /** Decisões manuais ficam travadas e o casamento automático não as sobrescreve. */
  locked: boolean;
  updatedAt: string;
}

export interface MappingListOptions {
  status?: MappingStatus;
  divergentOnly?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

export interface MappingCounts {
  active: number;
  suggested: number;
  conflict: number;
  unmapped: number;
  disabled: number;
  divergent: number;
  total: number;
}

export interface MatchSummary {
  vitrineStoreId: string;
  checkoutStoreId: string;
  counts: MappingCounts;
}

// ---------------------------------------------------------------------------
// Sessões de checkout
// ---------------------------------------------------------------------------

export type SessionStatus = 'pending' | 'created' | 'failed';
export type SessionStrategy = 'storefront_cart' | 'permalink';

export interface SessionLine {
  vitrineVariantId: string;
  checkoutVariantId: string;
  quantity: number;
}

export interface CheckoutSession {
  id: string;
  idempotencyKey: string;
  vitrineStoreId: string;
  checkoutStoreId: string;
  linkId: string;
  status: SessionStatus;
  strategy: SessionStrategy | null;
  lines: SessionLine[];
  country: string | null;
  checkoutUrl: string | null;
  cartId: string | null;
  subtotal: string | null;
  currency: string | null;
  errorCode: BridgeErrorCode | null;
  /** HMAC do IP do comprador com sal do servidor. O IP em claro não é guardado. */
  ipHash: string | null;
  /** ID do pedido na loja checkout quando o webhook de pedido confirmou a conversão. */
  orderId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SessionListOptions {
  vitrineStoreId?: string;
  checkoutStoreId?: string;
  status?: SessionStatus;
  limit: number;
  offset: number;
}

export interface SessionStats {
  since: string;
  created: number;
  failed: number;
  byError: Record<string, number>;
  byCheckoutStore: Record<string, number>;
}

/** Consentimento de privacidade do comprador na vitrine, levado ao checkout. */
export interface VisitorConsent {
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
  saleOfData: boolean;
}

/** Linha recebida do tema da vitrine. Não contém preço. */
export interface RequestLine {
  variantId: string;
  quantity: number;
  /** Propriedades da linha (personalização). Chaves e valores limitados e saneados. */
  properties?: Record<string, string>;
  /** true quando a linha da vitrine tem plano de assinatura; hoje isso bloqueia o checkout. */
  hasSellingPlan?: boolean;
}

export interface CheckoutRequest {
  /** Domínio xxx.myshopify.com da vitrine, vindo dos parâmetros assinados do App Proxy. */
  shopDomain: string;
  lines: RequestLine[];
  /** Token do carrinho da vitrine. Usado só na chave de idempotência. */
  cartToken?: string;
  /**
   * Identificador aleatório por navegador, gerado pelo script do tema (8..64 caracteres de
   * [A-Za-z0-9_-]). Usado só na chave de idempotência quando não há token do carrinho.
   */
  clientNonce?: string;
  /** País do comprador (ISO alpha-2). Decide rota e mercado; não decide preço. */
  country?: string;
  discountCodes?: string[];
  /** Parâmetros de atribuição já filtrados por lista de permissão. */
  attribution?: Record<string, string>;
  /** Idioma da vitrine (por exemplo "pt-BR"), usado para abrir o checkout no mesmo idioma. */
  language?: string;
  consent?: VisitorConsent;
  /** 'cart': checkout do carrinho. 'buy_now': compra direta de um item da página de produto. */
  source?: 'cart' | 'buy_now';
}

export interface RequestContext {
  requestId: string;
  buyerIp: string | null;
  userAgent: string | null;
}

export interface CheckoutResponse {
  sessionId: string;
  checkoutUrl: string;
  strategy: SessionStrategy;
  /** true quando a resposta veio de uma sessão existente (idempotência). */
  reused: boolean;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'store_not_found'
  | 'store_disabled'
  | 'no_route'
  | 'unmapped_variant'
  | 'variant_unavailable'
  | 'quantity_exceeded'
  | 'selling_plan_unsupported'
  | 'checkout_validation'
  | 'price_divergence'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'internal';

const HTTP_STATUS: Record<BridgeErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  store_not_found: 404,
  store_disabled: 403,
  no_route: 409,
  unmapped_variant: 422,
  variant_unavailable: 422,
  quantity_exceeded: 422,
  selling_plan_unsupported: 422,
  checkout_validation: 422,
  price_divergence: 409,
  rate_limited: 429,
  upstream_unavailable: 503,
  upstream_rejected: 502,
  internal: 500,
};

/** Mensagens seguras para mostrar ao comprador. Não revelam detalhes internos. */
const PUBLIC_MESSAGE: Record<BridgeErrorCode, string> = {
  invalid_request: 'Não foi possível processar o carrinho. Atualize a página e tente novamente.',
  unauthorized: 'Requisição não autorizada.',
  forbidden: 'Requisição não permitida.',
  not_found: 'Recurso não encontrado.',
  conflict: 'Operação em conflito com o estado atual.',
  store_not_found: 'Loja não reconhecida.',
  store_disabled: 'O checkout está temporariamente indisponível.',
  no_route: 'O checkout está temporariamente indisponível.',
  unmapped_variant: 'Um item do carrinho não está disponível para compra no momento.',
  variant_unavailable: 'Um item do carrinho está sem estoque ou indisponível.',
  quantity_exceeded: 'A quantidade de um item ultrapassa o limite permitido.',
  selling_plan_unsupported: 'Itens de assinatura não podem ser finalizados por aqui.',
  checkout_validation: 'O carrinho não foi aceito pelas regras da loja. Revise os itens e tente novamente.',
  price_divergence: 'O preço de um item foi atualizado. Atualize a página e tente novamente.',
  rate_limited: 'Muitas tentativas. Aguarde alguns segundos e tente novamente.',
  upstream_unavailable: 'O checkout está temporariamente indisponível. Tente novamente em instantes.',
  upstream_rejected: 'Não foi possível criar o checkout. Tente novamente.',
  internal: 'Erro inesperado. Tente novamente.',
};

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  /** Detalhes internos para log e auditoria. Nunca enviados ao navegador do comprador. */
  readonly details: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.publicMessage = PUBLIC_MESSAGE[code];
    this.details = details;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  at: string;
  /** 'admin', 'system' ou 'webhook'. */
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** Dados não sensíveis. Segredos e dados pessoais não entram aqui. */
  detail: Record<string, unknown>;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'>;

// ---------------------------------------------------------------------------
// Pedidos (vendas) registrados a partir dos webhooks das lojas
// ---------------------------------------------------------------------------

/**
 * Registro mínimo de um pedido, sem dados pessoais: nada de nome, e-mail, telefone ou
 * endereço do comprador. Pedidos de lojas checkout alimentam o painel de vendas; pedidos
 * de lojas vitrine indicam checkout feito fora da ponte (vazamento) e geram alerta.
 */
export interface OrderRecord {
  storeId: string;
  /** ID numérico do pedido na Shopify, como string. */
  orderId: string;
  /** Nome exibido na Shopify, por exemplo "#1001". */
  orderName: string;
  /** Data de criação informada pela Shopify (ISO 8601 UTC). */
  createdAt: string;
  currency: string;
  subtotal: string;
  total: string;
  totalRefunded: string;
  /** Valor informado pela Shopify (paid, pending, refunded, partially_refunded, voided...). */
  financialStatus: string;
  cancelledAt: string | null;
  lineCount: number;
  /** Sessão da ponte lida do atributo bridge_session do pedido, quando houver. */
  bridgeSessionId: string | null;
  /** Vitrine de origem, resolvida pela sessão ou pelo atributo bridge_source. */
  vitrineStoreId: string | null;
  /** Momento em que o registro foi gravado ou atualizado aqui. */
  recordedAt: string;
}

export interface OrderListOptions {
  storeId?: string;
  vitrineStoreId?: string;
  since?: string;
  until?: string;
  limit: number;
  offset: number;
}

/** Totais por moeda: a soma só faz sentido dentro de uma mesma moeda. */
export type MoneyByCurrency = Record<string, string>;

export interface SalesStoreTotals {
  storeId: string;
  orders: number;
  revenueByCurrency: MoneyByCurrency;
}

export interface SalesDay {
  /** Dia em UTC no formato AAAA-MM-DD. */
  day: string;
  orders: number;
  revenueByCurrency: MoneyByCurrency;
}

/**
 * Receita = total do pedido menos reembolsos, de pedidos não cancelados, de lojas checkout.
 * Pedidos de lojas vitrine entram só em leakedOrders.
 */
export interface SalesStats {
  since: string;
  until: string;
  orders: number;
  cancelled: number;
  revenueByCurrency: MoneyByCurrency;
  byCheckoutStore: SalesStoreTotals[];
  byVitrine: Array<{ vitrineStoreId: string | null; orders: number; revenueByCurrency: MoneyByCurrency }>;
  daily: SalesDay[];
  leakedOrders: number;
}

export interface OrderRepo {
  /** Insere ou atualiza pelo par (storeId, orderId). */
  upsert(order: Omit<OrderRecord, 'recordedAt'>): void;
  get(storeId: string, orderId: string): OrderRecord | null;
  /** Soma um reembolso ao total reembolsado. Ignora pedido desconhecido. */
  addRefund(storeId: string, orderId: string, amount: string, at: string): void;
  markCancelled(storeId: string, orderId: string, cancelledAt: string): void;
  list(opts: OrderListOptions): { rows: OrderRecord[]; total: number };
  stats(opts: { since: string; until: string; storeId?: string }): SalesStats;
  purge(before: string): number;
}

// ---------------------------------------------------------------------------
// Quadro de operações (organização visual das vitrines em etapas)
// ---------------------------------------------------------------------------

/**
 * O quadro é só organização: colunas com nomes livres e um cartão por vitrine, com uma
 * observação. Mover um cartão de coluna não altera rota, destino nem nada do checkout;
 * a etapa é uma anotação do lojista para si mesmo.
 */
export interface BoardColumn {
  id: string;
  name: string;
  position: number;
}

export interface BoardCard {
  /** Vitrine representada pelo cartão. */
  storeId: string;
  columnId: string | null;
  position: number;
  note: string;
  /** Nome da operação dado pelo lojista (vazio = usa o nome da loja). */
  title: string;
  updatedAt: string;
}

export interface BoardRepo {
  columns(): BoardColumn[];
  addColumn(name: string): BoardColumn;
  renameColumn(id: string, name: string): void;
  /** Cartões da coluna removida voltam para "sem etapa" (columnId null). */
  deleteColumn(id: string): void;
  cards(): BoardCard[];
  card(storeId: string): BoardCard | null;
  /** Coloca o cartão na coluna e posição informadas (coluna null = sem etapa). */
  moveCard(storeId: string, columnId: string | null, position: number): void;
  setNote(storeId: string, note: string): void;
  setTitle(storeId: string, title: string): void;
}

// ---------------------------------------------------------------------------
// Portas: infraestrutura
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  take(key: string, cost?: number): RateLimitDecision;
}

export type MetricLabels = Record<string, string>;

export interface Metrics {
  inc(name: string, labels?: MetricLabels, value?: number): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  /** Exposição em formato de texto Prometheus. */
  render(): string;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  /** Chave de deduplicação; alertas com a mesma chave respeitam um intervalo mínimo. */
  key: string;
  severity: AlertSeverity;
  title: string;
  detail?: Record<string, unknown>;
}

export interface Alerter {
  /** Nunca lança e nunca bloqueia quem chama. */
  notify(alert: Alert): void;
}

// ---------------------------------------------------------------------------
// Portas: repositórios (SQLite síncrono)
// ---------------------------------------------------------------------------

export interface StoreRepo {
  list(filter?: { role?: StoreRole }): Store[];
  get(id: string): Store | null;
  getByShopDomain(shopDomain: string): Store | null;
  create(input: NewStore): Store;
  update(id: string, patch: StorePatch): Store;
  delete(id: string): void;
  getSecrets(id: string): StoreSecrets;
  markSynced(id: string, result: { at: string; ok: boolean; detail: string | null }): void;
}

export interface LinkRepo {
  list(filter?: { vitrineStoreId?: string; checkoutStoreId?: string; enabledOnly?: boolean }): Link[];
  get(id: string): Link | null;
  /** Lança BridgeError('conflict') se violar as regras de unicidade de rota. */
  create(input: NewLink): Link;
  update(id: string, patch: LinkPatch): Link;
  delete(id: string): void;
}

export interface CatalogRepo {
  upsertVariants(variants: CatalogVariant[]): void;
  /** Substitui todas as variantes de um produto pelas informadas (remove as que sumiram). */
  replaceProduct(storeId: string, productId: string, variants: CatalogVariant[]): void;
  deleteProduct(storeId: string, productId: string): void;
  /** Remove variantes com syncedAt anterior ao informado. Devolve quantas removeu. */
  deleteStale(storeId: string, olderThan: string): number;
  deleteStore(storeId: string): void;
  getVariant(storeId: string, variantId: string): CatalogVariant | null;
  getVariants(storeId: string, variantIds: string[]): Map<string, CatalogVariant>;
  listAll(storeId: string): CatalogVariant[];
  search(storeId: string, opts: { query?: string; limit: number; offset: number }): CatalogVariant[];
  count(storeId: string): number;
}

export interface MappingRepo {
  get(vitrineStoreId: string, checkoutStoreId: string, vitrineVariantId: string): VariantMapping | null;
  getMany(
    vitrineStoreId: string,
    checkoutStoreId: string,
    vitrineVariantIds: string[],
  ): Map<string, VariantMapping>;
  listAll(vitrineStoreId: string, checkoutStoreId: string): VariantMapping[];
  list(
    vitrineStoreId: string,
    checkoutStoreId: string,
    opts: MappingListOptions,
  ): { rows: VariantMapping[]; total: number };
  counts(vitrineStoreId: string, checkoutStoreId: string): MappingCounts;
  /**
   * Grava resultados do casamento automático. Linhas com locked = true já existentes
   * mantêm checkoutVariantId, status, method e locked; só as divergências são atualizadas.
   */
  upsertAuto(mappings: VariantMapping[]): void;
  /** Decisão manual: grava e trava a linha. */
  setManual(mapping: VariantMapping): void;
  /**
   * Destrava a linha para que o próximo casamento automático volte a decidir por ela.
   * Não altera o destino atual; quem chama deve recalcular o par em seguida.
   */
  unlock(vitrineStoreId: string, checkoutStoreId: string, vitrineVariantId: string): void;
  /** Remove mapeamentos de variantes da vitrine que não existem mais no catálogo. */
  deleteMissing(vitrineStoreId: string, checkoutStoreId: string, keepVitrineVariantIds: string[]): number;
  deleteForStore(storeId: string): void;
}

export interface SessionRepo {
  /**
   * Sessão "viva" com a chave informada: não expirada e em status 'created', ou em
   * 'pending' criada há menos de 60 segundos. Sessões 'failed' e 'pending' antigas
   * (processo interrompido) não contam, para que uma nova tentativa possa prosseguir.
   */
  findActiveByKey(idempotencyKey: string, now: string): CheckoutSession | null;
  /**
   * Insere a sessão em status 'pending'. Se já existir sessão viva com a mesma chave
   * (mesma regra de findActiveByKey), não insere e devolve a existente. Operação atômica.
   */
  insertPending(session: CheckoutSession, now: string): { inserted: boolean; session: CheckoutSession };
  markCreated(
    id: string,
    patch: {
      strategy: SessionStrategy;
      checkoutUrl: string;
      cartId: string | null;
      subtotal: string | null;
      currency: string | null;
    },
  ): void;
  markFailed(id: string, errorCode: BridgeErrorCode): void;
  /** Liga a sessão ao pedido criado na loja checkout. Idempotente; ignora id desconhecido. */
  markConverted(id: string, orderId: string, at: string): void;
  get(id: string): CheckoutSession | null;
  list(opts: SessionListOptions): CheckoutSession[];
  stats(since: string): SessionStats;
  purgeExpired(before: string): number;
  /**
   * Apaga a URL do checkout e o id do carrinho das sessões 'created' já expiradas
   * (expires_at < now). A URL leva a chave do carrinho da Shopify e só serve enquanto
   * a sessão vale para a idempotência; o resto da sessão (histórico) fica. Devolve
   * quantas sessões foram limpas.
   */
  scrubExpired(now: string): number;
}

export interface AuditRepo {
  record(entry: NewAuditEntry): void;
  list(opts: { limit: number; offset: number; targetType?: string; targetId?: string }): AuditEntry[];
  purge(before: string): number;
}

export interface WebhookEventRepo {
  /** Registra o evento. Devolve true se ele já tinha sido visto (entrega duplicada). */
  markSeen(eventId: string, at: string): boolean;
  purge(before: string): number;
}

export interface AdminSession {
  id: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface AdminSessionRepo {
  create(session: AdminSession, tokenHash: string): void;
  findByTokenHash(tokenHash: string, now: string): AdminSession | null;
  delete(id: string): void;
  purgeExpired(before: string): number;
}

/**
 * Última execução concluída de cada tarefa periódica (chave: nome da tarefa, ex.:
 * "catalog_resync"), para que o agendamento sobreviva a reinícios do processo.
 */
export interface JobRunRepo {
  getLastRunAt(job: string): string | null;
  setLastRunAt(job: string, at: string): void;
}

export interface Repos {
  stores: StoreRepo;
  links: LinkRepo;
  catalog: CatalogRepo;
  mappings: MappingRepo;
  sessions: SessionRepo;
  audit: AuditRepo;
  webhookEvents: WebhookEventRepo;
  adminSessions: AdminSessionRepo;
  jobRuns: JobRunRepo;
  orders: OrderRepo;
  board: BoardRepo;
}

// ---------------------------------------------------------------------------
// Portas: Shopify
// ---------------------------------------------------------------------------

export interface AdminTokenProvider {
  /** Token da Admin API obtido por client credentials grant, com cache e renovação. */
  getToken(store: Store): Promise<string>;
  /** Escopos concedidos ao app na loja, lidos da resposta do token (campo scope). */
  getScopes(store: Store): Promise<string[]>;
  invalidate(storeId: string): void;
}

export interface AdminClient {
  /** Executa uma operação GraphQL na Admin API. Trata limite de custo, timeout e retry. */
  graphql<T>(store: Store, query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface ShopInfo {
  name: string;
  currency: string;
  primaryDomainHost: string | null;
  myshopifyDomain: string;
}

export interface CartLineInput {
  /** ID numérico da variante na loja checkout. */
  variantId: string;
  quantity: number;
  attributes?: Array<{ key: string; value: string }>;
}

export interface CartCreateInput {
  lines: CartLineInput[];
  attributes: Array<{ key: string; value: string }>;
  countryCode?: string;
  discountCodes?: string[];
  buyerIp?: string | null;
  language?: string;
  consent?: VisitorConsent;
}

export interface CartLineResult {
  /** ID da linha no carrinho (alvo dos avisos). */
  lineId: string;
  variantId: string;
  quantity: number;
  /** Preço unitário que a loja checkout vai cobrar. */
  unitPrice: string;
  currency: string;
  availableForSale: boolean;
}

export interface CartWarning {
  code: string;
  message: string;
  target: string | null;
}

export interface CartCreateResult {
  cartId: string;
  checkoutUrl: string;
  currency: string;
  subtotal: string;
  total: string;
  lines: CartLineResult[];
  warnings: CartWarning[];
  discountCodes: Array<{ code: string; applicable: boolean }>;
}

export interface StorefrontClient {
  /**
   * Cria um carrinho na loja checkout.
   * Lança BridgeError('upstream_rejected') com userErrors em details quando a Shopify recusa,
   * e BridgeError('upstream_unavailable') em falha de rede, timeout ou circuito aberto.
   * userErrors com CartErrorCode determinístico (regra de quantidade, plano de venda,
   * mercadoria não aplicável, validação de checkout) saem com o código próprio
   * ('quantity_exceeded', 'selling_plan_unsupported', 'variant_unavailable',
   * 'checkout_validation'): repetir o mesmo carrinho não resolve.
   */
  createCart(store: Store, input: CartCreateInput): Promise<CartCreateResult>;
}

// ---------------------------------------------------------------------------
// Portas: serviços
// ---------------------------------------------------------------------------

export interface CatalogSyncService {
  /** Sincronização completa do catálogo de uma loja. Não lança; devolve ok = false em erro. */
  syncStore(storeId: string): Promise<SyncResult>;
  /** Relê um produto da Admin API e substitui as variantes dele no catálogo. */
  refreshProduct(storeId: string, productId: string): Promise<void>;
  removeProduct(storeId: string, productId: string): void;
  /** Lê nome, moeda e domínio da loja e valida as credenciais. */
  fetchShopInfo(store: Store): Promise<ShopInfo>;
}

export interface MatchService {
  /** Recalcula o mapeamento automático e as divergências do par inteiro. */
  rematchPair(vitrineStoreId: string, checkoutStoreId: string): MatchSummary;
  /** Recalcula todos os pares em que a loja participa (vitrine ou checkout). */
  rematchStore(storeId: string): MatchSummary[];
}

export interface LinkTestProblem {
  vitrineVariantId: string;
  checkoutVariantId: string | null;
  problem: string;
}

export interface LinkTestResult {
  linkId: string;
  ok: boolean;
  strategy: SessionStrategy;
  /** Quantas variantes mapeadas entraram no carrinho de teste. */
  tested: number;
  problems: LinkTestProblem[];
  detail: string | null;
}

export interface CheckoutService {
  createCheckout(request: CheckoutRequest, ctx: RequestContext): Promise<CheckoutResponse>;
  /**
   * Diagnóstico de uma rota: monta um carrinho de teste na loja checkout com uma amostra das
   * variantes mapeadas e informa quais falharam (não publicada, sem estoque, preço divergente).
   * Não cria sessão nem redireciona ninguém.
   */
  testLink(linkId: string, sampleSize?: number): Promise<LinkTestResult>;
}

export interface WebhookRegistrar {
  /** Garante as assinaturas de webhook da loja apontando para este serviço. Idempotente. */
  ensure(store: Store): Promise<{ created: string[]; existing: string[] }>;
}

export type ConnectionStepName = 'credentials' | 'scopes' | 'webhooks' | 'catalog' | 'mappings';

export interface ConnectionStep {
  name: ConnectionStepName;
  ok: boolean;
  detail: string;
}

export interface ConnectionReport {
  storeId: string;
  ok: boolean;
  steps: ConnectionStep[];
  missingScopes: string[];
  shop: ShopInfo | null;
}

export interface StoreConnectionService {
  /**
   * Valida as credenciais, confere escopos, garante webhooks, sincroniza o catálogo e
   * recalcula os mapeamentos da loja. Atualiza status e dados da loja. Não lança.
   */
  connect(storeId: string): Promise<ConnectionReport>;
}

/** Fila em memória que agrupa eventos de catálogo vindos de webhooks. */
export interface CatalogEventQueue {
  productChanged(storeId: string, productId: string): void;
  productDeleted(storeId: string, productId: string): void;
  /** Resolve quando não há trabalho pendente. Usado em testes e no desligamento. */
  idle(): Promise<void>;
  stop(): void;
}
