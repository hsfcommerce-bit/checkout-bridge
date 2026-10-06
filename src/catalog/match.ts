import { systemClock } from '../lib/clock.ts';
import type {
  CatalogVariant,
  Clock,
  Logger,
  MappingStatus,
  MatchMethod,
  MatchService,
  MatchSummary,
  Metrics,
  Repos,
  VariantMapping,
} from '../types.ts';
import { computePreparedDivergences, isSellableStatus, missingCheckoutDivergence, prepareVariant } from './parity.ts';
import type { PreparedVariant } from './parity.ts';

/**
 * Casamento automático entre as variantes de uma vitrine e as de uma loja checkout.
 *
 * O casamento só decide QUAL variante do checkout corresponde a cada variante da vitrine,
 * dentro de um par de lojas que o lojista já ligou por uma rota. Ele não escolhe loja de
 * destino: isso é sempre a rota configurada no painel.
 *
 * Ordem das regras, da mais confiável para a menos confiável: SKU, código de barras,
 * handle + opções, título + opções. As três primeiras ativam o mapeamento; a última só
 * sugere e fica fora do checkout até alguém aprovar no painel.
 *
 * Uma regra só passa a vez para a seguinte quando NÃO encontra candidato. Quando encontra
 * vários e não consegue decidir, o resultado é conflito e as regras seguintes não são
 * consultadas, de propósito: um código repetido no checkout é um problema de catálogo que o
 * lojista precisa ver e resolver no painel (ARQUITETURA.md, "SKU repetido vira conflito a
 * resolver à mão"); decidir por uma regra mais fraca esconderia o problema e poderia vender
 * o produto errado em silêncio.
 */

/** Limite de candidatos guardados em uma linha em conflito (o painel não precisa de mais). */
export const MAX_CONFLICT_CANDIDATES = 20;

/** Separador das chaves compostas; não ocorre em handle nem nas chaves normalizadas. */
const KEY_SEPARATOR = '\u0002';

type VariantIndex = Map<string, PreparedVariant[]>;

/**
 * Ordem dos IDs: numérica para as strings numéricas da Shopify (a mais curta é a menor),
 * sem passar por Number, e ainda total e determinística para qualquer outro texto.
 */
export function compareVariantIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function addToIndex(index: VariantIndex, key: string, item: PreparedVariant): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [item]);
  else bucket.push(item);
}

/** SKU e código de barras: comparação exata (a Shopify diferencia maiúsculas), só sem as pontas. */
function codeKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function handleKey(prepared: PreparedVariant): string {
  const handle = typeof prepared.variant.productHandle === 'string' ? prepared.variant.productHandle.trim() : '';
  return handle === '' ? '' : `${handle}${KEY_SEPARATOR}${prepared.optionsKey}`;
}

function titleKey(prepared: PreparedVariant): string {
  return prepared.titleKey === '' ? '' : `${prepared.titleKey}${KEY_SEPARATOR}${prepared.optionsKey}`;
}

type Resolution = { kind: 'match'; target: PreparedVariant } | { kind: 'conflict'; candidates: PreparedVariant[] };

/**
 * Regra de SKU e de código de barras. Um candidato só: casa, mesmo com opções diferentes
 * (a diferença aparece como divergência 'options'). Vários: as opções desempatam; se não
 * sobrar exatamente um, é conflito e a decisão passa para o painel.
 */
function resolveByCode(candidates: PreparedVariant[] | undefined, vitrine: PreparedVariant): Resolution | null {
  if (candidates === undefined || candidates.length === 0) return null;
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return { kind: 'match', target: only };
  const narrowed = candidates.filter((candidate) => candidate.optionsKey === vitrine.optionsKey);
  const single = narrowed[0];
  if (narrowed.length === 1 && single !== undefined) return { kind: 'match', target: single };
  // Com vários candidatos de opções iguais, só eles interessam; sem nenhum, todos entram.
  return { kind: 'conflict', candidates: narrowed.length > 1 ? narrowed : candidates };
}

