import { hmacSha256Hex, timingSafeEqualStr } from '../lib/crypto.ts';
import { isValidShopDomain, normalizeShopDomain } from '../lib/shop.ts';

/**
 * Verificação da assinatura do App Proxy da Shopify.
 *
 * A Shopify acrescenta shop, logged_in_customer_id, path_prefix, timestamp e signature à
 * query string de toda requisição que passa pelo proxy (inclusive POST). A assinatura cobre
 * SOMENTE a query string: o corpo não é assinado e continua sendo dado não confiável.
 *
 * Regras que não podem ser "simplificadas":
 * - Trabalhar sobre a query string CRUA. Frameworks que descartam valores vazios
 *   ("logged_in_customer_id=") ou recodificam a query quebram a conta.
 * - Assinar TODOS os parâmetros recebidos menos `signature`, nunca uma lista fixa: a
 *   Shopify pode acrescentar parâmetros novos, e os do próprio cliente também entram.
 * - A ordenação é a do exemplo oficial em Ruby (strings "chave=valor" inteiras), não a da
 *   biblioteca JS (só pela chave). As duas coincidem para os parâmetros da Shopify; por
 *   isso o script do tema não manda parâmetros próprios na query.
 */

export type ProxySignatureFailure =
  | 'missing_param'
  | 'duplicate_param'
  | 'invalid_shop'
  | 'bad_signature'
  | 'stale'
  | 'malformed';

export type ProxySignatureResult =
  | { ok: true; shop: string; pathPrefix: string; loggedInCustomerId: string | null; timestamp: number }
  | { ok: false; reason: ProxySignatureFailure };

/**
 * Acima disso nem tentamos interpretar. Os parâmetros da Shopify somam umas 200 letras e o
 * script do tema não acrescenta nenhum.
 */
const MAX_QUERY_LENGTH = 8192;

/** Obrigatórios e de valor único. */
const REQUIRED_PARAMS = ['signature', 'shop', 'timestamp'] as const;

/**
 * Parâmetros que não podem aparecer repetidos. Os três primeiros seguem a biblioteca
 * oficial (APP_PROXY_SINGLE_VALUE_PARAMS): um segundo "shop" acrescentado pelo cliente
 * viraria "a,b" na conta e confundiria a escolha da loja. path_prefix e
 * logged_in_customer_id entram pelo mesmo motivo: o resultado devolve UM valor de cada, e
 * com repetição não existe um valor honesto para devolver (o cliente poderia injetar um
 * path_prefix que acabaria dentro do script servido em /bridge.js).
 */
const SINGLE_VALUE_PARAMS = ['signature', 'shop', 'timestamp', 'path_prefix', 'logged_in_customer_id'] as const;

const TIMESTAMP_RE = /^[0-9]{1,15}$/;

/** "+" vira espaço e depois sai a codificação por porcentagem, como o Rack faz. */
function decodeComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // "%" solto, "%zz" ou sequência UTF-8 inválida.
    return null;
  }
}

/**
 * Interpreta a query string crua (sem o "?" inicial) preservando a ordem de chegada, os
 * valores vazios e as repetições. Devolve null em codificação malformada.
 */
function parseRawQuery(rawQuery: string): Map<string, string[]> | null {
  if (typeof rawQuery !== 'string' || rawQuery.length > MAX_QUERY_LENGTH) return null;
  // Map, e não objeto: chaves como "__proto__" vêm do cliente.
  const params = new Map<string, string[]>();
  for (const pair of rawQuery.split('&')) {
    // "a=1&&b=2" e "&" no fim: o Rack ignora o trecho vazio.
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decodeComponent(eq === -1 ? pair : pair.slice(0, eq));
    // Chave sem "=" conta como valor vazio ("chave=" na conta), igual ao exemplo em Ruby.
    const value = eq === -1 ? '' : decodeComponent(pair.slice(eq + 1));
    if (key === null || value === null) return null;
    const values = params.get(key);
    if (values) values.push(value);
    else params.set(key, [value]);
  }
  return params;
}

/**
 * Texto assinado: "chave=v1,v2" para cada chave menos `signature`, ordenado e concatenado
 * sem separador. O sort() sem comparador ordena por unidade de código UTF-16, que coincide
 * com a ordem de bytes do Ruby para tudo o que a Shopify envia (ASCII); nunca usar
 * localeCompare aqui.
 */
