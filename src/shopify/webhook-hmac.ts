import { hmacSha256Base64, timingSafeEqualStr } from '../lib/crypto.ts';

/**
 * Assinatura dos webhooks da Shopify.
 *
 * A Shopify calcula HMAC-SHA256 sobre os BYTES do corpo, exatamente como foram enviados,
 * usando o client secret do app como chave, e manda o resultado em base64 no cabeçalho
 * X-Shopify-Hmac-Sha256. Por isso quem chama precisa entregar o corpo cru: qualquer
 * JSON.parse + JSON.stringify no caminho muda espaços, ordem de chaves ou a escrita de
 * números grandes, e a assinatura deixa de conferir.
 */

/** Visão do mesmo trecho de memória como Buffer, sem copiar o corpo (que pode ter megabytes). */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Digest em base64 do corpo. Usado pelo verificador e pelos testes que simulam a Shopify. */
export function signWebhookBody(rawBody: Uint8Array | string, secret: string): string {
  const data = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : asBuffer(rawBody);
  return hmacSha256Base64(secret, data);
}

/**
 * Confere o cabeçalho X-Shopify-Hmac-Sha256 contra o corpo cru.
 *
 * Devolve false (nunca lança) para cabeçalho ausente ou vazio, segredo vazio ou corpo que
 * não seja bytes. A comparação é em tempo constante e o digest esperado nunca sai daqui:
 * devolvê-lo ou logá-lo daria a quem erra a assinatura o valor correto.
 */
export function verifyWebhookHmac(
  rawBody: Uint8Array,
  headerValue: string | null | undefined,
  secret: string,
): boolean {
  if (typeof headerValue !== 'string') return false;
  const received = headerValue.trim();
  if (received === '') return false;
  // Um HMAC com chave vazia é calculável por qualquer um; loja sem segredo não valida nada.
  if (typeof secret !== 'string' || secret === '') return false;
  if (!(rawBody instanceof Uint8Array)) return false;
  return timingSafeEqualStr(signWebhookBody(rawBody, secret), received);
}
