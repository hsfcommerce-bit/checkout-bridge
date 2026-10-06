import { withinTolerance } from '../lib/money.ts';
import type { CatalogVariant, Divergence, ProductStatus, VariantOption } from '../types.ts';

/**
 * Paridade entre uma variante da vitrine e a variante correspondente na loja checkout.
 *
 * A plataforma não garante preço igual em duas lojas (docs/research/4, PT-09 a PT-20:
 * câmbio ao vivo, taxa de conversão embutida, arredondamento, ajustes por mercado). O que
 * este módulo compara é o preço de catálogo na moeda da loja (ProductVariant.price), que é
 * o dado que a sincronização guarda. Preço por mercado (contextualPricing) não entra aqui;
 * quem confere o valor realmente cobrado é o checkout, linha a linha, no carrinho criado.
 *
 * As funções são puras e nunca lançam: um valor monetário ilegível vira divergência, que é
 * o lado seguro (bloqueia em vez de deixar passar).
 */

/** Texto usado no lugar de um valor que não existe em um dos lados. */
export const ABSENT_VALUE = 'ausente';

const AVAILABLE = 'disponível';
const UNAVAILABLE = 'indisponível';

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Separadores que não aparecem em texto digitado: evitam colisão entre nome e valor. */
const PAIR_SEPARATOR = '\u0001';
const NAME_VALUE_SEPARATOR = '\u0000';

/**
 * Forma de comparação de textos: Unicode NFKC, minúsculas, sem espaços nas pontas e com
 * sequências de espaço reduzidas a um só.
 *
 * O NFKC roda de novo depois das minúsculas porque a troca de caixa pode desfazer a
 * composição ("İ" vira "i" + ponto combinante). Texto só ASCII pula a normalização: é o
 * caso comum e o que mantém o casamento de catálogos grandes rápido.
 */
export function normalizeText(value: string): string {
  const text = typeof value === 'string' ? value : '';
  const folded = ASCII_ONLY.test(text) ? text.toLowerCase() : text.normalize('NFKC').toLowerCase().normalize('NFKC');
  return folded.replace(/\s+/g, ' ').trim();
}

/**
 * Chave de comparação das opções: pares nome=valor normalizados e ordenados, de modo que
 * a ordem das opções no produto não importe.
 *
 * Produto sem opções aparece na Shopify com a opção única "Title = Default Title". Ela e a
 * lista vazia viram a mesma chave (''), para que um produto simples case com outro produto
 * simples mesmo que um dos lados tenha chegado sem opções.
 */
export function normalizedOptionsKey(options: VariantOption[]): string {
  const list = Array.isArray(options) ? options : [];
  if (list.length === 0) return '';
  const pairs: string[] = [];
  for (const option of list) {
    pairs.push(`${normalizeText(option.name)}${NAME_VALUE_SEPARATOR}${normalizeText(option.value)}`);
  }
  if (pairs.length === 1 && pairs[0] === `title${NAME_VALUE_SEPARATOR}default title`) return '';
  return pairs.sort().join(PAIR_SEPARATOR);
}

/** Opções em texto legível para o painel, na ordem em que a loja as devolve. */
function describeOptions(options: VariantOption[]): string {
  const list = Array.isArray(options) ? options : [];
  return list.map((option) => `${option.name}=${option.value}`).join(', ');
}

export function isSellableStatus(status: ProductStatus): boolean {
  // UNLISTED é produto ativo acessível só por link direto (docs/research/3, AC-15):
  // tratá-lo como "não ativo" derrubaria itens vendáveis.
  return status === 'ACTIVE' || status === 'UNLISTED';
}

/** Variante com as chaves de comparação já calculadas (o casamento reaproveita as do índice). */
export interface PreparedVariant {
  variant: CatalogVariant;
  titleKey: string;
  optionsKey: string;
}

export function prepareVariant(variant: CatalogVariant): PreparedVariant {
  return {
    variant,
    titleKey: normalizeText(variant.productTitle),
    optionsKey: normalizedOptionsKey(variant.options),
  };
}

