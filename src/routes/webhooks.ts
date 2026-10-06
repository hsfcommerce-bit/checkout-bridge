import { Hono } from 'hono';
import { isoNow, systemClock } from '../lib/clock.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { safeJsonParse } from '../lib/http.ts';
import { fromGid, isValidShopDomain, isValidVariantId } from '../lib/shop.ts';
import { verifyWebhookHmac } from '../shopify/webhook-hmac.ts';
import type {
  AdminTokenProvider,
  Alerter,
  CatalogEventQueue,
  Clock,
  Logger,
  Metrics,
  OrderRecord,
  Repos,
  Store,
  StorePatch,
} from '../types.ts';

/**
 * Recebimento dos webhooks da Shopify (URL pública: /webhooks/shopify).
 *
 * A Shopify espera a resposta inteira em até 5 segundos e trata qualquer coisa fora de
 * 2xx como falha (8 falhas seguidas apagam a assinatura criada pela API). Por isso o
 * handler só autentica, descarta repetição e enfileira; o trabalho pesado (reler o produto
 * pela Admin API) acontece depois, na fila.
 *
 * O que é e o que não é autenticado: o HMAC cobre SOMENTE os bytes do corpo. Tópico,
 * domínio da loja e identificadores da entrega chegam em cabeçalhos não assinados. O
 * domínio fica amarrado ao corpo de forma indireta (a chave do HMAC é o segredo daquela
 * loja); o tópico e os ids não ficam, e o código abaixo não confia neles além do necessário.
 */

/** Limite do corpo. Um produto com 2.048 variantes fica bem abaixo disso. */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

const HANDLED_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'app/uninstalled',
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
] as const;
type HandledTopic = (typeof HANDLED_TOPICS)[number];

const UNINSTALLED_DETAIL = 'App desinstalado na loja';

/** Id de entrega aceito como veio (a Shopify manda UUID); fora disso entra só o hash. */
const DELIVERY_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Maior string de campo que vale a pena decodificar (GID e domínio são bem menores). */
const MAX_FIELD_CHARS = 512;

const utf8 = new TextDecoder('utf-8');

function handledTopic(value: string | null): HandledTopic | null {
  const normalized = value === null ? '' : value.toLowerCase();
  return HANDLED_TOPICS.find((topic) => topic === normalized) ?? null;
}

/**
 * Lê um cabeçalho da entrega. Headers.get já ignora maiúsculas e minúsculas (o HTTP/2
 * entrega tudo em minúsculas). O nome sem o prefixo "X-" é o esquema do mecanismo novo de
 * Events (prévia de 2026); aceitar os dois nomes não custa nada, mas o FORMATO do corpo
 * de Events é outro e não é tratado aqui: esses tópicos caem em "ignorado".
 */
function shopifyHeader(headers: Headers, name: string): string | null {
  const value = headers.get(`x-shopify-${name}`) ?? headers.get(`shopify-${name}`);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false };

/**
 * Lê o corpo cru com teto de tamanho. Content-Length acima do teto é recusado sem ler
 * nada; como o cabeçalho pode faltar ou mentir, a leitura também conta os bytes e para
 * assim que o teto é ultrapassado, sem acumular o resto na memória.
 */
async function readBodyLimited(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared) > maxBytes) return { ok: false };
  const stream = request.body;
  if (stream === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const only = chunks.length === 1 ? chunks[0] : undefined;
  return { ok: true, bytes: only ?? Buffer.concat(chunks, total) };
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  for (;;) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) i += 1;
    else return i;
  }
}

/** Índice da aspa que fecha a string aberta em `open`, ou -1 se ela não fecha. */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 92) i += 1;
    else if (code === 34) return i;
  }
  return -1;
}

export interface TopLevelField {
  kind: 'number' | 'string';
  /** Número: o texto do número exatamente como veio. String: o valor já decodificado. */
  value: string;
}

