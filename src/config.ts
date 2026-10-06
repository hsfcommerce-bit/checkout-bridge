import { z } from 'zod';

/**
 * Configuração lida do ambiente. Segredos entram só por variáveis de ambiente e nunca
 * são gravados em log. Veja .env.example para a descrição de cada variável.
 */

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));

/**
 * Senhas publicadas neste repositório (exemplo antigo do .env.example e a de testConfig).
 * Qualquer uma delas em produção seria uma senha pública; nenhuma é aceita.
 */
const PLACEHOLDER_PASSWORDS: ReadonlySet<string> = new Set(['troque-por-uma-senha-longa', 'senha-de-teste-123']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: intFromEnv(8787, 1, 65535),
  /** URL pública https do serviço, sem barra final. Usada nos webhooks e nos cookies. */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, '')),
  DATABASE_PATH: z.string().default('./data/bridge.db'),
  /** 32 bytes em base64. Cifra os segredos das lojas guardados no banco. */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'ENCRYPTION_KEY deve ser 32 bytes em base64 (gere com: openssl rand -base64 32)',
  }),
  /** Senha do painel administrativo. Mínimo de 12 caracteres; o valor de exemplo é recusado. */
  ADMIN_PASSWORD: z
    .string()
    .min(12, 'ADMIN_PASSWORD deve ter pelo menos 12 caracteres')
    .refine((v) => !PLACEHOLDER_PASSWORDS.has(v), {
      message: 'ADMIN_PASSWORD ainda é o valor de exemplo do .env.example; defina uma senha própria',
    }),
  /**
   * Quantos proxies confiáveis existem entre a internet e este processo (cada um acrescenta
   * o IP de quem o chamou ao fim de X-Forwarded-For). 1 = um proxy reverso (nginx, Caddy,
   * Traefik, Cloudflare); 0 = processo exposto diretamente. Veja clientIpFromHeaders.
   */
  TRUSTED_PROXY_HOPS: intFromEnv(1, 0, 10),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-10'),
  /** Janela de validade do timestamp assinado pelo App Proxy (proteção contra replay). */
  PROXY_SIGNATURE_MAX_AGE_SECONDS: intFromEnv(90, 10, 600),
  /** Janela de idempotência: o mesmo carrinho reaproveita o mesmo checkout nesse período. */
  SESSION_TTL_MINUTES: intFromEnv(15, 1, 1440),
  RATE_LIMIT_PER_IP_PER_MINUTE: intFromEnv(20, 1, 10000),
  RATE_LIMIT_PER_SHOP_PER_MINUTE: intFromEnv(600, 1, 1000000),
  UPSTREAM_TIMEOUT_MS: intFromEnv(6000, 500, 60000),
  /** Intervalo da ressincronização completa de catálogo. 0 desliga o agendamento. */
  CATALOG_RESYNC_MINUTES: intFromEnv(360, 0, 10080),
  /** Dias de retenção de sessões de checkout e auditoria. */
  RETENTION_DAYS: intFromEnv(90, 1, 3650),
  /** Webhook opcional (Slack, Discord ou genérico) que recebe os alertas em JSON. */
  ALERT_WEBHOOK_URL: optionalString,
  /** Token opcional exigido em /metrics (Authorization: Bearer ...). */
  METRICS_TOKEN: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  encryptionKey: Buffer;
  adminPassword: string;
  shopifyApiVersion: string;
  proxySignatureMaxAgeSeconds: number;
  /** Proxies confiáveis à frente do processo; decide qual item de X-Forwarded-For é o cliente. */
  trustedProxyHops: number;
  sessionTtlMinutes: number;
  rateLimitPerIpPerMinute: number;
  rateLimitPerShopPerMinute: number;
  upstreamTimeoutMs: number;
  catalogResyncMinutes: number;
  retentionDays: number;
  alertWebhookUrl: string | null;
  metricsToken: string | null;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
};

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${problems}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && !e.PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error('Configuração inválida:\n- PUBLIC_BASE_URL: em produção deve começar com https://');
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    databasePath: e.DATABASE_PATH,
    encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
    adminPassword: e.ADMIN_PASSWORD,
    shopifyApiVersion: e.SHOPIFY_API_VERSION,
    proxySignatureMaxAgeSeconds: e.PROXY_SIGNATURE_MAX_AGE_SECONDS,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    sessionTtlMinutes: e.SESSION_TTL_MINUTES,
    rateLimitPerIpPerMinute: e.RATE_LIMIT_PER_IP_PER_MINUTE,
    rateLimitPerShopPerMinute: e.RATE_LIMIT_PER_SHOP_PER_MINUTE,
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS,
    catalogResyncMinutes: e.CATALOG_RESYNC_MINUTES,
    retentionDays: e.RETENTION_DAYS,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    metricsToken: e.METRICS_TOKEN,
    logLevel: e.LOG_LEVEL,
  };
}

/** Configuração pronta para testes, sem depender do ambiente. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'https://bridge.test',
    databasePath: ':memory:',
    encryptionKey: Buffer.alloc(32, 7),
    adminPassword: 'senha-de-teste-123',
    shopifyApiVersion: '2026-10',
    proxySignatureMaxAgeSeconds: 90,
    trustedProxyHops: 1,
    sessionTtlMinutes: 15,
    rateLimitPerIpPerMinute: 20,
    rateLimitPerShopPerMinute: 600,
    upstreamTimeoutMs: 2000,
    catalogResyncMinutes: 0,
    retentionDays: 90,
    alertWebhookUrl: null,
    metricsToken: null,
    logLevel: 'silent',
    ...overrides,
  };
}
