import { z } from 'zod';
import { truncate } from '../lib/http.ts';
import { isValidVariantId, normalizeCountryCode } from '../lib/shop.ts';
import type { CheckoutRequest, RequestLine, VisitorConsent } from '../types.ts';
import { PROPERTY_LIMITS } from './limits.ts';

/**
 * Validação do corpo enviado pelo script do tema da vitrine.
 *
 * Tudo aqui é dado não confiável: qualquer pessoa consegue montar essa requisição pelo
 * domínio da vitrine. Por isso o objeto de topo e as linhas são estritos (uma chave
 * desconhecida, como "price", invalida a requisição em vez de ser ignorada em silêncio) e
 * a mensagem de erro nunca repete o valor recebido.
 */

/**
 * Parâmetros de atribuição aceitos. fbp, fbc, ga e ttp são os valores dos cookies _fbp,
 * _fbc, _ga e _ttp lidos pelo tema; os demais chegam pela URL de entrada na vitrine.
 */
export const ATTRIBUTION_KEYS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'ttclid',
  'msclkid',
  'fbp',
  'fbc',
  'ga',
  'ttp',
];

export type ParsedCheckoutBody =
  | { ok: true; value: Omit<CheckoutRequest, 'shopDomain'> }
  | { ok: false; message: string };

const MAX_LINES = 250;
const MAX_QUANTITY = 1_000_000;
// Os limites de propriedade vêm de src/checkout/limits.ts, compartilhado com o script do
// tema: os dois lados precisam concordar, senão uma personalização longa invalida o
// corpo inteiro só no servidor.
const MAX_PROPERTIES = PROPERTY_LIMITS.maxProperties;
const MAX_PROPERTY_KEY = PROPERTY_LIMITS.maxKeyLength;
const MAX_PROPERTY_VALUE = PROPERTY_LIMITS.maxValueLength;
const MAX_DISCOUNT_CODES = 5;
const MAX_DISCOUNT_CODE_LENGTH = 64;
const MAX_ATTRIBUTION_VALUE = 500;

/** Controles C0/C1, DEL e os separadores de linha/parágrafo do Unicode. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const HAS_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Idioma no formato BCP 47 curto: "pt", "pt-BR", "zh-Hant-TW". */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
/** Nonce por navegador gerado pelo script do tema (UUID ou hexadecimal). */
const CLIENT_NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

const variantIdSchema = z
  .union([z.string(), z.number()])
  // Número acima de 2^53 já perdeu dígitos no JSON.parse; não dá para saber qual era o ID.
  .transform((value) => (typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : value))
  .refine((value) => isValidVariantId(value));

/**
 * Propriedades da linha (personalização). Chaves iniciadas por "__" são privadas na
 * Shopify e não seguem adiante; valores vazios são descartados, como o tema já faz com
 * campos opcionais deixados em branco. Os limites valem para o que sobra depois disso.
 */
const propertiesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .transform((raw) => {
    const out: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('__')) continue;
      if (value === null) continue;
      const text = String(value);
      if (text === '') continue;
      out.push([key, text]);
    }
    return out;
  })
  .refine(
    (entries) =>
      entries.length <= MAX_PROPERTIES &&
      entries.every(
        ([key, value]) => key.length >= 1 && key.length <= MAX_PROPERTY_KEY && value.length <= MAX_PROPERTY_VALUE,
      ),
  );

const lineSchema = z.strictObject({
  variantId: variantIdSchema,
  quantity: z.int().min(1).max(MAX_QUANTITY),
  properties: propertiesSchema.nullish(),
  hasSellingPlan: z.boolean().nullish(),
});

const discountCodeSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value.length >= 1 &&
      value.length <= MAX_DISCOUNT_CODE_LENGTH &&
      !value.includes(',') &&
      !HAS_CONTROL_CHAR_RE.test(value),
  );

const consentSchema = z.object({
  analytics: z.boolean(),
  marketing: z.boolean(),
  preferences: z.boolean(),
  saleOfData: z.boolean(),
});

