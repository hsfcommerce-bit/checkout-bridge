import type { Clock } from '../types.ts';
import { systemClock } from './clock.ts';

/**
 * Timeout, retry e circuit breaker para as chamadas à Shopify.
 *
 * O circuit breaker daqui protege UMA loja de destino contra chamadas inúteis enquanto
 * ela está fora do ar. Ele nunca escolhe outro destino: com o circuito aberto a chamada
 * simplesmente falha (CircuitOpenError) e o comprador vê o erro de indisponibilidade.
 */

const MAX_BODY_SNIPPET = 500;

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  /** Aceita uma mensagem pronta ou o tempo limite em ms (vira a mensagem padrão). */
  constructor(messageOrTimeoutMs?: string | number) {
    super(
      typeof messageOrTimeoutMs === 'number'
        ? `Tempo limite de ${messageOrTimeoutMs} ms excedido`
        : (messageOrTimeoutMs ?? 'Tempo limite excedido'),
    );
    this.name = 'TimeoutError';
  }
}

export class CircuitOpenError extends Error {
  /** Tempo estimado até o circuito aceitar uma nova tentativa. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 0, message = 'Circuito aberto: chamada recusada sem contato com o destino') {
    super(message);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  }
}

export interface HttpStatusErrorOptions {
  retryAfterMs?: number | null;
  bodySnippet?: string;
  message?: string;
}

export class HttpStatusError extends Error {
  readonly status: number;
  /** Valor do cabeçalho Retry-After já convertido, quando o destino enviou um. */
  readonly retryAfterMs: number | null;
  /** Início do corpo da resposta, truncado. Serve para diagnóstico, não para o comprador. */
  readonly bodySnippet: string;

