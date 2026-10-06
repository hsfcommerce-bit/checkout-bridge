import type { Config } from '../config.ts';
import { systemClock } from '../lib/clock.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { safeJsonParse, truncate } from '../lib/http.ts';
import {
  fetchWithTimeout,
  HttpStatusError,
  isRetryableError,
  parseRetryAfterMs,
  retry,
  TimeoutError,
} from '../lib/resilience.ts';
import { isValidShopDomain } from '../lib/shop.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type { AdminTokenProvider, Alerter, Clock, Logger, Metrics, Store, StoreRepo } from '../types.ts';

/**
 * Token da Admin API pelo client credentials grant (apps do Dev Dashboard).
 *
 * O token dura 24 horas e não existe refresh token: renovar é repetir o mesmo POST. A
 * Shopify não documenta se emitir um token novo invalida o anterior, por isso a emissão é
 * serializada por loja (um pedido em curso é compartilhado por todos os chamadores).
 *
 * Nada daqui pode vazar o client secret ou o token: eles só existem no corpo do pedido,
 * na resposta e no cache em memória. Mensagens, details, logs e alertas levam apenas o
 * status HTTP e o código de erro, e o código ainda passa por uma limpeza defensiva.
 */

/** Renova quando faltar menos que isso para o token expirar. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** Tempo em que um erro permanente de configuração é lembrado, para não martelar a loja. */
const NEGATIVE_TTL_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2000;
/**
 * Validade assumida quando a resposta não traz expires_in utilizável. O campo é
 * documentado (86399), então isso é só defesa: um valor curto força nova emissão cedo.
 */
const FALLBACK_LIFETIME_SECONDS = 600;
/** Depois de uma renovação antecipada que falhou, espera isso antes de tentar de novo. */
const RENEW_RETRY_MS = 30_000;
/** Um token com menos que isso de vida não é devolvido como reserva. */
const MIN_STALE_LEFT_MS = 10_000;
const CENSOR = '[redigido]';

/**
 * Códigos de erro que indicam configuração errada (credenciais, organização, instalação).
 * Repetir o pedido não resolve. O status HTTP de shop_not_permitted não é documentado,
 * então o código vale mesmo quando chega com um status que normalmente seria repetido.
 */
const PERMANENT_ERROR_CODES = new Set([
  'shop_not_permitted',
  'application_cannot_be_found',
  'invalid_client',
  'invalid_request',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
]);

interface TokenEntry {
  token: string;
  scopes: string[];
  fingerprint: string;
  expiresAtMs: number;
  renewAtMs: number;
}

interface Flight {
  seq: number;
  fingerprint: string;
  promise: Promise<TokenEntry>;
}

interface NegativeEntry {
  fingerprint: string;
  untilMs: number;
  message: string;
  details: Record<string, unknown>;
}