const bodySchema = z.strictObject({
  lines: z.array(lineSchema).min(1).max(MAX_LINES),
  cartToken: z.string().max(200).nullish(),
  clientNonce: z.string().regex(CLIENT_NONCE_RE).nullish(),
  country: z
    .string()
    .refine((value) => normalizeCountryCode(value) !== null)
    .nullish(),
  language: z.string().max(12).regex(LANGUAGE_RE).nullish(),
  discountCodes: z.array(discountCodeSchema).max(MAX_DISCOUNT_CODES).nullish(),
  attribution: z.record(z.string(), z.unknown()).nullish(),
  consent: consentSchema.nullish(),
  source: z.enum(['cart', 'buy_now']).nullish(),
});

/** Nomes de campo que podem aparecer na mensagem de erro (nunca texto vindo de fora). */
const KNOWN_FIELDS = new Set([
  'lines',
  'variantId',
  'quantity',
  'properties',
  'hasSellingPlan',
  'cartToken',
  'clientNonce',
  'country',
  'language',
  'discountCodes',
  'attribution',
  'consent',
  'analytics',
  'marketing',
  'preferences',
  'saleOfData',
  'source',
]);

const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;

/**
 * Caminho do campo para a mensagem. Para no primeiro segmento que não é um nome de campo
 * conhecido: dali em diante o segmento é texto do comprador (chave de propriedade).
 */
function fieldLabel(path: ReadonlyArray<PropertyKey>): string {
  let label = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      label += `[${segment}]`;
    } else if (typeof segment === 'string' && KNOWN_FIELDS.has(segment)) {
      label += label === '' ? segment : `.${segment}`;
    } else {
      break;
    }
  }
  return label;
}

function failureMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Requisição inválida.';
  const label = fieldLabel(issue.path);
  if (issue.code === 'unrecognized_keys') {
    // O nome da chave também vem de fora: só é repetido quando é um identificador simples.
    const key = issue.keys[0];
    const name = key !== undefined && SAFE_KEY_RE.test(key) ? key : null;
    const where = label === '' ? '' : `${label}.`;
    return name === null ? 'Campo não permitido na requisição.' : `Campo não permitido: ${where}${name}.`;
  }
  return label === '' ? 'Corpo da requisição inválido.' : `Campo inválido: ${label}.`;
}

function cleanAttribution(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  // Itera a lista de permissão, não a entrada: chaves fora dela nem são olhadas.
  for (const key of ATTRIBUTION_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const cleaned = truncate(value.replace(CONTROL_CHARS_RE, '').trim(), MAX_ATTRIBUTION_VALUE);
    if (cleaned !== '') out[key] = cleaned;
  }
  return out;
}

/** Remove repetições de cupom sem diferenciar maiúsculas (a Shopify também não diferencia). */
function dedupeCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const folded = code.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(code);
  }
  return out;
}

export function parseCheckoutBody(body: unknown): ParsedCheckoutBody {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: failureMessage(parsed.error) };
  const data = parsed.data;

  const lines: RequestLine[] = data.lines.map((line) => {
    const out: RequestLine = { variantId: line.variantId, quantity: line.quantity };
    if (line.properties && line.properties.length > 0) {
      out.properties = Object.fromEntries(line.properties);
    }
    if (line.hasSellingPlan === true) out.hasSellingPlan = true;
    return out;
  });

  const value: Omit<CheckoutRequest, 'shopDomain'> = { lines };
  if (typeof data.cartToken === 'string' && data.cartToken !== '') value.cartToken = data.cartToken;
  if (typeof data.clientNonce === 'string') value.clientNonce = data.clientNonce;
  const country = normalizeCountryCode(data.country);
  if (country !== null) value.country = country;
  if (typeof data.language === 'string') value.language = data.language;
  if (data.discountCodes && data.discountCodes.length > 0) value.discountCodes = dedupeCodes(data.discountCodes);
  if (data.attribution) {
    const attribution = cleanAttribution(data.attribution);
    if (Object.keys(attribution).length > 0) value.attribution = attribution;
  }
  if (data.consent) {
    const consent: VisitorConsent = {
      analytics: data.consent.analytics,
      marketing: data.consent.marketing,
      preferences: data.consent.preferences,
      saleOfData: data.consent.saleOfData,
    };
    value.consent = consent;
  }
  if (data.source) value.source = data.source;
  return { ok: true, value };
}