  // O contrato fixa só os campos. As três formas abaixo cobrem as ordens de argumento
  // plausíveis, e a implementação distingue pelo tipo em tempo de execução.
  constructor(status: number, retryAfterMs?: number | null, bodySnippet?: string);
  constructor(status: number, bodySnippet: string, retryAfterMs?: number | null);
  constructor(status: number, options: HttpStatusErrorOptions);
  constructor(
    status: number,
    second?: number | string | null | HttpStatusErrorOptions,
    third?: number | string | null,
  ) {
    let retryAfterMs: number | null = null;
    let bodySnippet = '';
    let message: string | undefined;
    if (typeof second === 'object' && second !== null) {
      retryAfterMs = second.retryAfterMs ?? null;
      bodySnippet = second.bodySnippet ?? '';
      message = second.message;
    } else {
      for (const arg of [second, third]) {
        if (typeof arg === 'number') retryAfterMs = arg;
        else if (typeof arg === 'string') bodySnippet = arg;
      }
    }
    // A mensagem não inclui o corpo da resposta, que pode ser grande ou conter dados
    // de terceiros; ele fica só em bodySnippet, truncado.
    super(message ?? `Resposta HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.bodySnippet = String(bodySnippet).slice(0, MAX_BODY_SNIPPET);
  }

  /** Monta o erro a partir de uma resposta, lendo Retry-After e o início do corpo. */
  static async fromResponse(res: Response, now: Date = new Date()): Promise<HttpStatusError> {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // Corpo ilegível não impede o erro de ser reportado.
    }
    return new HttpStatusError(res.status, {
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), now),
      bodySnippet: body,
    });
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** Maior atraso que o setTimeout do Node aceita (inteiro de 32 bits com sinal). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * fetch com tempo limite para a troca inteira, corpo incluído.
 *
 * O fetch resolve quando chegam os cabeçalhos; se o tempo limite valesse só até ali, um
 * destino que envia os cabeçalhos e trava no corpo prenderia a chamada indefinidamente.
 * Por isso o corpo é lido aqui dentro, ainda sob o tempo limite, e devolvido em uma
 * Response nova já em memória (status, statusText e cabeçalhos preservados; `url` e
 * `redirected` não). Não serve para respostas em streaming nem para corpos enormes.
 * Só se aplica a instâncias reais de Response; objetos falsos de teste passam como vieram.
 *
 * A mensagem do TimeoutError não contém a URL, que pode carregar segredo (webhooks).
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const outerSignal = init.signal ?? null;
  const onOuterAbort = (): void => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  // setTimeout só aceita até 2^31 - 1 ms; acima disso (ou com Infinity/NaN) o Node emite um
  // aviso e dispara em 1 ms, o que transformaria um prazo "enorme" em timeout imediato.
  // Prazo acima do limite fica no limite; NaN vira 0 (falha na hora, sem aviso do Node).
  const delayMs = Number.isNaN(timeoutMs) ? 0 : Math.min(MAX_TIMER_MS, Math.max(0, timeoutMs));

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A corrida garante a rejeição no prazo mesmo que fetchImpl ignore o sinal de aborto.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(timeoutMs));
      controller.abort();
    }, delayMs);
  });

  const exchange = async (): Promise<Response> => {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!(res instanceof Response) || res.bodyUsed || res.status < 200 || res.status > 599) return res;
    const body = await res.arrayBuffer();
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  try {
    return await Promise.race([exchange(), deadline]);
  } catch (err) {
    // Com o prazo estourado, o erro de aborto que o fetch produz vira TimeoutError.
    if (timedOut && !(err instanceof TimeoutError)) throw new TimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Converte o cabeçalho Retry-After em milissegundos. Aceita segundos (a Shopify envia
 * "2.0") ou data HTTP. Devolve null quando ausente ou ilegível; data no passado vira 0.
 */
export function parseRetryAfterMs(headerValue: string | null, now: Date = new Date()): number | null {
  if (typeof headerValue !== 'string') return null;
  const value = headerValue.trim();
  if (value === '') return null;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }
  // Só tenta interpretar como data o que começa por dia da semana; Date.parse sozinho
  // aceita coisas demais (um "-5" solto viraria uma data válida).
  if (!/^[A-Za-z]{3,9},? /.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

function retryAfterOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executa fn com novas tentativas, backoff exponencial e jitter total.
 *
 * `attempt` começa em 0 e é o mesmo número em fn, na fórmula e em onRetry: depois da
 * falha da tentativa n, a espera é random() * min(maxDelayMs, baseDelayMs * 2^n).
 * Se o erro traz retryAfterMs numérico, a espera é no mínimo esse valor, limitado a
 * maxDelayMs * 4 para que um cabeçalho absurdo não prenda a chamada.
 * `retries` é o número de REtentativas: fn roda no máximo retries + 1 vezes.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    retries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    shouldRetry: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  },
): Promise<T> {
  const retries = Number.isFinite(opts.retries) ? Math.max(0, Math.floor(opts.retries)) : 0;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !opts.shouldRetry(err)) throw err;
      const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      let delayMs = Math.max(0, random() * ceiling);
      const retryAfterMs = retryAfterOf(err);
      if (retryAfterMs !== null) {
        delayMs = Math.max(delayMs, Math.min(retryAfterMs, opts.maxDelayMs * 4));
      }
      if (!Number.isFinite(delayMs)) delayMs = 0;
      try {
        opts.onRetry?.(err, attempt, delayMs);
      } catch {
        // onRetry é só observação (log, métrica); uma falha ali não interrompe o retry.
      }
      await sleep(delayMs);
    }
  }
}

/**
 * Mensagens que o fetch usa para falha de rede (undici: "fetch failed" e "terminated";
 * navegadores: "Failed to fetch", "Load failed", "NetworkError when attempting...").
 * O casamento é pela mensagem INTEIRA: procurar "network" ou "socket" em qualquer lugar
 * classificava como rede erros de programação do tipo "Cannot read properties of
 * undefined (reading 'socket')" ou "x.network is not a function".
 */
const NETWORK_MESSAGE_RE =
  /^(?:fetch failed|failed to fetch|load failed|terminated|network request failed|network ?error\b.*|socket hang up|other side closed)$/i;

/** Código de erro de sistema citado na mensagem, em maiúsculas e como palavra inteira. */
const NETWORK_CODE_IN_MESSAGE_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/;

/** Códigos de erro de sistema (ECONNRESET...) e de rede do undici. Exclui os ERR_* do Node. */
const NETWORK_CODE_RE = /^(?:E(?!RR_)[A-Z0-9_]+|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/;

/**
 * O fetch sinaliza falha de rede com TypeError ("fetch failed", com a causa em `cause`).
 * TypeError de programação ("x is not a function") não entra: repetir não resolve e
 * poderia duplicar um efeito que já aconteceu no destino.
 */
function isNetworkTypeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const message = err.message.trim();
  if (NETWORK_MESSAGE_RE.test(message) || NETWORK_CODE_IN_MESSAGE_RE.test(message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_CODE_RE.test(code);
}

/**
 * Erros que valem nova tentativa: timeout, falha de rede e HTTP 429 ou 5xx.
 * CircuitOpenError fica de fora: repetir contra um circuito aberto só gasta o tempo de
 * quem está esperando.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpStatusError) return err.status === 429 || (err.status >= 500 && err.status <= 599);
  return isNetworkTypeError(err);
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Dica de espera para chamadas recusadas enquanto a chamada de teste está em curso. */
const TRIAL_RETRY_HINT_MS = 1000;

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #openMs: number;
  readonly #clock: Clock;
  readonly #onStateChange: ((state: BreakerState) => void) | undefined;

  #state: BreakerState = 'closed';
  #consecutiveFailures = 0;
  #openedAt = 0;
  #trialInFlight = false;
  /**
   * Muda a cada transição. Uma chamada que começou em uma geração e termina em outra
   * (resposta atrasada de antes de o circuito abrir, por exemplo) não entra na conta.
   */
  #generation = 0;

  constructor(opts: {
    failureThreshold: number;
    openMs: number;
    clock?: Clock;
    onStateChange?: (state: BreakerState) => void;
  }) {
    this.#failureThreshold = Number.isFinite(opts.failureThreshold)
      ? Math.max(1, Math.floor(opts.failureThreshold))
      : 1;
    this.#openMs = Number.isFinite(opts.openMs) ? Math.max(0, opts.openMs) : 0;
    this.#clock = opts.clock ?? systemClock;
    this.#onStateChange = opts.onStateChange;
  }

  /** Estado atual, já considerando a passagem do tempo (open -> half_open). */
  get state(): BreakerState {
    this.#refresh(this.#clock.now().getTime());
    return this.#state;
  }

  /**
   * Executa fn sob o circuito.
   *
   * `isFailure` decide quais erros contam como falha do destino (padrão: todos). Um erro
   * que não conta é relançado e é neutro para o circuito: não soma falha, não zera a
   * sequência e, se era a chamada de teste em half_open, apenas libera a vaga para a
   * próxima chamada ser o teste.
   */
  async exec<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    const now = this.#clock.now().getTime();
    this.#refresh(now);

    if (this.#state === 'open') {
      throw new CircuitOpenError(Math.max(0, this.#openedAt + this.#openMs - now));
    }
    const isTrial = this.#state === 'half_open';
    if (isTrial) {
      if (this.#trialInFlight) throw new CircuitOpenError(Math.min(this.#openMs, TRIAL_RETRY_HINT_MS));
      this.#trialInFlight = true;
    }
    const generation = this.#generation;

    try {
      const result = await fn();
      if (generation === this.#generation) {
        if (isTrial) this.#transition('closed');
        else this.#consecutiveFailures = 0;
      }
      return result;
    } catch (err) {
      if (generation === this.#generation) {
        let counts = true;
        try {
          counts = isFailure(err);
        } catch {
          // Classificador com defeito: na dúvida, conta como falha.
        }
        if (!counts) {
          if (isTrial) this.#trialInFlight = false;
        } else if (isTrial) {
          this.#transition('open');
        } else {
          this.#consecutiveFailures += 1;
          if (this.#consecutiveFailures >= this.#failureThreshold) this.#transition('open');
        }
      }
      throw err;
    }
  }

  #refresh(now: number): void {
    if (this.#state !== 'open') return;
    // Relógio que voltou no tempo: reancora para o circuito não ficar aberto além de openMs.
    if (now < this.#openedAt) this.#openedAt = now;
    if (now - this.#openedAt >= this.#openMs) this.#transition('half_open');
  }

  #transition(next: BreakerState): void {
    this.#state = next;
    this.#generation += 1;
    this.#trialInFlight = false;
    this.#consecutiveFailures = 0;
    if (next === 'open') this.#openedAt = this.#clock.now().getTime();
    try {
      this.#onStateChange?.(next);
    } catch {
      // Observador com defeito não pode derrubar a chamada protegida.
    }
  }
}

/** Limite de circuitos guardados; as chaves esperadas são lojas, então é folga de sobra. */
const MAX_BREAKERS = 1000;

/**
 * Um circuito por chave (em geral, por loja de destino), criado no primeiro uso.
 * Cada circuito é independente: o estado de uma loja não afeta as chamadas para outra.
 */
export function createBreakerRegistry(opts: {
  failureThreshold: number;
  openMs: number;
  clock?: Clock;
  onStateChange?: (key: string, state: BreakerState) => void;
}): { get(key: string): CircuitBreaker } {
  const breakers = new Map<string, CircuitBreaker>();
  return {
    get(key: string): CircuitBreaker {
      let breaker = breakers.get(key);
      if (!breaker) {
        if (breakers.size >= MAX_BREAKERS) {
          // Sai de preferência um circuito fechado (perder o estado dele não muda nada);
          // na falta, o mais antigo.
          let victim: string | undefined;
          for (const [candidateKey, candidate] of breakers) {
            victim ??= candidateKey;
            if (candidate.state === 'closed') {
              victim = candidateKey;
              break;
            }
          }
          if (victim !== undefined) breakers.delete(victim);
        }
        const onStateChange = opts.onStateChange;
        breaker = new CircuitBreaker({
          failureThreshold: opts.failureThreshold,
          openMs: opts.openMs,
          clock: opts.clock,
          onStateChange: onStateChange ? (state) => onStateChange(key, state) : undefined,
        });
        breakers.set(key, breaker);
      }
      return breaker;
    },
  };
}