function readScalar(text: string, at: number): TopLevelField | null {
  if (text.charCodeAt(at) === 34) {
    const end = stringEnd(text, at);
    if (end === -1 || end - at > MAX_FIELD_CHARS) return null;
    // Só este pedaço pequeno passa pelo JSON.parse, para resolver escapes ("\/", "A").
    const parsed = safeJsonParse<unknown>(text.slice(at, end + 1));
    return parsed.ok && typeof parsed.value === 'string' ? { kind: 'string', value: parsed.value } : null;
  }
  const numberRe = /-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  numberRe.lastIndex = at;
  const match = numberRe.exec(text);
  return match ? { kind: 'number', value: match[0] } : null;
}

/**
 * Lê um campo escalar do PRIMEIRO nível do objeto JSON, direto do texto.
 *
 * Existe por causa dos ids: JSON.parse transforma número em double e, acima de 2^53,
 * devolve um vizinho (9007199254740993 vira 9007199254740992) sem avisar. Aqui o número
 * sai como texto, dígito por dígito. Chaves iguais dentro de objetos aninhados ("id" de
 * cada variante, de cada imagem) não são confundidas com a do primeiro nível.
 *
 * Devolve null se o texto não começa com um objeto, se a chave não existe no primeiro
 * nível ou se o valor não é número nem string.
 */
export function readTopLevelField(text: string, key: string): TopLevelField | null {
  let i = skipWhitespace(text, 0);
  if (text.charCodeAt(i) !== 123) return null;
  let depth = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      const end = stringEnd(text, i);
      if (end === -1) return null;
      if (depth === 1) {
        // No primeiro nível, string seguida de ":" só pode ser chave.
        const after = skipWhitespace(text, end + 1);
        if (text.charCodeAt(after) === 58) {
          if (end - i - 1 === key.length && text.startsWith(key, i + 1)) {
            return readScalar(text, skipWhitespace(text, after + 1));
          }
          i = after + 1;
          continue;
        }
      }
      i = end + 1;
      continue;
    }
    if (code === 123 || code === 91) depth += 1;
    else if (code === 125 || code === 93) {
      depth -= 1;
      if (depth === 0) return null;
    }
    i += 1;
  }
  return null;
}

/** Id numérico do primeiro nível ("id": 123 ou "id": "123"), validado como id da Shopify. */
function topLevelNumericId(text: string): string | null {
  const field = readTopLevelField(text, 'id');
  return field !== null && isValidVariantId(field.value) ? field.value : null;
}

/**
 * Id do produto em products/create e products/update: vem de admin_graphql_api_id. O
 * resto do corpo (formato REST) é ignorado de propósito: a lista de variantes pode vir
 * cortada, e a fila relê tudo por GraphQL. O "id" numérico só entra como reserva, lido
 * como texto, se o GID faltar.
 */
function productIdFromPayload(text: string): string | null {
  const gid = readTopLevelField(text, 'admin_graphql_api_id');
  if (gid !== null && gid.kind === 'string' && gid.value.startsWith('gid://shopify/Product/')) {
    try {
      return fromGid(gid.value);
    } catch {
      // GID fora do formato: tenta o id numérico logo abaixo.
    }
  }
  return topLevelNumericId(text);
}

/**
 * Checagem de coerência de app/uninstalled, cujo corpo é o recurso Shop. Como o tópico
 * não é assinado, um corpo válido de OUTRO tópico reenviado com este cabeçalho marcaria a
 * loja como desinstalada. Recusa o que claramente é outro recurso (GID que não é de Shop)
 * ou outra loja. Campos ausentes não reprovam: a presença deles no corpo real não foi
 * conferida em uma loja de verdade (precisa de teste em loja real).
 */
function looksLikeUninstallPayload(text: string, store: Store): boolean {
  const gid = readTopLevelField(text, 'admin_graphql_api_id');
  if (gid !== null && !(gid.kind === 'string' && gid.value.startsWith('gid://shopify/Shop/'))) return false;
  const domain = readTopLevelField(text, 'myshopify_domain');
  if (domain !== null && domain.value.toLowerCase() !== store.shopDomain) return false;
  return true;
}