function normalizeCurrency(currency: string): string {
  return typeof currency === 'string' ? currency.trim().toUpperCase() : '';
}

/** withinTolerance que não lança: valor ilegível conta como fora da tolerância. */
function pricesWithin(base: string, other: string, toleranceBps: number): boolean {
  try {
    return withinTolerance(base, other, toleranceBps);
  } catch {
    return false;
  }
}

/**
 * Mesma comparação de computeDivergences, para quem já tem as chaves normalizadas.
 * A ordem do resultado é fixa: currency, price, compare_at_price, title, options,
 * availability, product_status.
 */
export function computePreparedDivergences(
  vitrine: PreparedVariant,
  checkout: PreparedVariant,
  opts: { priceToleranceBps: number },
): Divergence[] {
  const v = vitrine.variant;
  const c = checkout.variant;
  const out: Divergence[] = [];

  // Com moedas diferentes os números não são comparáveis: a divergência de moeda já
  // bloqueia e uma divergência de preço ao lado dela só confundiria quem lê o painel.
  const sameCurrency = normalizeCurrency(v.currency) === normalizeCurrency(c.currency);
  if (!sameCurrency) {
    out.push({ kind: 'currency', vitrine: v.currency, checkout: c.currency });
  } else if (!pricesWithin(v.price, c.price, opts.priceToleranceBps)) {
    out.push({ kind: 'price', vitrine: v.price, checkout: c.price });
  }

  // "De/por": existir de um lado só já é divergência (a vitrine mostraria uma promoção que
  // o checkout não mostra, ou o contrário). O valor só é comparado na mesma moeda.
  const vCompare = v.compareAtPrice ?? null;
  const cCompare = c.compareAtPrice ?? null;
  if (vCompare === null || cCompare === null) {
    if (vCompare !== cCompare) {
      out.push({ kind: 'compare_at_price', vitrine: vCompare ?? ABSENT_VALUE, checkout: cCompare ?? ABSENT_VALUE });
    }
  } else if (sameCurrency && !pricesWithin(vCompare, cCompare, opts.priceToleranceBps)) {
    out.push({ kind: 'compare_at_price', vitrine: vCompare, checkout: cCompare });
  }

  if (vitrine.titleKey !== checkout.titleKey) {
    out.push({ kind: 'title', vitrine: v.productTitle, checkout: c.productTitle });
  }
  if (vitrine.optionsKey !== checkout.optionsKey) {
    out.push({ kind: 'options', vitrine: describeOptions(v.options), checkout: describeOptions(c.options) });
  }
  // Só o sentido que atrapalha a venda: vitrine oferece e o checkout não entrega.
  if (v.availableForSale === true && c.availableForSale !== true) {
    out.push({ kind: 'availability', vitrine: AVAILABLE, checkout: UNAVAILABLE });
  }
  if (!isSellableStatus(c.productStatus)) {
    out.push({ kind: 'product_status', vitrine: v.productStatus, checkout: c.productStatus });
  }
  return out;
}

/**
 * Divergências entre a variante da vitrine e a do checkout, em ordem estável.
 * O preço da vitrine é a base da tolerância (priceToleranceBps em pontos-base).
 */
export function computeDivergences(
  vitrine: CatalogVariant,
  checkout: CatalogVariant,
  opts: { priceToleranceBps: number },
): Divergence[] {
  return computePreparedDivergences(prepareVariant(vitrine), prepareVariant(checkout), opts);
}

/** Divergência de uma linha cujo destino não existe mais no catálogo da loja checkout. */
export function missingCheckoutDivergence(vitrine: CatalogVariant): Divergence {
  return { kind: 'product_status', vitrine: vitrine.productStatus, checkout: ABSENT_VALUE };
}

/** Preço ou moeda divergente impede o checkout quando a política da rota é 'block'. */
export function hasBlockingDivergence(divergences: Divergence[]): boolean {
  if (!Array.isArray(divergences)) return false;
  return divergences.some((d) => d.kind === 'price' || d.kind === 'currency');
}