/**
 * Regras de handle e de título: a chave já inclui as opções, então o normal é haver um
 * candidato só. Mais de um (dois produtos de mesmo título, por exemplo) é conflito: escolher
 * um deles em silêncio poderia vender o produto errado.
 */
function resolveByKey(candidates: PreparedVariant[] | undefined): Resolution | null {
  if (candidates === undefined || candidates.length === 0) return null;
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return { kind: 'match', target: only };
  return { kind: 'conflict', candidates };
}

/**
 * Casamento puro e determinístico de dois catálogos.
 *
 * - Só variantes da vitrine com produto ACTIVE ou UNLISTED recebem linha.
 * - Variantes do checkout entram como candidatas em qualquer status: casar com um produto
 *   em rascunho e marcar a divergência 'product_status' informa mais do que "sem mapeamento".
 * - Várias variantes da vitrine podem apontar para a mesma variante do checkout.
 * - Em conflito, checkoutVariantId é null, method guarda a regra que achou os candidatos e
 *   candidates traz no máximo MAX_CONFLICT_CANDIDATES ids em ordem.
 *
 * Custo linear: os índices são Maps e cada variante é normalizada uma única vez.
 */
export function matchCatalogs(input: {
  vitrineStoreId: string;
  checkoutStoreId: string;
  vitrine: CatalogVariant[];
  checkout: CatalogVariant[];
  priceToleranceBps: number;
  now: string;
}): VariantMapping[] {
  const { vitrineStoreId, checkoutStoreId, now } = input;
  const tolerance = { priceToleranceBps: input.priceToleranceBps };

  const bySku: VariantIndex = new Map();
  const byBarcode: VariantIndex = new Map();
  const byHandle: VariantIndex = new Map();
  const byTitle: VariantIndex = new Map();
  const seenCheckout = new Set<string>();
  for (const variant of input.checkout) {
    // Entrada repetida não pode virar "dois candidatos" e fabricar um conflito.
    if (seenCheckout.has(variant.variantId)) continue;
    seenCheckout.add(variant.variantId);
    const prepared = prepareVariant(variant);
    const sku = codeKey(variant.sku);
    if (sku !== '') addToIndex(bySku, sku, prepared);
    const barcode = codeKey(variant.barcode);
    if (barcode !== '') addToIndex(byBarcode, barcode, prepared);
    const handle = handleKey(prepared);
    if (handle !== '') addToIndex(byHandle, handle, prepared);
    const title = titleKey(prepared);
    if (title !== '') addToIndex(byTitle, title, prepared);
  }

  const out: VariantMapping[] = [];
  const seenVitrine = new Set<string>();

  function emit(
    vitrine: PreparedVariant,
    resolution: Resolution | null,
    method: MatchMethod,
    matchedStatus: MappingStatus,
  ): boolean {
    if (resolution === null) return false;
    const base = { vitrineStoreId, checkoutStoreId, vitrineVariantId: vitrine.variant.variantId, method, locked: false, updatedAt: now };
    if (resolution.kind === 'match') {
      out.push({
        ...base,
        checkoutVariantId: resolution.target.variant.variantId,
        status: matchedStatus,
        candidates: [],
        divergences: computePreparedDivergences(vitrine, resolution.target, tolerance),
      });
    } else {
      const ids = resolution.candidates.map((candidate) => candidate.variant.variantId).sort(compareVariantIds);
      out.push({
        ...base,
        checkoutVariantId: null,
        status: 'conflict',
        candidates: ids.slice(0, MAX_CONFLICT_CANDIDATES),
        divergences: [],
      });
    }
    return true;
  }

  for (const variant of input.vitrine) {
    if (!isSellableStatus(variant.productStatus)) continue;
    if (seenVitrine.has(variant.variantId)) continue;
    seenVitrine.add(variant.variantId);
    const prepared = prepareVariant(variant);

    const sku = codeKey(variant.sku);
    if (sku !== '' && emit(prepared, resolveByCode(bySku.get(sku), prepared), 'sku', 'active')) continue;
    const barcode = codeKey(variant.barcode);
    if (barcode !== '' && emit(prepared, resolveByCode(byBarcode.get(barcode), prepared), 'barcode', 'active')) continue;
    const handle = handleKey(prepared);
    if (handle !== '' && emit(prepared, resolveByKey(byHandle.get(handle)), 'handle_options', 'active')) continue;
    const title = titleKey(prepared);
    if (title !== '' && emit(prepared, resolveByKey(byTitle.get(title)), 'title_options', 'suggested')) continue;

    out.push({
      vitrineStoreId,
      checkoutStoreId,
      vitrineVariantId: variant.variantId,
      checkoutVariantId: null,
      status: 'unmapped',
      method: null,
      candidates: [],
      divergences: [],
      locked: false,
      updatedAt: now,
    });
  }

  return out.sort((a, b) => compareVariantIds(a.vitrineVariantId, b.vitrineVariantId));
}