export interface AdminTokenProviderDeps {
  stores: StoreRepo;
  config: Pick<Config, 'upstreamTimeoutMs'>;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Código de erro do corpo: formato OAuth ({"error": "..."}) ou o da Shopify ({"errors": "..."}). */
function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const key of ['error', 'errors']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function rejectionMessage(shopDomain: string, status: number, error: string | null): string {
  switch (error) {
    case 'shop_not_permitted':
      return (
        `A Shopify recusou o token para ${shopDomain}: o app e a loja não estão na mesma organização Shopify. ` +
        'Agrupe a loja na organização do app ou crie o app no Dev Dashboard da organização da loja.'
      );
    case 'application_cannot_be_found':
      return (
        `A Shopify não reconheceu o Client ID usado em ${shopDomain}. ` +
        'Confira o Client ID copiado do Dev Dashboard (Configurações > Credenciais).'
      );
    case 'invalid_client':
      return (
        `Client ID ou Client secret recusados em ${shopDomain}. ` +
        'Confira as credenciais do app e se o secret não foi revogado.'
      );
    case 'invalid_request':
      return (
        `A Shopify considerou inválido o pedido de token para ${shopDomain}. Confira o Client ID, ` +
        'o Client secret e se o app tem uma versão lançada e está instalado na loja.'
      );
  }
  if (status === 404) {
    return `A loja ${shopDomain} não foi encontrada. Confira o domínio myshopify.com cadastrado.`;
  }
  if (status === 401 || status === 403) {
    return (
      `A Shopify negou o token para ${shopDomain} (HTTP ${status}). Confira o Client ID, o Client secret, ` +
      'se o app está instalado na loja e se ambos estão na mesma organização.'
    );
  }
  if (status >= 300 && status < 400) {
    return `O domínio ${shopDomain} respondeu com um redirecionamento. Confira o domínio myshopify.com atual da loja.`;
  }
  if (status >= 200 && status < 300) {
    return (
      `A Shopify respondeu ao pedido de token de ${shopDomain} sem um access_token. ` +
      'Confira se o app tem uma versão lançada e está instalado na loja.'
    );
  }
  return (
    `A Shopify recusou o pedido de token para ${shopDomain} (HTTP ${status}). Confira as credenciais do app, ` +
    'se ele tem uma versão lançada e se está instalado na loja.'
  );
}

export function createAdminTokenProvider(deps: AdminTokenProviderDeps): AdminTokenProvider {
  const { logger, metrics, alerter } = deps;
  const clock = deps.clock ?? systemClock;
  const cache = new Map<string, TokenEntry>();
  const inflight = new Map<string, Flight>();
  const negative = new Map<string, NegativeEntry>();
  let flightSeq = 0;

  const nowMs = (): number => clock.now().getTime();

  /** Pedido ao endpoint de token, com retry só para falhas transitórias. */
  async function requestToken(store: Store, clientSecret: string, fingerprint: string): Promise<TokenEntry> {
    // Limpeza defensiva: se algum dia o destino ecoar o secret em um campo de erro, ele
    // não segue para details, log ou alerta.
    const scrub = (text: string): string => {
      if (clientSecret === '') return text;
      return text.split(clientSecret).join(CENSOR).split(encodeURIComponent(clientSecret)).join(CENSOR);
    };
    const reject = (status: number, error: string | null): BridgeError => {
      const safeError = error === null ? null : truncate(scrub(error), 120);
      return new BridgeError('upstream_rejected', rejectionMessage(store.shopDomain, status, safeError), {
        status,
        error: safeError,
      });
    };

    // O secret vai no corpo deste pedido; ele só pode sair para um host myshopify.com.
    if (!isValidShopDomain(store.shopDomain)) {
      throw new BridgeError('upstream_rejected', 'O domínio da loja não é um domínio myshopify.com válido.', {
        status: 0,
        error: 'invalid_shop_domain',
      });
    }
    const url = `https://${store.shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: store.clientId,
      client_secret: clientSecret,
    }).toString();
    const fetchImpl = deps.fetchImpl ?? fetch;

    return retry(
      async () => {
        const startedMs = nowMs();
        const res = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body,
            // Um 307/308 reenviaria o corpo (com o secret) para o destino do redirecionamento.
            redirect: 'manual',
          },
          deps.config.upstreamTimeoutMs,
        );
        const parsed = safeJsonParse<unknown>(await res.text());
        const json: unknown = parsed.ok ? parsed.value : null;
        const error = errorCodeOf(json);

        if (!res.ok) {
          const transientStatus = res.status === 429 || res.status >= 500;
          if (transientStatus && !(error !== null && PERMANENT_ERROR_CODES.has(error))) {
            throw new HttpStatusError(res.status, {
              retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), clock.now()),
            });
          }
          throw reject(res.status, error);
        }
        const token = isRecord(json) ? json['access_token'] : undefined;
        if (typeof token !== 'string' || token.trim() === '') throw reject(res.status, error);

        const scopeField = isRecord(json) ? json['scope'] : undefined;
        const scopes =
          typeof scopeField === 'string'
            ? scopeField
                .split(',')
                .map((scope) => scope.trim())
                .filter((scope) => scope !== '')
            : [];
        const expiresIn = isRecord(json) ? json['expires_in'] : undefined;
        const lifetimeSeconds =
          typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn
            : FALLBACK_LIFETIME_SECONDS;
        const lifetimeMs = lifetimeSeconds * 1000;
        // A validade conta do início do pedido (lado conservador). Com validade menor que
        // o dobro da margem, renova na metade da vida para não reemitir a cada chamada.
        return {
          token,
          scopes,
          fingerprint,
          expiresAtMs: startedMs + lifetimeMs,
          renewAtMs: startedMs + Math.max(lifetimeMs - RENEW_MARGIN_MS, lifetimeMs / 2),
        };
      },
      {
        retries: MAX_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        shouldRetry: isRetryableError,
        sleep: deps.sleep,
        random: deps.random,
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            { storeId: store.id, shopDomain: store.shopDomain, attempt, delayMs, ...describeTransient(err) },
            'Pedido de token da Admin API falhou; nova tentativa',
          );
        },
      },
    );
  }

  function describeTransient(err: unknown): { reason: string; status?: number } {
    if (err instanceof HttpStatusError) return { reason: 'http', status: err.status };
    if (err instanceof TimeoutError) return { reason: 'timeout' };
    if (isRetryableError(err)) return { reason: 'network' };
    // O nome da classe basta para diagnóstico; a mensagem de um erro desconhecido não é
    // repassada porque não há garantia sobre o que ela contém.
    return { reason: err instanceof Error ? truncate(err.name, 60) : 'unknown' };
  }

  /** Emite o token e registra o resultado (cache, cache negativo, métrica, alerta). */
  async function mint(store: Store, clientSecret: string, fingerprint: string, seq: number): Promise<TokenEntry> {
    // Só o pedido que ainda é o corrente da loja grava cache: um pedido solto por
    // invalidate() ou superado por credenciais novas não pode sobrescrever o estado.
    const isCurrent = (): boolean => inflight.get(store.id)?.seq === seq;
    try {
      const entry = await requestToken(store, clientSecret, fingerprint);
      metrics.inc('bridge_admin_token_requests_total', { result: 'ok' });
      if (isCurrent()) {
        cache.set(store.id, entry);
        negative.delete(store.id);
      }
      logger.info(
        {
          storeId: store.id,
          shopDomain: store.shopDomain,
          expiresInSeconds: Math.round((entry.expiresAtMs - nowMs()) / 1000),
          scopes: entry.scopes,
        },
        'Token da Admin API emitido',
      );
      return entry;
    } catch (err) {
      if (isBridgeError(err)) {
        metrics.inc('bridge_admin_token_requests_total', { result: 'rejected' });
        if (isCurrent()) {
          negative.set(store.id, {
            fingerprint,
            untilMs: nowMs() + NEGATIVE_TTL_MS,
            message: err.message,
            details: err.details,
          });
        }
        logger.error(
          { storeId: store.id, shopDomain: store.shopDomain, ...err.details },
          'Pedido de token da Admin API recusado (erro de configuração)',
        );
        alerter.notify({
          key: `admin-token:${store.id}`,
          severity: 'critical',
          title: `Token da Admin API recusado para ${store.shopDomain}`,
          detail: { storeId: store.id, shopDomain: store.shopDomain, ...err.details, message: err.message },
        });
        throw err;
      }
      metrics.inc('bridge_admin_token_requests_total', { result: 'unavailable' });
      const transient = describeTransient(err);
      logger.error(
        { storeId: store.id, shopDomain: store.shopDomain, ...transient },
        'Pedido de token da Admin API indisponível',
      );
      throw new BridgeError(
        'upstream_unavailable',
        `Não foi possível obter o token da Admin API de ${store.shopDomain}: a Shopify não respondeu.`,
        { ...transient },
      );
    } finally {
      if (isCurrent()) inflight.delete(store.id);
    }
  }

  async function ensure(store: Store): Promise<TokenEntry> {
    // O secret é relido a cada chamada (leitura local, barata): é isso que faz credenciais
    // novas salvas no painel valerem na hora, sem esperar o token antigo expirar.
    const { clientSecret } = deps.stores.getSecrets(store.id);
    const fingerprint = sha256Hex(`${store.shopDomain}\n${store.clientId}\n${sha256Hex(clientSecret)}`);
    const now = nowMs();

    const cached = cache.get(store.id);
    const usable = cached !== undefined && cached.fingerprint === fingerprint ? cached : null;
    if (usable !== null && now < usable.renewAtMs) return usable;

    const remembered = negative.get(store.id);
    if (remembered !== undefined) {
      if (remembered.fingerprint === fingerprint && now < remembered.untilMs) {
        metrics.inc('bridge_admin_token_requests_total', { result: 'negative_cache' });
        throw new BridgeError('upstream_rejected', remembered.message, { ...remembered.details });
      }
      negative.delete(store.id);
    }

    let flight = inflight.get(store.id);
    if (flight === undefined || flight.fingerprint !== fingerprint) {
      flightSeq += 1;
      const seq = flightSeq;
      // mint() só consulta o mapa depois de um await, e a continuação de um await nunca
      // roda antes do fim deste trecho síncrono; o registro abaixo chega a tempo.
      flight = { seq, fingerprint, promise: mint(store, clientSecret, fingerprint, seq) };
      inflight.set(store.id, flight);
    }

    try {
      return await flight.promise;
    } catch (err) {
      // Renovação antecipada que falhou por indisponibilidade: o token em cache ainda
      // vale, então ele é devolvido em vez de derrubar a chamada. Erro permanente não
      // entra aqui: a configuração quebrou e o operador precisa ver.
      const current = nowMs();
      if (
        usable !== null &&
        cache.get(store.id) === usable &&
        isBridgeError(err) &&
        err.code === 'upstream_unavailable' &&
        usable.expiresAtMs - current > MIN_STALE_LEFT_MS
      ) {
        // Adia a próxima tentativa de renovação sem nunca passar da validade do token.
        usable.renewAtMs = Math.min(usable.expiresAtMs - MIN_STALE_LEFT_MS, current + RENEW_RETRY_MS);
        logger.warn(
          { storeId: store.id, shopDomain: store.shopDomain },
          'Renovação antecipada do token falhou; mantendo o token atual, ainda válido',
        );
        return usable;
      }
      throw err;
    }
  }

  return {
    async getToken(store: Store): Promise<string> {
      return (await ensure(store)).token;
    },
    async getScopes(store: Store): Promise<string[]> {
      return [...(await ensure(store)).scopes];
    },
    invalidate(storeId: string): void {
      cache.delete(storeId);
      negative.delete(storeId);
      // Um pedido em curso começou antes da invalidação: quem já espera por ele recebe o
      // resultado, mas ele não entra no cache e o próximo chamador emite um token novo.
      inflight.delete(storeId);
    },
  };
}
