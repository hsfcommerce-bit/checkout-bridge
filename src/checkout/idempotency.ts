import { sha256Hex } from '../lib/crypto.ts';
import type { RequestLine } from '../types.ts';

/**
 * Chave de idempotência do checkout: o mesmo carrinho, da mesma vitrine, pela mesma rota,
 * gera a mesma chave e reaproveita o checkout já criado (clique duplo, nova tentativa do
 * script do tema).
 *
 * A chave é o SHA-256 de um JSON canônico. Arrays em vez de objetos em todo lugar: a ordem
 * dos elementos é fixa e não depende da ordem de inserção de chaves.
 */

type CanonicalLine = [variantId: string, quantity: number, properties: Array<[string, string]>];

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function canonicalLine(line: RequestLine): CanonicalLine {
  const properties = Object.entries(line.properties ?? {})
    .map(([key, value]): [string, string] => [key, String(value)])
    .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return [line.variantId, line.quantity, properties];
}

export function computeIdempotencyKey(input: {
  vitrineStoreId: string;
  linkId: string;
  cartToken: string | null;
  lines: RequestLine[];
  country: string | null;
  discountCodes: string[];
  source: 'cart' | 'buy_now';
  /**
   * Escopo usado no lugar do token quando o carrinho da vitrine não tem token: nonce do
   * navegador ou IP + navegador, sempre com uma janela de tempo (ver openSession no serviço).
   */
  fallbackScope: string;
}): string {
  const lines = input.lines
    .map(canonicalLine)
    // A ordem das linhas no carrinho não muda o checkout; a serialização das propriedades
    // desempata linhas da mesma variante com a mesma quantidade.
    .map((line): [CanonicalLine, string] => [line, JSON.stringify(line[2])])
    .sort(
      (a, b) => compareStrings(a[0][0], b[0][0]) || a[0][1] - b[0][1] || compareStrings(a[1], b[1]),
    )
    .map(([line]) => line);

  const hasToken = typeof input.cartToken === 'string' && input.cartToken !== '';
  const canonical = [
    'v1',
    input.vitrineStoreId,
    input.linkId,
    input.source,
    // O marcador separa os dois espaços de nomes: um token de carrinho nunca colide com um
    // escopo de reserva que tenha o mesmo texto.
    hasToken ? ['token', input.cartToken] : ['scope', input.fallbackScope],
    input.country,
    [...input.discountCodes].sort(compareStrings),
    lines,
  ];
  return sha256Hex(JSON.stringify(canonical));
}
