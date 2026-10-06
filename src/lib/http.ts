import { randomBytes } from 'node:crypto';
import { isIP, isIPv4 } from 'node:net';
import { hmacSha256Hex } from './crypto.ts';

/** Identificador de requisição para correlacionar logs: "req_" + 16 caracteres hex. */
export function newRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

/**
 * Extrai um IP de um item de X-Forwarded-For ou de X-Real-IP.
 * Aceita "1.2.3.4", "1.2.3.4:5678", "2001:db8::1", "[2001:db8::1]" e "[2001:db8::1]:5678".
 */
function parseIpCandidate(raw: string): string | null {
  let value = raw.trim();
  if (value === '' || value.length > 100) return null;
  // Alguns proxies põem o valor entre aspas.
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1).trim();

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    const rest = value.slice(close + 1);
    if (rest !== '' && !/^:[0-9]{1,5}$/.test(rest)) return null;
    value = value.slice(1, close);
  } else {
    // "1.2.3.4:5678": um único ":" só pode ser porta de IPv4 (IPv6 tem pelo menos dois).
    const parts = value.split(':');
    if (parts.length === 2 && isIPv4(parts[0] ?? '') && /^[0-9]{1,5}$/.test(parts[1] ?? '')) {
      value = parts[0] ?? '';
    }
  }

  // Identificador de zona ("fe80::1%eth0") só faz sentido na máquina de origem.
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  const family = isIP(value);
  if (family === 0) return null;
  if (family === 4) return value;
  value = value.toLowerCase();
  // IPv4 mapeado em IPv6 vira IPv4 puro, para o mesmo comprador não ter duas chaves.
  const mapped = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(value);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  // Forma canônica (comprimida) do IPv6, pelo mesmo motivo: "2001:db8:0:0:0:0:0:1" e
  // "2001:db8::1" são o mesmo endereço e precisam gerar o mesmo hash.
  try {
    const canonical = new URL(`http://[${value}]/`).hostname;
    if (canonical.startsWith('[') && canonical.endsWith(']')) value = canonical.slice(1, -1);
  } catch {
    // Mantém a forma recebida, que o isIP já validou.
  }
  // O mesmo IPv4 mapeado, agora escrito em hexadecimal ("::ffff:cb00:7105").
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? '0', 16);
    const low = Number.parseInt(mappedHex[2] ?? '0', 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return value;
}

/**
 * IP do cliente a partir dos cabeçalhos de proxy, contando `hops` proxies confiáveis a
 * partir da DIREITA de X-Forwarded-For.
 *
 * Cada proxy no caminho acrescenta ao fim do cabeçalho o IP de quem o chamou, e preserva
 * o que já vinha (é o comportamento padrão do nginx com $proxy_add_x_forwarded_for, do
 * Cloudflare e de outros): o item mais à esquerda é o que o cliente original escreveu e
 * pode ser qualquer coisa. Só os `hops` últimos itens foram escritos por proxies de
 * confiança; o `hops`-ésimo a contar da direita é o endereço que o proxy mais externo viu,
 * ou seja, o cliente. Tudo à esquerda dele é ignorado, e nunca há varredura da esquerda
 * para a direita. Se esse item não existe (cabeçalho mais curto que o esperado) ou não é
 * um IP, vale X-Real-IP (que o nginx preenche com $remote_addr); senão, null.
 *
 * `hops` = TRUSTED_PROXY_HOPS para requisições que chegam direto do cliente (painel);
 * TRUSTED_PROXY_HOPS + 1 para as que passam pelo App Proxy da Shopify, que é mais um
 * proxy entre o comprador e o proxy reverso do operador [SC-61].
 *
 * O valor serve para limitar taxa, para o hash de IP das sessões e para o cabeçalho de IP
 * do comprador na Storefront API, nunca para autorizar nada.
 */
export function clientIpFromHeaders(headers: Headers, hops: number = 1): string | null {
  const depth = Number.isInteger(hops) && hops >= 0 ? hops : 1;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded && depth > 0) {
    const entries = forwarded.split(',');
    const chosen = entries[entries.length - depth];
    if (chosen !== undefined) {
      const ip = parseIpCandidate(chosen);
      if (ip) return ip;
    }
  }
  const realIp = headers.get('x-real-ip');
  return realIp ? parseIpCandidate(realIp) : null;
}

/**
 * HMAC-SHA256 do IP com a chave do servidor, truncado em 32 caracteres hex (128 bits).
 * Permite correlacionar sessões do mesmo IP sem guardar o IP em claro; sem a chave não
 * dá para reverter por força bruta sobre o espaço de endereços.
 */
export function hashIp(ip: string | null, key: Buffer): string | null {
  if (ip === null || ip === undefined) return null;
  return hmacSha256Hex(key, ip).slice(0, 32);
}

/** JSON.parse que não lança. */
export function safeJsonParse<T = unknown>(text: string): { ok: true; value: T } | { ok: false } {
  if (typeof text !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Corta a string em no máximo `max` unidades UTF-16, sem acrescentar reticências (o
 * resultado é sempre um prefixo do original) e sem partir um par substituto ao meio.
 */
export function truncate(value: string, max: number): string {
  const text = typeof value === 'string' ? value : String(value);
  const limit = typeof max === 'number' && !Number.isNaN(max) ? Math.max(0, Math.floor(max)) : 0;
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