function signedPayload(params: Map<string, string[]>): string {
  const parts: string[] = [];
  for (const [key, values] of params) {
    if (key === 'signature') continue;
    parts.push(`${key}=${values.join(',')}`);
  }
  parts.sort();
  return parts.join('');
}

function single(params: Map<string, string[]>, key: string): string | null {
  const values = params.get(key);
  if (!values || values.length !== 1) return null;
  return values[0] ?? null;
}

/**
 * Parâmetro `shop` SEM verificação nenhuma, normalizado. Serve só para localizar a loja e
 * o segredo dela; quem decide a loja é o `shop` devolvido por verifyAppProxySignature.
 * null quando ausente, repetido, inválido ou quando a query é malformada.
 */
export function peekProxyShop(rawQuery: string): string | null {
  const params = parseRawQuery(rawQuery);
  if (!params) return null;
  const shop = single(params, 'shop');
  return shop === null ? null : normalizeShopDomain(shop);
}

/**
 * Digest hexadecimal (minúsculo) sobre todos os parâmetros menos `signature`.
 * null quando a query é malformada.
 */
export function computeProxySignature(rawQuery: string, secret: string): string | null {
  const params = parseRawQuery(rawQuery);
  if (!params) return null;
  return hmacSha256Hex(secret, signedPayload(params));
}

export function verifyAppProxySignature(
  rawQuery: string,
  secret: string,
  opts: { maxAgeSeconds: number; now: Date },
): ProxySignatureResult {
  const params = parseRawQuery(rawQuery);
  if (!params) return { ok: false, reason: 'malformed' };

  for (const name of REQUIRED_PARAMS) {
    if (!params.has(name)) return { ok: false, reason: 'missing_param' };
  }
  for (const name of SINGLE_VALUE_PARAMS) {
    if ((params.get(name)?.length ?? 0) > 1) return { ok: false, reason: 'duplicate_param' };
  }

  // Segredo vazio nunca valida nada: HMAC com chave vazia é calculável por qualquer um.
  if (typeof secret !== 'string' || secret === '') return { ok: false, reason: 'bad_signature' };
  const provided = single(params, 'signature') ?? '';
  const expected = hmacSha256Hex(secret, signedPayload(params));
  if (!timingSafeEqualStr(expected, provided)) return { ok: false, reason: 'bad_signature' };

  // A partir daqui os valores vieram da Shopify; as checagens abaixo são defesa adicional.
  const shop = single(params, 'shop') ?? '';
  if (!isValidShopDomain(shop)) return { ok: false, reason: 'invalid_shop' };

  // A documentação não define janela de validade; a biblioteca oficial usa 90 segundos de
  // tolerância, nos dois sentidos. O valor vem da configuração.
  const rawTimestamp = single(params, 'timestamp') ?? '';
  if (!TIMESTAMP_RE.test(rawTimestamp)) return { ok: false, reason: 'stale' };
  const timestamp = Number(rawTimestamp);
  const maxAgeMs = opts.maxAgeSeconds * 1000;
  const driftMs = Math.abs(opts.now.getTime() - timestamp * 1000);
  // A comparação nessa forma também reprova NaN (configuração ou relógio inválidos).
  if (!(maxAgeMs >= 0 && driftMs <= maxAgeMs)) return { ok: false, reason: 'stale' };

  const customerId = single(params, 'logged_in_customer_id');
  return {
    ok: true,
    shop,
    // Caminho realmente usado na loja (o lojista pode trocá-lo por loja no admin).
    pathPrefix: single(params, 'path_prefix') ?? '',
    // A Shopify manda o parâmetro vazio quando o comprador não está logado.
    loggedInCustomerId: customerId === null || customerId === '' ? null : customerId,
    timestamp,
  };
}

/**
 * Apoio para testes: monta a query string completa, já com uma assinatura válida. A conta
 * é feita direto sobre `params`, sem passar pelo interpretador acima, para que os testes
 * confrontem duas implementações independentes.
 */
export function signAppProxyQuery(params: Record<string, string | string[]>, secret: string): string {
  const pairs: string[] = [];
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (key === 'signature') continue;
    const values = Array.isArray(raw) ? raw : [raw];
    // Lista vazia não gera nenhum par na query, então também não entra na conta.
    if (values.length === 0) continue;
    for (const value of values) pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    parts.push(`${key}=${values.join(',')}`);
  }
  parts.sort();
  pairs.push(`signature=${hmacSha256Hex(secret, parts.join(''))}`);
  return pairs.join('&');
}
