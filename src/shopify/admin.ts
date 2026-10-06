import type { Config } from '../config.ts';
import { systemClock } from '../lib/clock.ts';
import { safeJsonParse, truncate } from '../lib/http.ts';
import { fetchWithTimeout, isRetryableError, parseRetryAfterMs, TimeoutError } from '../lib/resilience.ts';
import { isValidShopDomain } from '../lib/shop.ts';
import { BridgeError } from '../types.ts';
import type { AdminClient, AdminTokenProvider, Alerter, Clock, Logger, Metrics, Store } from '../types.ts';

/**
 * Cliente GraphQL da Admin API.
 *
 * O limite da Admin API é por custo de consulta e por par app+loja (balde que se
 * recompõe a uma taxa que depende do plano). O estouro chega como erro THROTTLED dentro
 * de uma resposta 200, não como 429; por isso o corpo é sempre inspecionado. O tamanho do
 * balde por plano não é documentado: tudo aqui usa os números que a própria resposta traz
 * em extensions.cost, nunca constantes.
 */

const MAX_THROTTLED_ATTEMPTS = 5;
const MAX_TRANSIENT_RETRIES = 3;
const THROTTLE_MIN_WAIT_MS = 500;
const THROTTLE_MAX_WAIT_MS = 10_000;
/** Espera recomendada pela Shopify quando a resposta não traz os dados de custo. */
const THROTTLE_DEFAULT_WAIT_MS = 1000;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 4000;
/** Intervalo mínimo entre avisos de versão diferente da fixada, por loja. */
const VERSION_WARN_INTERVAL_MS = 10 * 60_000;
const MAX_ERROR_MESSAGES = 5;
const MAX_ERROR_MESSAGE_CHARS = 300;

