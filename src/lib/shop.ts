import { domainToASCII } from 'node:url';

/**
 * Validação e normalização de identificadores da Shopify (domínios, IDs, GIDs, países).
 *
 * Estas funções ficam na fronteira com dados não confiáveis (parâmetros de requisição,
 * formulários do painel). A regra geral é: na dúvida, rejeitar. Nenhuma delas tenta
 * "consertar" uma entrada ambígua.
 */

/** Rótulo DNS tem no máximo 63 caracteres; o rótulo da loja não pode conter ponto. */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/** Hostname da RFC 1123: rótulos de 1 a 63 caracteres [a-z0-9-], sem hífen nas pontas. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Último rótulo numérico (decimal ou 0x...): o padrão de URL trata o host como endereço
 * IPv4, não como nome de domínio.
 */
const NUMERIC_LAST_LABEL_RE = /(?:^|\.)(?:[0-9]+|0x[0-9a-f]*)$/;

const ASCII_PRINTABLE_RE = /^[\x21-\x7e]+$/;
const NUMERIC_ID_RE = /^[1-9][0-9]{0,19}$/;
const GID_RE = /^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/([1-9][0-9]{0,19})$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

/** Limite de tamanho da entrada bruta; acima disso nem tentamos interpretar. */
const MAX_INPUT_LENGTH = 2048;

/** Remove "http(s)://" do início e tudo a partir do primeiro "/", "?" ou "#". */
function stripProtocolAndPath(value: string): string {
  const withoutProtocol = value.replace(/^https?:\/\//, '');
  const cut = withoutProtocol.search(/[/?#]/);
  return cut === -1 ? withoutProtocol : withoutProtocol.slice(0, cut);
}

/** Checagem estrita, sem normalização: exatamente <rótulo>.myshopify.com em minúsculas. */
export function isValidShopDomain(input: string): boolean {
  return typeof input === 'string' && SHOP_DOMAIN_RE.test(input);
}

/**
 * Aceita o que um lojista costuma colar ("https://Loja.myshopify.com/admin") e devolve o
 * domínio canônico, ou null.
 *
 * O host é extraído ANTES da validação e precisa ser exatamente <rótulo>.myshopify.com:
 * userinfo ("user@"), porta, subdomínio extra e sufixo ("...myshopify.com.evil.com") são
 * rejeitados, e "evil.com/x.myshopify.com" vira "evil.com", que também é rejeitado.
 */
export function normalizeShopDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;
  // Só ASCII visível. Feito antes do toLowerCase porque alguns caracteres Unicode viram
  // letras ASCII ao mudar de caixa (ex.: o sinal Kelvin U+212A vira "k").
  if (!ASCII_PRINTABLE_RE.test(trimmed)) return null;
  const host = stripProtocolAndPath(trimmed.toLowerCase());
  return SHOP_DOMAIN_RE.test(host) ? host : null;
}

/**
 * Host de domínio público: devolve só o hostname em minúsculas, ou null quando não é um
 * hostname válido. Protocolo http(s), porta, caminho e ponto final são removidos da
 * entrada; userinfo ("user@") invalida.
 *
 * Endereços IP (v4 ou v6) não são hostnames e dão null. Nomes internacionalizados são
 * convertidos para punycode, que é a forma que o navegador envia em Host e Origin.
 */
export function normalizeHost(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;
  let host = stripProtocolAndPath(trimmed.toLowerCase());
  host = host.replace(/:[0-9]{1,5}$/, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  // Qualquer caractere ASCII fora de [a-z0-9.-] invalida ("@", ":", "%", espaço, "\", "_").
  // Os não ASCII seguem para a conversão IDNA logo abaixo.
  if (/[\x00-\x7f]/.test(host.replace(/[a-z0-9.-]/g, ''))) return null;
  if (/[^\x00-\x7f]/.test(host)) {
    host = domainToASCII(host);
  }
  if (!HOSTNAME_RE.test(host) || NUMERIC_LAST_LABEL_RE.test(host)) return null;
  return host;
}

/** ID numérico da Shopify: 1 a 20 dígitos, sem zero à esquerda. */
export function isValidVariantId(input: string): boolean {
  return typeof input === 'string' && NUMERIC_ID_RE.test(input);
}

/**
 * Monta gid://shopify/<type>/<id>. Lança se o id não for numérico: um GID montado com
 * lixo só seria recusado depois, pela Shopify, com um erro bem menos claro.
 */
export function toGid(type: 'ProductVariant' | 'Product', id: string): string {
  if (!isValidVariantId(id)) throw new Error('ID numérico da Shopify inválido');
  return `gid://shopify/${type}/${id}`;
}

/** Devolve a parte numérica final de um GID. Lança em formato inesperado. */
export function fromGid(gid: string): string {
  const match = typeof gid === 'string' ? GID_RE.exec(gid) : null;
  const id = match?.[1];
  if (id === undefined) throw new Error('GID da Shopify inválido');
  return id;
}

/** ISO 3166-1 alpha-2 em maiúsculas. Não consulta a lista oficial de países. */
export function isCountryCode(input: string): boolean {
  return typeof input === 'string' && COUNTRY_RE.test(input);
}

export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  // Valida antes de converter a caixa: "ß".toUpperCase() é "SS" e passaria na checagem.
  if (!/^[A-Za-z]{2}$/.test(trimmed)) return null;
  return trimmed.toUpperCase();
}