/**
 * Chave de deduplicação. O id da entrega é X-Shopify-Event-Id (na falta,
 * X-Shopify-Webhook-Id), mas o Event-Id é compartilhado por TODAS as entregas nascidas da
 * mesma ação do lojista. Não está documentado se uma edição em massa de 50 produtos gera
 * 50 entregas com o mesmo Event-Id; se gerar, deduplicar só por ele descartaria 49
 * atualizações de preço. Por isso a chave inclui loja, tópico e recurso.
 */
function dedupeKey(deliveryId: string, storeId: string, topic: HandledTopic, resource: string): string {
  const id = DELIVERY_ID_RE.test(deliveryId) ? deliveryId : `h:${sha256Hex(deliveryId).slice(0, 40)}`;
  return `${id}|${storeId}|${topic}|${resource}`;
}

type OrderDraft = Omit<OrderRecord, 'recordedAt' | 'vitrineStoreId'> & { sourceShopDomain: string | null };

type Action =
  | { kind: 'product_changed'; productId: string }
  | { kind: 'product_deleted'; productId: string }
  | { kind: 'app_uninstalled' }
  | { kind: 'order_upsert'; order: OrderDraft }
  | { kind: 'order_cancelled'; orderId: string; cancelledAt: string }
  | { kind: 'refund'; orderId: string; amount: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid' };

const MONEY_RE = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function moneyField(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string' && MONEY_RE.test(value.trim())) return value.trim();
  return null;
}

/** Id de pedido: prefere o GID (string, sem perda de precisão); aceita número seguro. */
function orderIdField(obj: Record<string, unknown>, gidKey: string, idKey: string): string | null {
  const gid = obj[gidKey];
  if (typeof gid === 'string' && /^gid:\/\/shopify\/(Order|Refund)\/[0-9]+$/.test(gid)) {
    const tail = gid.slice(gid.lastIndexOf('/') + 1);
    if (gidKey === 'admin_graphql_api_id' && gid.includes('/Order/')) return tail;
  }
  const id = obj[idKey];
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) return id;
  return null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Pedido vindo de orders/create, orders/updated ou orders/cancelled. Só copia o que o
 * contrato OrderRecord prevê: nome, e-mail, telefone, endereço e qualquer outro dado do
 * comprador ficam de fora de propósito. Pedidos de teste (test = true) são ignorados.
 */
function parseOrder(text: string): Action {
  const parsed = safeJsonParse(text);
  const obj = parsed.ok ? asRecord(parsed.value) : null;
  if (obj === null) return { kind: 'invalid' };
  if (obj['test'] === true) return { kind: 'ignored', reason: 'test_order' };
  const orderId = orderIdField(obj, 'admin_graphql_api_id', 'id');
  const createdAt = isoOrNull(obj['created_at']) ?? isoOrNull(obj['processed_at']);
  const total = moneyField(obj['total_price'] ?? obj['current_total_price']);
  const currency = typeof obj['currency'] === 'string' ? obj['currency'].toUpperCase() : null;
  if (orderId === null || createdAt === null || total === null || currency === null || !/^[A-Z]{3}$/.test(currency)) {
    return { kind: 'invalid' };
  }
  let bridgeSessionId: string | null = null;
  let sourceShopDomain: string | null = null;
  const attrs = obj['note_attributes'];
  if (Array.isArray(attrs)) {
    for (const item of attrs) {
      const a = asRecord(item);
      if (a === null || typeof a['name'] !== 'string' || typeof a['value'] !== 'string') continue;
      if (a['name'] === 'bridge_session' && /^cs_[a-f0-9]{8,40}$/.test(a['value'])) bridgeSessionId = a['value'];
      if (a['name'] === 'bridge_source' && isValidShopDomain(a['value'].toLowerCase())) sourceShopDomain = a['value'].toLowerCase();
    }
  }
  const lineItems = obj['line_items'];
  const name = typeof obj['name'] === 'string' && obj['name'] !== '' ? obj['name'].slice(0, 60) : `#${orderId}`;
  return {
    kind: 'order_upsert',
    order: {
      storeId: '',
      orderId,
      orderName: name,
      createdAt,
      currency,
      subtotal: moneyField(obj['subtotal_price'] ?? obj['current_subtotal_price']) ?? total,
      total,
      totalRefunded: '0.00',
      financialStatus: typeof obj['financial_status'] === 'string' ? obj['financial_status'].slice(0, 40) : '',
      cancelledAt: isoOrNull(obj['cancelled_at']),
      lineCount: Array.isArray(lineItems) ? lineItems.length : 0,
      bridgeSessionId,
      sourceShopDomain,
    },
  };
}

/** refunds/create: soma das transações de reembolso bem-sucedidas; senão, os itens reembolsados. */
function parseRefund(text: string): Action {
  const parsed = safeJsonParse(text);
  const obj = parsed.ok ? asRecord(parsed.value) : null;
  if (obj === null) return { kind: 'invalid' };
  const orderId = orderIdField(obj, 'order_admin_graphql_api_id', 'order_id');
  if (orderId === null) return { kind: 'invalid' };
  let cents = 0n;
  let found = false;
  const toMicro = (value: string): bigint => {
    const [whole = '0', frac = ''] = value.replace('-', '').split('.');
    return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  };
  for (const item of Array.isArray(obj['transactions']) ? obj['transactions'] : []) {
    const t = asRecord(item);
    if (t === null || t['kind'] !== 'refund' || (t['status'] !== undefined && t['status'] !== 'success')) continue;
    const amount = moneyField(t['amount']);
    if (amount === null) continue;
    cents += toMicro(amount);
    found = true;
  }
  if (!found) {
    for (const item of Array.isArray(obj['refund_line_items']) ? obj['refund_line_items'] : []) {
      const r = asRecord(item);
      const amount = r === null ? null : moneyField(r['subtotal']);
      if (amount === null) continue;
      cents += toMicro(amount);
      found = true;
    }
  }
  if (!found || cents <= 0n) return { kind: 'ignored', reason: 'no_refund_amount' };
  const whole = cents / 1_000_000n;
  const frac = (cents % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return { kind: 'refund', orderId, amount: frac === '' ? `${whole}.00` : `${whole}.${frac.padEnd(2, '0')}` };
}

function classify(topic: HandledTopic, text: string, store: Store): Action {
  if (topic === 'app/uninstalled') {
    return looksLikeUninstallPayload(text, store) ? { kind: 'app_uninstalled' } : { kind: 'invalid' };
  }
  if (topic === 'refunds/create') return parseRefund(text);
  if (topic === 'orders/create' || topic === 'orders/updated' || topic === 'orders/cancelled') {
    const action = parseOrder(text);
    if (action.kind === 'order_upsert' && topic === 'orders/cancelled') {
      return { kind: 'order_cancelled', orderId: action.order.orderId, cancelledAt: action.order.cancelledAt ?? isoNow(systemClock) };
    }
    return action;
  }
  // products/delete traz só {"id": <número>}; create e update trazem o recurso inteiro.
  const productId = topic === 'products/delete' ? topLevelNumericId(text) : productIdFromPayload(text);
  if (productId === null) return { kind: 'invalid' };
  return topic === 'products/delete' ? { kind: 'product_deleted', productId } : { kind: 'product_changed', productId };
}

export function createWebhookRoutes(deps: {
  repos: Repos;
  queue: CatalogEventQueue;
  tokens: AdminTokenProvider;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  clock?: Clock;
}): Hono {
  const { repos, queue, tokens, metrics, alerter } = deps;
  const logger = deps.logger.child({ module: 'webhooks' });
  const clock = deps.clock ?? systemClock;

  function count(topic: HandledTopic | null, result: string): void {
    // O tópico vem de cabeçalho não assinado: fora da lista conhecida vira "other", para
    // que ninguém crie séries de métrica à vontade.
    metrics.inc('bridge_webhooks_total', { topic: topic ?? 'other', result });
  }

  /**
   * Desinstalação: a loja deixa de ter token válido. Cada passo é tentado mesmo que o
   * anterior falhe (o alerta não pode depender de o banco aceitar a gravação); a primeira
   * falha é relançada no fim para a entrega ser respondida com erro.
   */
  /**
   * Grava o pedido (sem dados pessoais) e liga a sessão da ponte quando o atributo
   * bridge_session veio no pedido. Em loja vitrine o pedido é um vazamento: fechou fora da
   * ponte, então gera alerta para o lojista revisar os botões de checkout do tema.
   */
  function applyOrder(store: Store, draft: OrderDraft): void {
    const { sourceShopDomain, ...rest } = draft;
    let vitrineStoreId: string | null = null;
    if (rest.bridgeSessionId !== null) {
      const session = repos.sessions.get(rest.bridgeSessionId);
      if (session !== null) {
        vitrineStoreId = session.vitrineStoreId;
        repos.sessions.markConverted(session.id, rest.orderId, isoNow(clock));
      }
    }
    if (vitrineStoreId === null && sourceShopDomain !== null) {
      vitrineStoreId = repos.stores.getByShopDomain(sourceShopDomain)?.id ?? null;
    }
    repos.orders.upsert({ ...rest, storeId: store.id, vitrineStoreId });
    if (store.role === 'vitrine') {
      alerter.notify({
        key: `leak:${store.id}`,
        severity: 'warning',
        title: 'Pedido criado direto na vitrine, fora da ponte',
        detail: { storeId: store.id, shopDomain: store.shopDomain, orderName: rest.orderName },
      });
    }
  }

  function applyUninstall(store: Store): void {
    let failed = false;
    let firstError: unknown;
    const attempt = (step: () => void): void => {
      try {
        step();
      } catch (err) {
        if (!failed) firstError = err;
        failed = true;
      }
    };
    // Loja desligada pelo lojista continua desligada: trocar 'disabled' por 'error'
    // apagaria uma decisão manual. Só o detalhe passa a explicar o que aconteceu.
    const patch: StorePatch =
      store.status === 'disabled'
        ? { statusDetail: UNINSTALLED_DETAIL }
        : { status: 'error', statusDetail: UNINSTALLED_DETAIL };
    attempt(() => repos.stores.update(store.id, patch));
    attempt(() => tokens.invalidate(store.id));
    attempt(() =>
      repos.audit.record({
        actor: 'webhook',
        action: 'store.app_uninstalled',
        targetType: 'store',
        targetId: store.id,
        detail: { shopDomain: store.shopDomain, role: store.role, previousStatus: store.status },
      }),
    );
    alerter.notify({
      key: `app_uninstalled:${store.id}`,
      severity: 'critical',
      title: `App desinstalado na loja ${store.name}`,
      detail: { storeId: store.id, shopDomain: store.shopDomain, role: store.role },
    });
    if (failed) throw firstError;
  }

  const app = new Hono();

  app.post('/shopify', async (c) => {
    const headers = c.req.raw.headers;
    const topicHeader = shopifyHeader(headers, 'topic');
    const topic = handledTopic(topicHeader);

    let read: BodyRead;
    try {
      read = await readBodyLimited(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
    } catch {
      // Conexão cortada no meio do corpo. Não há o que autenticar.
      count(topic, 'bad_request');
      return c.json({ error: 'bad_request' }, 400);
    }
    if (!read.ok) {
      count(topic, 'too_large');
      logger.warn({ topic: topic ?? 'other' }, 'webhook recusado: corpo acima do limite');
      return c.json({ error: 'payload_too_large' }, 413);
    }
    const body = read.bytes;

    // Loja desconhecida e assinatura errada dão a mesma resposta. O corpo nunca vai para o
    // log: sem assinatura válida ele é texto arbitrário de um desconhecido, e com
    // assinatura válida pode trazer dados da loja.
    const shopHeader = shopifyHeader(headers, 'shop-domain');
    const shopDomain = shopHeader === null ? null : shopHeader.toLowerCase();
    const validDomain = shopDomain !== null && isValidShopDomain(shopDomain) ? shopDomain : null;
    const store = validDomain === null ? null : repos.stores.getByShopDomain(validDomain);
    if (store === null) {
      count(topic, 'unauthorized');
      logger.warn(
        { reason: 'unknown_shop', topic: topic ?? 'other', shopDomain: validDomain, bytes: body.byteLength },
        'webhook recusado',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }

    let clientSecret: string;
    try {
      clientSecret = repos.stores.getSecrets(store.id).clientSecret;
    } catch (err) {
      // Falha nossa (segredo ilegível), não da Shopify: 500 para que ela tente de novo.
      count(topic, 'error');
      logger.error({ err, storeId: store.id }, 'webhook: não foi possível ler o segredo da loja');
      return c.json({ error: 'internal' }, 500);
    }
    // ATENÇÃO (rotação de segredo): por até uma hora depois de trocar o client secret a
    // Shopify ainda assina com o antigo. O contrato guarda um único segredo por loja, então
    // nessa janela as entregas dão 401 e voltam nas retentativas da Shopify (4 horas).
    if (!verifyWebhookHmac(body, shopifyHeader(headers, 'hmac-sha256'), clientSecret)) {
      count(topic, 'unauthorized');
      logger.warn(
        { reason: 'bad_hmac', topic: topic ?? 'other', storeId: store.id, bytes: body.byteLength },
        'webhook recusado',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (topic === null) {
      count(null, 'ignored');
      return c.json({});
    }

    const action = classify(topic, utf8.decode(body), store);
    if (action.kind === 'ignored') {
      count(topic, 'ignored');
      return c.json({});
    }
    if (action.kind === 'invalid') {
      // Repetir não muda o corpo, então a resposta é 200; a ressincronização periódica
      // do catálogo cobre o que este evento deixou de avisar.
      count(topic, 'invalid_payload');
      logger.warn({ topic, storeId: store.id, bytes: body.byteLength }, 'webhook com corpo inesperado; ignorado');
      return c.json({});
    }

    const resource =
      action.kind === 'app_uninstalled'
        ? store.id
        : action.kind === 'order_upsert'
          ? `order:${action.order.orderId}`
          : action.kind === 'order_cancelled' || action.kind === 'refund'
            ? `order:${action.orderId}:${action.kind}`
            : action.productId;
    const deliveryId = shopifyHeader(headers, 'event-id') ?? shopifyHeader(headers, 'webhook-id');
    try {
      // Entrega sem nenhum dos dois ids é processada: o tratamento é idempotente.
      // A marcação e o tratamento rodam no mesmo turno do laço de eventos (tudo síncrono),
      // então duas entregas iguais nunca se intercalam aqui dentro.
      if (deliveryId !== null) {
        const seen = repos.webhookEvents.markSeen(dedupeKey(deliveryId, store.id, topic, resource), isoNow(clock));
        if (seen) {
          count(topic, 'duplicate');
          return c.json({});
        }
      }
      if (action.kind === 'product_changed') queue.productChanged(store.id, action.productId);
      else if (action.kind === 'product_deleted') queue.productDeleted(store.id, action.productId);
      else if (action.kind === 'order_upsert') applyOrder(store, action.order);
      else if (action.kind === 'order_cancelled') repos.orders.markCancelled(store.id, action.orderId, action.cancelledAt);
      else if (action.kind === 'refund') repos.orders.addRefund(store.id, action.orderId, action.amount, isoNow(clock));
      else applyUninstall(store);
    } catch (err) {
      // O id já ficou marcado como visto e o contrato não tem como desmarcar: a
      // retentativa da Shopify será tratada como repetida. Por isso o alerta.
      count(topic, 'error');
      logger.error({ err, topic, storeId: store.id }, 'webhook: falha ao processar a entrega');
      alerter.notify({
        key: `webhook_failed:${store.id}:${topic}`,
        severity: 'warning',
        title: 'Falha ao processar webhook da Shopify',
        detail: { storeId: store.id, shopDomain: store.shopDomain, topic },
      });
      return c.json({ error: 'internal' }, 500);
    }

    count(topic, 'ok');
    logger.debug({ topic, storeId: store.id, action: action.kind }, 'webhook aceito');
    return c.json({});
  });

  return app;
}