export interface AdminClientDeps {
  tokens: AdminTokenProvider;
  config: Pick<Config, 'shopifyApiVersion' | 'upstreamTimeoutMs'>;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Último estado conhecido do balde de custo de uma loja. */
interface Bucket {
  available: number;
  restoreRate: number;
  maximumAvailable: number | null;
  lastRequestedCost: number;
  observedAtMs: number;
}

interface CostInfo {
  requestedQueryCost: number | null;
  currentlyAvailable: number | null;
  restoreRate: number | null;
  maximumAvailable: number | null;
}

interface GraphqlErrorInfo {
  code: string | null;
  message: string;
}

/** Resultado de UMA troca HTTP, já classificado. A política de repetição fica no laço. */
type Outcome =
  | { kind: 'ok'; data: unknown; errors: GraphqlErrorInfo[] }
  | { kind: 'denied'; status: number; errors: GraphqlErrorInfo[] }
  | { kind: 'throttled'; status: number; waitMs: number }
  | { kind: 'transient'; reason: string; status: number | null; retryAfterMs: number | null }
  | { kind: 'rejected'; status: number; code: string | null; errors: GraphqlErrorInfo[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCost(body: unknown): CostInfo | null {
  if (!isRecord(body) || !isRecord(body['extensions'])) return null;
  const cost = body['extensions']['cost'];
  if (!isRecord(cost)) return null;
  const status = isRecord(cost['throttleStatus']) ? cost['throttleStatus'] : {};
  return {
    requestedQueryCost: finiteNumber(cost['requestedQueryCost']),
    currentlyAvailable: finiteNumber(status['currentlyAvailable']),
    restoreRate: finiteNumber(status['restoreRate']),
    maximumAvailable: finiteNumber(status['maximumAvailable']),
  };
}

/** Erros de topo do GraphQL. Aceita também o formato {"errors": "texto"} das respostas não-200. */
function parseErrors(body: unknown): GraphqlErrorInfo[] {
  if (!isRecord(body)) return [];
  const raw = body['errors'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return [{ code: null, message: truncate(raw.trim(), MAX_ERROR_MESSAGE_CHARS) }];
  }
  if (!Array.isArray(raw)) return [];
  const errors: GraphqlErrorInfo[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const extensions = isRecord(item['extensions']) ? item['extensions'] : {};
    const code = typeof extensions['code'] === 'string' ? truncate(extensions['code'], 60) : null;
    const message = typeof item['message'] === 'string' ? item['message'] : '';
    errors.push({ code, message: truncate(message, MAX_ERROR_MESSAGE_CHARS) });
  }
  return errors;
}

function messagesOf(errors: GraphqlErrorInfo[]): string[] {
  return errors.slice(0, MAX_ERROR_MESSAGES).map((error) => error.message);
}

/**
 * Espera depois de um THROTTLED: o tempo para o balde recompor o que falta para o custo
 * pedido, em segundos inteiros, limitado a 0,5..10 s. Sem os dados de custo, 1 s.
 */
function throttleWaitMs(cost: CostInfo | null): number {
  if (
    cost === null ||
    cost.requestedQueryCost === null ||
    cost.currentlyAvailable === null ||
    cost.restoreRate === null ||
    cost.restoreRate <= 0
  ) {
    return THROTTLE_DEFAULT_WAIT_MS;
  }
  const seconds = Math.ceil((cost.requestedQueryCost - cost.currentlyAvailable) / cost.restoreRate);
  return Math.min(THROTTLE_MAX_WAIT_MS, Math.max(THROTTLE_MIN_WAIT_MS, seconds * 1000));
}

function clampThrottleWait(ms: number): number {
  return Math.min(THROTTLE_MAX_WAIT_MS, Math.max(THROTTLE_MIN_WAIT_MS, ms));
}

function rejectionMessage(shopDomain: string, status: number, code: string | null): string {
  if (code === 'MAX_COST_EXCEEDED') {
    return `A consulta à Admin API de ${shopDomain} passa do custo máximo permitido por consulta (MAX_COST_EXCEEDED).`;
  }
  if (code === 'SHOP_INACTIVE') return `A loja ${shopDomain} está inativa na Shopify (SHOP_INACTIVE).`;
  if (status === 402) {
    return `A loja ${shopDomain} está congelada na Shopify (HTTP 402). Confira a situação de pagamento da loja.`;
  }
  if (status === 403) {
    return `A Shopify negou o acesso à Admin API de ${shopDomain} (HTTP 403). Confira se a loja está ativa e o app instalado.`;
  }
  if (status === 404) {
    return `A Admin API de ${shopDomain} não foi encontrada (HTTP 404). Confira o domínio myshopify.com da loja.`;
  }
  if (status === 423) return `A loja ${shopDomain} está bloqueada na Shopify (HTTP 423).`;
  if (status >= 200 && status < 300) {
    return `A Admin API de ${shopDomain} recusou a consulta${code === null ? '' : ` (${code})`}.`;
  }
  return `A Admin API de ${shopDomain} recusou a requisição (HTTP ${status}).`;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAdminClient(deps: AdminClientDeps): AdminClient {
  const { tokens, config, logger, metrics, alerter } = deps;
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const buckets = new Map<string, Bucket>();
  const versionWarnings = new Map<string, { version: string; atMs: number }>();

  const nowMs = (): number => clock.now().getTime();

  function rememberCost(storeId: string, cost: CostInfo | null): void {
    if (cost === null || cost.currentlyAvailable === null || cost.restoreRate === null) return;
    buckets.set(storeId, {
      available: cost.currentlyAvailable,
      restoreRate: cost.restoreRate,
      maximumAvailable: cost.maximumAvailable,
      lastRequestedCost: cost.requestedQueryCost ?? buckets.get(storeId)?.lastRequestedCost ?? 0,
      observedAtMs: nowMs(),
    });
  }

  /**
   * Ritmo preventivo: estima o balde pelo último throttleStatus mais o que se recompôs
   * desde então e, se não couber o custo da última consulta (a melhor pista do custo da
   * próxima), devolve quanto esperar. A estimativa já desconta a consulta que vai sair,
   * para que chamadas simultâneas não contem o mesmo saldo duas vezes; a resposta
   * seguinte substitui a estimativa pelo valor real.
   */
  function paceDelayMs(storeId: string): number {
    const bucket = buckets.get(storeId);
    if (bucket === undefined || bucket.restoreRate <= 0) return 0;
    const now = nowMs();
    const elapsedSeconds = Math.max(0, now - bucket.observedAtMs) / 1000;
    let estimated = bucket.available + bucket.restoreRate * elapsedSeconds;
    let cost = bucket.lastRequestedCost;
    if (bucket.maximumAvailable !== null) {
      estimated = Math.min(estimated, bucket.maximumAvailable);
      // Um custo maior que o balde inteiro nunca caberia; não adianta esperar por ele.
      cost = Math.min(cost, bucket.maximumAvailable);
    }
    bucket.available = estimated - cost;
    bucket.observedAtMs = now;
    if (estimated >= cost) return 0;
    return Math.min(THROTTLE_MAX_WAIT_MS, Math.ceil(((cost - estimated) / bucket.restoreRate) * 1000));
  }

  /**
   * A Shopify não avisa quando uma versão expira: passa a responder com a versão estável
   * mais antiga ainda suportada. O único sinal é este cabeçalho de resposta.
   */
  function checkVersion(store: Store, res: Response): void {
    const served = res.headers.get('x-shopify-api-version')?.trim() ?? '';
    if (served === '' || served === config.shopifyApiVersion) return;
    const now = nowMs();
    const last = versionWarnings.get(store.id);
    if (last !== undefined && last.version === served && now - last.atMs < VERSION_WARN_INTERVAL_MS) return;
    versionWarnings.set(store.id, { version: served, atMs: now });
    const detail = {
      storeId: store.id,
      shopDomain: store.shopDomain,
      pinnedVersion: config.shopifyApiVersion,
      servedVersion: truncate(served, 20),
    };
    logger.warn(detail, 'A Admin API respondeu com uma versão diferente da fixada');
    alerter.notify({
      key: `api-version:${store.id}`,
      severity: 'warning',
      title: `A Admin API de ${store.shopDomain} respondeu com a versão ${detail.servedVersion} em vez da fixada ${config.shopifyApiVersion}`,
      detail,
    });
  }

  async function exchange(store: Store, url: string, token: string, body: string): Promise<Outcome> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        deps.fetchImpl ?? fetch,
        url,
        {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          // O cabeçalho com o token não pode seguir um redirecionamento para outro host.
          redirect: 'manual',
        },
        config.upstreamTimeoutMs,
      );
    } catch (err) {
      if (err instanceof TimeoutError) return { kind: 'transient', reason: 'timeout', status: null, retryAfterMs: null };
      if (isRetryableError(err)) return { kind: 'transient', reason: 'network', status: null, retryAfterMs: null };
      throw new BridgeError('upstream_unavailable', `Falha inesperada ao chamar a Admin API de ${store.shopDomain}.`, {
        reason: err instanceof Error ? truncate(err.name, 60) : 'unknown',
      });
    }

    checkVersion(store, res);
    const status = res.status;
    const parsed = safeJsonParse<unknown>(await res.text());
    const json: unknown = parsed.ok ? parsed.value : null;
    // As mensagens de erro seguem para details e log. Limpeza defensiva: se o destino
    // ecoar o token em uma delas, ele não sai daqui.
    const errors = parseErrors(json).map((error) => ({
      code: error.code,
      message: token === '' ? error.message : error.message.split(token).join('[redigido]'),
    }));
    const cost = parseCost(json);
    rememberCost(store.id, cost);

    if (status === 401) return { kind: 'denied', status, errors };
    if (status === 429) {
      // Retry-After não é documentado para o GraphQL; se vier, vale mais que a conta.
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), clock.now());
      return { kind: 'throttled', status, waitMs: retryAfterMs === null ? throttleWaitMs(cost) : clampThrottleWait(retryAfterMs) };
    }
    if (status >= 500) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), clock.now());
      return { kind: 'transient', reason: 'http', status, retryAfterMs };
    }
    const codes = errors.map((error) => error.code).filter((code): code is string => code !== null);
    const mainCode = codes.includes('MAX_COST_EXCEEDED') ? 'MAX_COST_EXCEEDED' : (codes[0] ?? null);
    if (!res.ok) return { kind: 'rejected', status, code: mainCode, errors };

    // Um 200 que não é JSON veio de algum intermediário, não do GraphQL: vale repetir.
    if (!isRecord(json)) return { kind: 'transient', reason: 'invalid_json', status, retryAfterMs: null };
    if (codes.includes('THROTTLED')) return { kind: 'throttled', status, waitMs: throttleWaitMs(cost) };
    if (codes.includes('ACCESS_DENIED')) return { kind: 'denied', status, errors };
    // Mesmo com dados parciais: devolver um catálogo com campos nulos por erro interno da
    // Shopify seria pior que repetir a consulta.
    if (codes.includes('INTERNAL_SERVER_ERROR')) {
      return { kind: 'transient', reason: 'internal_server_error', status, retryAfterMs: null };
    }
    const data = json['data'];
    if (isRecord(data)) return { kind: 'ok', data, errors };
    return { kind: 'rejected', status, code: mainCode, errors };
  }

  async function run(store: Store, query: string, variables: Record<string, unknown> | undefined): Promise<unknown> {
    // O token vai em um cabeçalho deste pedido; ele só pode sair para um host myshopify.com.
    if (!isValidShopDomain(store.shopDomain)) {
      throw new BridgeError('upstream_rejected', 'O domínio da loja não é um domínio myshopify.com válido.', {
        status: 0,
        code: 'INVALID_SHOP_DOMAIN',
      });
    }
    const url = `https://${store.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    const body = JSON.stringify({ query, variables });
    const context = { storeId: store.id, shopDomain: store.shopDomain };
    let throttledAttempts = 0;
    let transientRetries = 0;
    let reminted = false;
    let skipPace = false;

    for (;;) {
      // Logo depois de uma espera por THROTTLED o balde já foi levado em conta.
      if (!skipPace) {
        const paceMs = paceDelayMs(store.id);
        if (paceMs > 0) {
          logger.debug({ ...context, paceMs }, 'Admin API: aguardando o balde de custo recompor');
          await sleep(paceMs);
        }
      }
      skipPace = false;

      const token = await tokens.getToken(store);
      const outcome = await exchange(store, url, token, body);
      metrics.inc('bridge_admin_requests_total', { result: outcome.kind });

      switch (outcome.kind) {
        case 'ok': {
          if (outcome.errors.length > 0) {
            logger.warn(
              { ...context, codes: outcome.errors.map((error) => error.code), messages: messagesOf(outcome.errors) },
              'Admin API devolveu dados junto com erros',
            );
          }
          return outcome.data;
        }
        case 'denied': {
          if (reminted) {
            const message =
              outcome.status === 401
                ? `A Admin API de ${store.shopDomain} recusou o token (HTTP 401) mesmo depois de emitir um novo. ` +
                  'Confira se o app continua instalado na loja e se o Client secret não foi revogado.'
                : `A Admin API de ${store.shopDomain} negou o acesso (ACCESS_DENIED) mesmo com um token novo. ` +
                  'Em geral falta um escopo: confira os escopos da versão lançada do app e se a mudança foi aprovada na loja.';
            throw new BridgeError('upstream_rejected', message, {
              code: 'ACCESS_DENIED',
              status: outcome.status,
              messages: messagesOf(outcome.errors),
            });
          }
          // Token revogado no meio da validade (app reinstalado, secret trocado) ou escopo
          // aprovado depois da emissão: um token novo resolve os dois casos.
          reminted = true;
          tokens.invalidate(store.id);
          logger.warn({ ...context, status: outcome.status }, 'Admin API negou o acesso; emitindo um token novo');
          break;
        }
        case 'throttled': {
          throttledAttempts += 1;
          if (throttledAttempts >= MAX_THROTTLED_ATTEMPTS) {
            throw new BridgeError(
              'upstream_unavailable',
              `A Admin API de ${store.shopDomain} continuou limitando as requisições após ${throttledAttempts} tentativas.`,
              { code: 'THROTTLED', status: outcome.status, attempts: throttledAttempts },
            );
          }
          logger.warn({ ...context, waitMs: outcome.waitMs, attempt: throttledAttempts }, 'Admin API limitou a requisição (THROTTLED)');
          await sleep(outcome.waitMs);
          skipPace = true;
          break;
        }
        case 'transient': {
          if (transientRetries >= MAX_TRANSIENT_RETRIES) {
            throw new BridgeError(
              'upstream_unavailable',
              `A Admin API de ${store.shopDomain} não respondeu após ${transientRetries + 1} tentativas.`,
              { reason: outcome.reason, status: outcome.status, attempts: transientRetries + 1 },
            );
          }
          // Backoff exponencial com jitter total, a mesma fórmula de lib/resilience.
          const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** transientRetries);
          let delayMs = Math.max(0, random() * ceiling);
          if (outcome.retryAfterMs !== null) {
            delayMs = Math.max(delayMs, Math.min(outcome.retryAfterMs, THROTTLE_MAX_WAIT_MS));
          }
          transientRetries += 1;
          logger.warn(
            { ...context, reason: outcome.reason, status: outcome.status, attempt: transientRetries, delayMs },
            'Admin API falhou; nova tentativa',
          );
          await sleep(delayMs);
          break;
        }
        case 'rejected': {
          throw new BridgeError('upstream_rejected', rejectionMessage(store.shopDomain, outcome.status, outcome.code), {
            status: outcome.status,
            ...(outcome.code === null ? {} : { code: outcome.code }),
            ...(outcome.errors.length === 0 ? {} : { messages: messagesOf(outcome.errors) }),
          });
        }
      }
    }
  }

  return {
    async graphql<T>(store: Store, query: string, variables?: Record<string, unknown>): Promise<T> {
      const startedMs = nowMs();
      let result = 'error';
      try {
        const data = await run(store, query, variables);
        result = 'ok';
        // O formato de `data` é responsabilidade de quem escreveu a consulta.
        return data as T;
      } finally {
        metrics.observe('bridge_admin_request_ms', Math.max(0, nowMs() - startedMs), { result });
      }
    },
  };
}
