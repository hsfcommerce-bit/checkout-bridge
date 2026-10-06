import { z } from 'zod';
import { isoNow, systemClock } from '../lib/clock.ts';
import { truncate } from '../lib/http.ts';
import { toMicros } from '../lib/money.ts';
import { CircuitOpenError, HttpStatusError, isRetryableError, TimeoutError } from '../lib/resilience.ts';
import { fromGid, isValidVariantId, normalizeHost, toGid } from '../lib/shop.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type {
  AdminClient,
  Alerter,
  CatalogSyncService,
  CatalogVariant,
  Clock,
  InventoryPolicy,
  Logger,
  Metrics,
  ProductStatus,
  Repos,
  ShopInfo,
  Store,
  SyncResult,
} from '../types.ts';
import {
  CATALOG_PAGE_SIZE,
  MAX_COST_EXCEEDED,
  MIN_PAGE_SIZE,
  PAGINATION_OBJECT_CAP,
  PRODUCT_VARIANTS_QUERY,
  SHOP_INFO_QUERY,
  VARIANTS_PAGE_QUERY,
} from './queries.ts';

/**
 * Sincronização do catálogo de uma loja com a Admin API.
 *
 * Regra que orienta o arquivo inteiro: uma sincronização que falha nunca apaga nada. As
 * variantes lidas vão sendo gravadas página a página, mas a remoção do que sumiu da loja
 * (deleteStale) só acontece depois que a ÚLTIMA página chegou inteira. Um catálogo antigo
 * ainda permite vender; um catálogo pela metade faria o checkout recusar itens válidos.
 */

// ---------------------------------------------------------------------------
// Leitura defensiva das respostas
// ---------------------------------------------------------------------------

/**
 * Money é um escalar em string decimal. Número é aceito por garantia e convertido. O formato
 * é conferido com toMicros porque é por ela que todas as comparações de preço passam depois:
 * um valor que ela não lê quebraria a paridade bem longe daqui.
 */
const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => {
    try {
      toMicros(value);
      return true;
    } catch {
      return false;
    }
  });

const variantNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullish(),
  barcode: z.string().nullish(),
  price: moneySchema,
  compareAtPrice: moneySchema.nullish(),
  availableForSale: z.boolean(),
  inventoryPolicy: z.string(),
  inventoryQuantity: z.number().nullish(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
  inventoryItem: z.object({ tracked: z.boolean().nullish() }).nullish(),
});

const productFieldsSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
});

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullish(),
});

const variantsPageSchema = z.object({
  productVariants: z.object({
    nodes: z.array(variantNodeSchema.extend({ product: productFieldsSchema })),
    pageInfo: pageInfoSchema,
  }),
});

const productPageSchema = z.object({
  product: productFieldsSchema
    .extend({ variants: z.object({ nodes: z.array(variantNodeSchema), pageInfo: pageInfoSchema }) })
    .nullish(),
});

const shopInfoSchema = z.object({
  shop: z.object({
    name: z.string(),
    currencyCode: z.string().regex(/^[A-Za-z]{3}$/),
    myshopifyDomain: z.string(),
    primaryDomain: z.object({ host: z.string().nullish() }).nullish(),
  }),
});

type VariantNode = z.infer<typeof variantNodeSchema>;
type ProductFields = z.infer<typeof productFieldsSchema>;

/**
 * Resposta fora do formato esperado vira 'upstream_rejected'. Os detalhes levam só o caminho
 * e o tipo do problema, nunca os valores recebidos.
 */
