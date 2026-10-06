import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { SecretBox } from '../types.ts';

const BOX_VERSION = 'v1';

/**
 * Cifra autenticada (AES-256-GCM) para segredos guardados no banco.
 * Formato: v1.<iv>.<tag>.<ciphertext>, cada parte em base64url.
 */
export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('A chave de cifra deve ter 32 bytes');
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [BOX_VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
    },
    decrypt(blob: string): string {
      const parts = blob.split('.');
      if (parts.length !== 4 || parts[0] !== BOX_VERSION) throw new Error('Segredo cifrado em formato inválido');
      const iv = Buffer.from(parts[1] as string, 'base64url');
      const tag = Buffer.from(parts[2] as string, 'base64url');
      const data = Buffer.from(parts[3] as string, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Segredo cifrado em formato inválido');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

/** Deriva uma subchave de 32 bytes para um propósito específico (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `checkout-bridge:${purpose}`, 32));
}

export function hmacSha256Hex(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function hmacSha256Base64(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('base64');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const COMPARE_KEY = randomBytes(32);

/**
 * Comparação em tempo constante de duas strings de qualquer tamanho.
 * Compara os HMACs das duas, o que evita vazar o tamanho e o conteúdo.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(a).digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** ID interno com prefixo, por exemplo randomId('st') => "st_3f9c...". */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/** Token aleatório em base64url para sessões e CSRF. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