// ---------------------------------------------------------------------------
// Serviço: recalcula e grava o mapeamento de um par de lojas
// ---------------------------------------------------------------------------

const GAUGE_STATUSES = ['active', 'suggested', 'conflict', 'unmapped', 'disabled'] as const;

export function createMatchService(deps: {
  repos: Repos;
  logger: Logger;
  metrics: Metrics;
  clock?: Clock;
}): MatchService {
  const { repos, logger, metrics } = deps;
  const clock = deps.clock ?? systemClock;

  /**
   * A menor tolerância entre as rotas do par (ativas ou não). As divergências ficam
   * gravadas por par, não por rota; a mais restritiva garante que nenhuma rota do par veja
   * como "igual" um preço que ela própria não toleraria. Sem rota, 0 (preço idêntico).
   */
  function pairTolerance(vitrineStoreId: string, checkoutStoreId: string): number {
    let smallest: number | null = null;
    for (const link of repos.links.list({ vitrineStoreId, checkoutStoreId })) {
      const bps = Number.isFinite(link.priceToleranceBps) && link.priceToleranceBps > 0 ? link.priceToleranceBps : 0;
      smallest = smallest === null ? bps : Math.min(smallest, bps);
    }
    return smallest ?? 0;
  }

  function rematchPair(vitrineStoreId: string, checkoutStoreId: string): MatchSummary {
    const started = clock.now();
    const now = started.toISOString();
    const priceToleranceBps = pairTolerance(vitrineStoreId, checkoutStoreId);
    const vitrine = repos.catalog.listAll(vitrineStoreId);
    const checkout = repos.catalog.listAll(checkoutStoreId);
    const proposals = matchCatalogs({ vitrineStoreId, checkoutStoreId, vitrine, checkout, priceToleranceBps, now });

    // Decisões manuais (locked) valem mais que a proposta automática. O repositório já
    // preserva destino e status dessas linhas; o que muda aqui é que as divergências são
    // calculadas contra o destino QUE ELAS TÊM, e não contra o que o casamento proporia.
    const lockedRows = repos.mappings.listAll(vitrineStoreId, checkoutStoreId).filter((row) => row.locked);
    let rows = proposals;
    if (lockedRows.length > 0) {
      const vitrineById = new Map<string, CatalogVariant>();
      for (const variant of vitrine) vitrineById.set(variant.variantId, variant);
      const checkoutById = new Map<string, CatalogVariant>();
      for (const variant of checkout) checkoutById.set(variant.variantId, variant);

      const lockedById = new Map<string, VariantMapping>();
      for (const row of lockedRows) {
        const source = vitrineById.get(row.vitrineVariantId);
        // Variante que saiu do catálogo da vitrine: a linha é removida logo abaixo.
        if (source === undefined) continue;
        let divergences: VariantMapping['divergences'] = [];
        if (row.checkoutVariantId !== null) {
          const target = checkoutById.get(row.checkoutVariantId);
          divergences =
            target === undefined
              ? [missingCheckoutDivergence(source)]
              : computePreparedDivergences(prepareVariant(source), prepareVariant(target), { priceToleranceBps });
        }
        lockedById.set(row.vitrineVariantId, { ...row, divergences, updatedAt: now });
      }

      rows = [];
      for (const proposal of proposals) {
        const locked = lockedById.get(proposal.vitrineVariantId);
        rows.push(locked ?? proposal);
        if (locked !== undefined) lockedById.delete(proposal.vitrineVariantId);
      }
      // Sobraram as travadas de produtos que hoje não são vendáveis na vitrine (rascunho,
      // arquivado). A variante ainda existe, então a decisão manual é mantida: apagar o
      // trabalho do lojista porque o produto saiu do ar por um tempo seria pior.
      for (const locked of lockedById.values()) rows.push(locked);
    }

    repos.mappings.upsertAuto(rows);

    // Proteção das decisões manuais: catálogo da vitrine vazio sem uma sincronização
    // concluída que o confirme (loja recém-ligada, catálogo limpo para nova carga) não é
    // prova de que as variantes sumiram. Nesse caso nada é removido; a próxima execução,
    // depois de uma sincronização completa, faz a limpeza.
    let removed = 0;
    const vitrineConfirmed = vitrine.length > 0 || repos.stores.get(vitrineStoreId)?.lastSyncOk === true;
    if (vitrineConfirmed) {
      removed = repos.mappings.deleteMissing(
        vitrineStoreId,
        checkoutStoreId,
        rows.map((row) => row.vitrineVariantId),
      );
    } else {
      logger.warn({ vitrineStoreId, checkoutStoreId }, 'catálogo da vitrine vazio e sem sincronização concluída; mapeamentos mantidos');
    }

    const counts = repos.mappings.counts(vitrineStoreId, checkoutStoreId);
    const durationMs = Math.max(0, clock.now().getTime() - started.getTime());
    metrics.inc('bridge_match_runs_total');
    metrics.observe('bridge_match_ms', durationMs);
    const pair = { vitrine: vitrineStoreId, checkout: checkoutStoreId };
    for (const status of GAUGE_STATUSES) metrics.gauge('bridge_mappings', counts[status], { ...pair, status });
    metrics.gauge('bridge_mappings_divergent', counts.divergent, pair);
    logger.info(
      {
        vitrineStoreId,
        checkoutStoreId,
        priceToleranceBps,
        vitrineVariants: vitrine.length,
        checkoutVariants: checkout.length,
        locked: lockedRows.length,
        removed,
        counts,
        durationMs,
      },
      'mapeamento recalculado',
    );
    return { vitrineStoreId, checkoutStoreId, counts };
  }

  function rematchStore(storeId: string): MatchSummary[] {
    // A loja tem um papel só, mas consultar os dois lados dispensa ler o papel e cobre
    // qualquer rota em que ela apareça. Rotas desativadas contam: o painel mostra o
    // mapeamento delas e reativar uma rota não deve depender de um recálculo manual.
    const links = [...repos.links.list({ vitrineStoreId: storeId }), ...repos.links.list({ checkoutStoreId: storeId })];
    const pairs = new Map<string, { vitrineStoreId: string; checkoutStoreId: string }>();
    for (const link of links) {
      const key = `${link.vitrineStoreId}${KEY_SEPARATOR}${link.checkoutStoreId}`;
      if (!pairs.has(key)) pairs.set(key, { vitrineStoreId: link.vitrineStoreId, checkoutStoreId: link.checkoutStoreId });
    }
    const summaries: MatchSummary[] = [];
    for (const pair of pairs.values()) summaries.push(rematchPair(pair.vitrineStoreId, pair.checkoutStoreId));
    return summaries;
  }

  return { rematchPair, rematchStore };
}