function malformed(what: string, issues: string[] = []): BridgeError {
  return new BridgeError('upstream_rejected', `Resposta inesperada da Admin API (${what})`, {
    reason: 'malformed_response',
    issues,
  });
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  throw malformed(
    what,
    parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.code}`),
  );
}

function gidToId(gid: string, what: string): string {
  try {
    return fromGid(gid);
  } catch {
    throw malformed(what, ['id: invalid_gid']);
  }
}

/** SKU e código de barras em branco viram null: string vazia casaria com qualquer outra vazia. */
function blankToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toCatalogVariant(
  node: VariantNode,
  product: ProductFields,
  ctx: { storeId: string; currency: string; syncedAt: string },
): CatalogVariant {
  // Sem inventoryItem não dá para saber se o estoque é rastreado; tratar como não rastreado
  // deixa a decisão com availableForSale, que é o campo que a própria Shopify calcula.
  const tracked = node.inventoryItem?.tracked === true;
  const quantity = node.inventoryQuantity;
  const inventoryPolicy: InventoryPolicy = node.inventoryPolicy === 'CONTINUE' ? 'CONTINUE' : 'DENY';
  return {
    storeId: ctx.storeId,
    variantId: gidToId(node.id, 'variante'),
    productId: gidToId(product.id, 'produto'),
    productTitle: product.title,
    productHandle: product.handle,
    // Um status que a Shopify venha a criar é guardado como veio, igual ao repositório faz
    // na leitura: descartar a variante aqui apagaria o mapeamento dela sem ninguém notar.
    productStatus: product.status as ProductStatus,
    variantTitle: node.title,
    options: (node.selectedOptions ?? []).map((option) => ({ name: option.name, value: option.value })),
    sku: blankToNull(node.sku),
    barcode: blankToNull(node.barcode),
    price: node.price,
    compareAtPrice: node.compareAtPrice ?? null,
    currency: ctx.currency,
    availableForSale: node.availableForSale,
    inventoryPolicy,
    inventoryQuantity: tracked && typeof quantity === 'number' && Number.isFinite(quantity) ? Math.trunc(quantity) : null,
    tracked,
    syncedAt: ctx.syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Classificação de erros
// ---------------------------------------------------------------------------

/** Catálogo maior do que a paginação da Shopify alcança. */
class ObjectCapError extends Error {
  constructor() {
    super('Limite de paginação da Admin API atingido');
    this.name = 'ObjectCapError';
  }
}

/**
 * O contrato do AdminClient não diz como o código MAX_COST_EXCEEDED chega até aqui, então a
 * busca é larga: na mensagem ou em qualquer ponto dos detalhes do BridgeError.
 */
function isMaxCostExceeded(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes(MAX_COST_EXCEEDED)) return true;
  if (!isBridgeError(err)) return false;
  try {
    return JSON.stringify(err.details).includes(MAX_COST_EXCEEDED);
  } catch {
    return false;
  }
}

function isMalformed(err: unknown): boolean {
  return isBridgeError(err) && err.details['reason'] === 'malformed_response';
}

/** Todo erro que sai deste módulo é BridgeError; os detalhes do original não são repassados. */
function toBridgeError(err: unknown): BridgeError {
  if (isBridgeError(err)) return err;
  if (err instanceof CircuitOpenError || err instanceof TimeoutError || err instanceof HttpStatusError || isRetryableError(err)) {
    return new BridgeError('upstream_unavailable', 'Admin API indisponível', { cause: errorName(err) });
  }
  return new BridgeError('internal', 'Falha inesperada na sincronização de catálogo', { cause: errorName(err) });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Texto para o painel (lastSyncDetail) e para o alerta. É montado só com o código do erro:
 * a mensagem original pode trazer trechos da resposta da Shopify e não é mostrada.
 */
function describeFailure(err: unknown): { code: string; detail: string } {
  if (err instanceof ObjectCapError) {
    return {
      code: 'object_cap',
      detail:
        'O catálogo passou do limite de paginação da Shopify (25.000 variantes). A sincronização foi interrompida e nenhuma variante foi removida.',
    };
  }
  const bridge = toBridgeError(err);
  const kept = 'O catálogo anterior foi mantido.';
  switch (bridge.code) {
    case 'store_not_found':
      return { code: bridge.code, detail: 'Loja não encontrada.' };
    case 'unauthorized':
    case 'forbidden':
      return {
        code: bridge.code,
        detail: `A Shopify recusou o acesso ao catálogo. Confira as credenciais do app e o escopo read_products. ${kept}`,
      };
    case 'rate_limited':
    case 'upstream_unavailable':
      return {
        code: bridge.code,
        detail: `A Shopify não respondeu (rede, tempo limite ou limite de requisições). ${kept}`,
      };
    case 'upstream_rejected':
      if (isMalformed(bridge)) {
        return { code: 'malformed_response', detail: `A Shopify devolveu uma resposta inesperada ao ler o catálogo. ${kept}` };
      }
      if (isMaxCostExceeded(bridge)) {
        return {
          code: 'max_cost_exceeded',
          detail: `A consulta do catálogo passou do custo máximo da Shopify mesmo com a menor página. ${kept}`,
        };
      }
      return { code: bridge.code, detail: `A Shopify recusou a consulta do catálogo. ${kept}` };
    default:
      return { code: bridge.code, detail: `Erro interno ao sincronizar o catálogo. ${kept}` };
  }
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

export interface CatalogSyncDeps {
  repos: Repos;
  admin: AdminClient;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  clock?: Clock;
  /** Só para testes: página inicial e teto de objetos menores do que os reais. */
  limits?: { pageSize?: number; maxObjects?: number };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

export function createCatalogSyncService(deps: CatalogSyncDeps): CatalogSyncService {
  const { repos, admin, logger, metrics, alerter } = deps;
  const clock = deps.clock ?? systemClock;
  const initialPageSize = positiveInt(deps.limits?.pageSize, CATALOG_PAGE_SIZE);
  const maxObjects = positiveInt(deps.limits?.maxObjects, PAGINATION_OBJECT_CAP);

  /** Uma sincronização completa por loja de cada vez; chamadas simultâneas esperam a mesma. */
  const running = new Map<string, Promise<SyncResult>>();
  /**
   * Releituras de produto em curso, por loja. Sincronização completa e releitura da mesma
   * loja nunca correm juntas: cada página da completa é uma foto tirada quando a Shopify
   * respondeu, e gravá-la depois de uma releitura mais nova regravaria o que a releitura
   * mudou (até ressuscitar uma variante apagada, com synced_at = início da execução, que
   * deleteStale não alcança). No sentido inverso, uma releitura iniciada antes da completa e
   * gravada durante ela teria synced_at anterior ao início e seria apagada por deleteStale.
   * Então a completa espera as releituras em curso antes de marcar o início, e as releituras
   * novas esperam a completa terminar.
   */
  const refreshing = new Map<string, Set<Promise<void>>>();
  /**
   * Produtos removidos por webhook (removeProduct) enquanto a completa da loja corre. A
   * remoção é síncrona e não pode esperar; uma página lida antes dela não pode regravá-los.
   */
  const removedDuringSync = new Map<string, Set<string>>();

  /** Resolve quando nenhuma releitura da loja está em curso (as promessas nunca rejeitam). */
  async function awaitRefreshes(storeId: string): Promise<void> {
    for (let tasks = refreshing.get(storeId); tasks !== undefined && tasks.size > 0; tasks = refreshing.get(storeId)) {
      await Promise.all([...tasks]);
    }
  }

  function trackRefresh(storeId: string, work: () => Promise<void>): Promise<void> {
    let done: () => void = () => {};
    const task = new Promise<void>((resolve) => {
      done = resolve;
    });
    let tasks = refreshing.get(storeId);
    if (tasks === undefined) {
      tasks = new Set();
      refreshing.set(storeId, tasks);
    }
    tasks.add(task);
    return work().finally(() => {
      tasks.delete(task);
      if (tasks.size === 0 && refreshing.get(storeId) === tasks) refreshing.delete(storeId);
      done();
    });
  }

  function updateVariantGauge(store: Store): number {
    const total = repos.catalog.count(store.id);
    metrics.gauge('bridge_catalog_variants', total, { store: store.shopDomain });
    return total;
  }

  /**
   * Executa uma consulta paginada e, se a Shopify recusar pelo custo (MAX_COST_EXCEEDED),
   * corta a página pela metade e repete a MESMA página. O tamanho reduzido fica em `state`
   * e vale para o resto da execução: o custo por variante não muda de uma página para outra.
   */
  async function withPageHalving<T>(
    state: { pageSize: number },
    limit: number,
    store: Store,
    run: (first: number) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const first = Math.max(MIN_PAGE_SIZE, Math.min(state.pageSize, limit));
      try {
        return await run(first);
      } catch (err) {
        if (!isMaxCostExceeded(err) || first <= MIN_PAGE_SIZE) throw err;
        state.pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(first / 2));
        logger.warn(
          { storeId: store.id, from: first, to: state.pageSize },
          'consulta de catálogo acima do custo máximo; página reduzida pela metade',
        );
      }
    }
  }

  async function fetchShopInfo(store: Store): Promise<ShopInfo> {
    let data: unknown;
    try {
      data = await admin.graphql<unknown>(store, SHOP_INFO_QUERY);
    } catch (err) {
      throw toBridgeError(err);
    }
    const { shop } = parseWith(shopInfoSchema, data, 'loja');
    const host = shop.primaryDomain?.host;
    return {
      name: shop.name,
      currency: shop.currencyCode.toUpperCase(),
      primaryDomainHost: typeof host === 'string' ? normalizeHost(host) : null,
      myshopifyDomain: shop.myshopifyDomain.toLowerCase(),
    };
  }

  /**
   * Guarda a moeda da loja e, só quando o lojista ainda não informou nenhum, o domínio
   * público. Um domínio já preenchido nunca é trocado aqui: ele pode ter sido escolhido à mão.
   */
  function saveShopInfo(store: Store, shop: ShopInfo): void {
    const fillDomain = store.publicDomain === null && shop.primaryDomainHost !== null;
    if (store.currency === shop.currency && !fillDomain) return;
    repos.stores.update(store.id, {
      currency: shop.currency,
      ...(fillDomain ? { publicDomain: shop.primaryDomainHost } : {}),
    });
  }

  /** Confere que a paginação anda; sem isso uma resposta estranha viraria laço infinito. */
  function nextCursor(page: { endCursor?: string | null; count: number }, current: string | null): string {
    const cursor = page.endCursor;
    if (typeof cursor !== 'string' || cursor === '' || cursor === current || page.count === 0) {
      throw malformed('paginação', ['pageInfo: cursor_did_not_advance']);
    }
    return cursor;
  }

  async function runSync(storeId: string): Promise<SyncResult> {
    // O início só é marcado depois que as releituras em curso gravaram (veja `refreshing`).
    await awaitRefreshes(storeId);
    const started = clock.now();
    const startedAt = started.toISOString();
    const progress = { variants: 0, page: 0 };
    let store: Store | null = null;
    try {
      store = repos.stores.get(storeId);
      if (!store) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId });
      const current = store;

      const shop = await fetchShopInfo(current);
      saveShopInfo(current, shop);

      const ctx = { storeId, currency: shop.currency, syncedAt: startedAt };
      const state = { pageSize: initialPageSize };
      let after: string | null = null;
      for (;;) {
        const cursor: string | null = after;
        // Nunca pede além do teto: `first` encolhe para o que ainda cabe.
        const data = await withPageHalving(state, maxObjects - progress.variants, current, (first) =>
          admin.graphql<unknown>(current, VARIANTS_PAGE_QUERY, { first, after: cursor }),
        );
        progress.page += 1;
        const { nodes, pageInfo } = parseWith(variantsPageSchema, data, 'página de variantes').productVariants;
        // Cada página é gravada na própria transação, já com syncedAt = início da execução.
        // Produto apagado por webhook depois que a página foi lida fica de fora.
        const removed = removedDuringSync.get(storeId);
        const variants = nodes
          .map((node) => toCatalogVariant(node, node.product, ctx))
          .filter((variant) => removed === undefined || !removed.has(variant.productId));
        repos.catalog.upsertVariants(variants);
        progress.variants += nodes.length;
        if (!pageInfo.hasNextPage) break;
        // Ainda há variantes além do que a paginação alcança: o que foi lido é só uma
        // parte do catálogo, e remover "o que sumiu" apagaria o restante.
        if (progress.variants >= maxObjects) throw new ObjectCapError();
        after = nextCursor({ endCursor: pageInfo.endCursor, count: nodes.length }, cursor);
      }

      // Só aqui, com a última página lida e gravada, o que não apareceu nesta execução sai.
      const removed = repos.catalog.deleteStale(storeId, startedAt);
      const finished = clock.now();
      const durationMs = Math.max(0, finished.getTime() - started.getTime());
      repos.stores.markSynced(storeId, { at: finished.toISOString(), ok: true, detail: null });
      metrics.inc('bridge_catalog_sync_total', { result: 'ok' });
      metrics.observe('bridge_catalog_sync_ms', durationMs);
      const total = updateVariantGauge(current);
      logger.info(
        { storeId, variants: progress.variants, removed, total, pages: progress.page, durationMs },
        'catálogo sincronizado',
      );
      return { storeId, ok: true, variants: progress.variants, removed, durationMs, detail: null };
    } catch (err) {
      return failSync(storeId, store, started, progress, err);
    }
  }

  /**
   * Caminho de falha da sincronização completa. Não apaga nada e não lança: cada efeito
   * (banco, métrica, alerta, log) é isolado para que a falha de um não esconda os outros.
   */
  function failSync(
    storeId: string,
    store: Store | null,
    started: Date,
    progress: { variants: number; page: number },
    err: unknown,
  ): SyncResult {
    const failure = describeFailure(err);
    const detail = `${failure.detail} [${failure.code}; páginas lidas: ${progress.page}]`;
    let durationMs = 0;
    let finishedAt = started.toISOString();
    try {
      const finished = clock.now();
      durationMs = Math.max(0, finished.getTime() - started.getTime());
      finishedAt = finished.toISOString();
    } catch {
      // Relógio com defeito não pode impedir o registro da falha.
    }
    try {
      repos.stores.markSynced(storeId, { at: finishedAt, ok: false, detail });
    } catch {
      // Banco indisponível: o resultado devolvido e o alerta abaixo ainda informam a falha.
    }
    try {
      metrics.inc('bridge_catalog_sync_total', { result: 'error' });
      metrics.observe('bridge_catalog_sync_ms', durationMs);
      if (store) updateVariantGauge(store);
    } catch {
      // Métrica é acessória.
    }
    try {
      // A mensagem só entra no log quando o erro é nosso (BridgeError); a de erros de
      // terceiros pode carregar trechos de resposta e fica de fora.
      logger.error(
        {
          storeId,
          code: failure.code,
          errorName: errorName(err),
          errorMessage: isBridgeError(err) ? truncate(err.message, 300) : undefined,
          pagesRead: progress.page,
          variantsRead: progress.variants,
          durationMs,
        },
        'sincronização de catálogo falhou',
      );
    } catch {
      // Nem a falha do log pode escapar daqui.
    }
    alerter.notify({
      key: `catalog-sync:${storeId}`,
      severity: 'warning',
      title: `Sincronização de catálogo falhou: ${store?.name ?? storeId}`,
      detail: {
        storeId,
        shopDomain: store?.shopDomain ?? null,
        code: failure.code,
        detail: failure.detail,
        pagesRead: progress.page,
        variantsRead: progress.variants,
      },
    });
    return { storeId, ok: false, variants: progress.variants, removed: 0, durationMs, detail };
  }

  async function refresh(storeId: string, productId: string): Promise<void> {
    const store = repos.stores.get(storeId);
    if (!store) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId });
    if (!isValidVariantId(productId)) throw new BridgeError('invalid_request', 'ID de produto inválido');
    const id = toGid('Product', productId);

    // A moeda vem da loja, não da variante (AC-08). Loja que nunca sincronizou ainda não
    // tem moeda guardada, então ela é lida agora.
    let currency = store.currency;
    if (currency === null) {
      const shop = await fetchShopInfo(store);
      saveShopInfo(store, shop);
      currency = shop.currency;
    }

    const ctx = { storeId, currency, syncedAt: isoNow(clock) };
    const state = { pageSize: initialPageSize };
    const variants: CatalogVariant[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const data = await withPageHalving(state, maxObjects, store, (first) =>
        admin.graphql<unknown>(store, PRODUCT_VARIANTS_QUERY, { id, first, after: cursor }),
      );
      const { product } = parseWith(productPageSchema, data, 'produto');
      if (product === null || product === undefined) {
        // ID que não existe mais: o produto foi apagado (inclusive no meio da paginação).
        // PRECISA DE TESTE EM LOJA REAL: a documentação não é clara se um produto apagado
        // vem como product: null ou como erro GraphQL; o segundo caso chegaria aqui como
        // exceção do AdminClient e o catálogo ficaria como está até a próxima sincronização.
        removeProduct(storeId, productId);
        return;
      }
      if (gidToId(product.id, 'produto') !== productId) throw malformed('produto', ['product.id: mismatch']);
      for (const node of product.variants.nodes) variants.push(toCatalogVariant(node, product, ctx));
      const { pageInfo } = product.variants;
      if (!pageInfo.hasNextPage) break;
      if (variants.length >= maxObjects) throw new ObjectCapError();
      after = nextCursor({ endCursor: pageInfo.endCursor, count: product.variants.nodes.length }, cursor);
    }
    // Troca tudo de uma vez, só depois de ler todas as páginas: uma falha no meio deixa o
    // produto como estava.
    repos.catalog.replaceProduct(storeId, productId, variants);
    updateVariantGauge(store);
  }

  function removeProduct(storeId: string, productId: string): void {
    if (running.has(storeId)) {
      let removed = removedDuringSync.get(storeId);
      if (removed === undefined) {
        removed = new Set();
        removedDuringSync.set(storeId, removed);
      }
      removed.add(productId);
    }
    repos.catalog.deleteProduct(storeId, productId);
    const store = repos.stores.get(storeId);
    if (store) updateVariantGauge(store);
  }

  return {
    syncStore(storeId) {
      const existing = running.get(storeId);
      if (existing) return existing;
      // runSync não rejeita; o catch final só cobre uma falha dentro do próprio caminho de erro.
      const run = runSync(storeId)
        .catch(
          (): SyncResult => ({
            storeId,
            ok: false,
            variants: 0,
            removed: 0,
            durationMs: 0,
            detail: 'Erro interno ao sincronizar o catálogo.',
          }),
        )
        .finally(() => {
          running.delete(storeId);
          removedDuringSync.delete(storeId);
        });
      running.set(storeId, run);
      return run;
    },

    async refreshProduct(storeId, productId) {
      // Espera a sincronização completa da loja terminar (veja `refreshing`). Sem nenhuma
      // em curso, o registro abaixo é síncrono: uma completa pedida logo depois espera esta.
      for (let full = running.get(storeId); full !== undefined; full = running.get(storeId)) await full;
      try {
        await trackRefresh(storeId, () => refresh(storeId, productId));
      } catch (err) {
        if (err instanceof ObjectCapError) {
          throw new BridgeError('upstream_rejected', 'Produto com mais variantes do que a paginação alcança', { productId });
        }
        throw toBridgeError(err);
      }
    },

    removeProduct,

    fetchShopInfo,
  };
}
