import { isValidVariantId, normalizeHost } from '../lib/shop.ts';
import { BridgeError } from '../types.ts';

/**
 * Permalink de carrinho: https://{host}/cart/{variante}:{quantidade},...
 *
 * É o caminho mais fraco para chegar ao checkout: a Shopify não devolve nada ao servidor,
 * então não há como conferir estoque, publicação nem preço no momento do clique. Também
 * não leva propriedades por linha, planos de assinatura nem contexto de país, e não passa
 * por loja protegida por senha.
 *
 * Dado pessoal nunca entra nesta URL. Os parâmetros checkout[email] e
 * checkout[shipping_address][...] existem na Shopify, mas a URL passa por redirecionamentos,
 * logs e cabeçalhos Referer; por isso a função nem oferece um jeito de informá-los.
 */

/**
 * A Shopify não documenta limite de pares variante:quantidade nem de tamanho da URL do
 * permalink. O teto abaixo é o de uma linha de requisição que proxies e servidores comuns
 * aceitam sem reclamar (8 KB). PRECISA DE TESTE EM LOJA REAL para conhecer o limite de fato.
 */
export const MAX_PERMALINK_LENGTH = 8000;

function invalid(message: string, reason: string): BridgeError {
  return new BridgeError('invalid_request', message, { reason });
}

export function buildCartPermalink(opts: {
  host: string;
  lines: Array<{ variantId: string; quantity: number }>;
  attributes?: Array<{ key: string; value: string }>;
  discountCodes?: string[];
}): string {
  // A entrada precisa JÁ ser um host puro: normalizeHost aceitaria "https://loja.com/x" e
  // devolveria só o host, o que esconderia um valor errado guardado no cadastro da loja.
  const host = typeof opts.host === 'string' ? normalizeHost(opts.host) : null;
  if (host === null || host !== opts.host.trim().toLowerCase().replace(/\.$/, '')) {
    throw invalid('Host da loja checkout inválido para o permalink', 'invalid_host');
  }

  if (!Array.isArray(opts.lines) || opts.lines.length === 0) {
    throw invalid('Permalink sem linhas', 'no_lines');
  }
  // Variante repetida vira um único par: a Shopify não documenta o que faz com pares
  // repetidos, então a soma é feita aqui. Map preserva a ordem da primeira ocorrência.
  const merged = new Map<string, number>();
  for (const line of opts.lines) {
    if (typeof line?.variantId !== 'string' || !isValidVariantId(line.variantId)) {
      throw invalid('ID de variante inválido no permalink', 'invalid_variant_id');
    }
    if (typeof line.quantity !== 'number' || !Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw invalid('Quantidade inválida no permalink', 'invalid_quantity');
    }
    const total = (merged.get(line.variantId) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(total)) throw invalid('Quantidade inválida no permalink', 'invalid_quantity');
    merged.set(line.variantId, total);
  }
  // IDs e quantidades são só dígitos; ":" e "," são os separadores documentados do caminho.
  const path = [...merged.entries()].map(([variantId, quantity]) => `${variantId}:${quantity}`).join(',');

  const query: string[] = [];

  const codes = opts.discountCodes ?? [];
  if (codes.length > 0) {
    for (const code of codes) {
      // Os cupons vão separados por vírgula; um cupom com vírgula viraria dois.
      if (typeof code !== 'string' || code === '' || code.includes(',')) {
        throw invalid('Cupom não pode ser representado no permalink', 'invalid_discount_code');
      }
    }
    // Cada cupom é codificado sozinho e a vírgula separadora fica literal, como no exemplo
    // da documentação (?discount=CODE1,CODE2).
    query.push(`discount=${codes.map((code) => encodeURIComponent(code)).join(',')}`);
  }

  const seenKeys = new Set<string>();
  for (const attribute of opts.attributes ?? []) {
    if (typeof attribute?.key !== 'string' || attribute.key === '' || typeof attribute.value !== 'string') {
      throw invalid('Atributo inválido no permalink', 'invalid_attribute');
    }
    // Chave repetida: fica a primeira. Duas ocorrências de attributes[k] teriam resultado
    // indefinido do lado da Shopify.
    if (seenKeys.has(attribute.key)) continue;
    seenKeys.add(attribute.key);
    // Colchetes literais em volta da chave (formato documentado: attributes[chave]=valor);
    // um "]" ou "&" dentro da chave ou do valor sai codificado e não quebra a estrutura.
    query.push(`attributes[${encodeURIComponent(attribute.key)}]=${encodeURIComponent(attribute.value)}`);
  }

  const url = `https://${host}/cart/${path}${query.length > 0 ? `?${query.join('&')}` : ''}`;
  if (url.length > MAX_PERMALINK_LENGTH) {
    throw invalid('Permalink longo demais', 'permalink_too_long');
  }
  return url;
}
