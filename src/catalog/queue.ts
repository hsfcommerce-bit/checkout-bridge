import { truncate } from '../lib/http.ts';
import { isValidVariantId } from '../lib/shop.ts';
import { isBridgeError } from '../types.ts';
import type { CatalogEventQueue, CatalogSyncService, Logger, MatchService, Metrics } from '../types.ts';

/**
 * Fila em memória dos eventos de catálogo que chegam por webhook.
 *
 * Um webhook de produto é tratado só como aviso de que o produto mudou: o conteúdo é relido
 * pela Admin API (o corpo do webhook não é confiável nem completo, AC-68). Como a Shopify
 * costuma mandar vários avisos seguidos do mesmo produto, eles são agrupados por
 * (loja, produto) e viram UMA releitura depois de uma janela curta.
 *
 * A fila não é durável de propósito: entrega de webhook não é garantida (AC-66) e a
 * sincronização completa periódica já corrige qualquer evento perdido, inclusive os que se
 * perdem aqui em reinício, estouro do limite ou falha repetida.
 *
 * Limites: uma loja é processada em série (duas releituras da mesma loja nunca correm
 * juntas) e no máximo MAX_PARALLEL_STORES lojas ao mesmo tempo, para não disputar o balde
 * de custo da Admin API nem o processo.
 */

export const DEFAULT_DEBOUNCE_MS = 5000;
export const DEFAULT_REMATCH_DEBOUNCE_MS = 10_000;
/**
 * Quantas vezes seguidas o recálculo pode ser adiado por encontrar a loja ocupada. Passado
 * isso ele roda mesmo com releituras em curso: numa enxurrada longa (importação de
 * produtos, edição de preços em massa) os produtos já relidos ficariam sem mapeamento até
 * a fila esvaziar. O atraso máximo é rematchDebounceMs * (MAX_REMATCH_DEFERRALS + 1).
 */
export const MAX_REMATCH_DEFERRALS = 5;
/** Espera antes da única nova tentativa de uma releitura que falhou. */
export const RETRY_DELAY_MS = 30_000;
/** Teto de produtos pendentes somando todas as lojas. O que passa disso é descartado. */
export const MAX_PENDING = 10_000;
export const MAX_PARALLEL_STORES = 2;

export interface QueueTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface CatalogEventQueueDeps {
  sync: CatalogSyncService;
  matcher: MatchService;
  logger: Logger;
  metrics: Metrics;
  debounceMs?: number;
  rematchDebounceMs?: number;
  timers?: QueueTimers;
}

/**
 * debouncing: esperando a janela de agrupamento.   ready: na vez de rodar, aguardando vaga.
 * running: releitura em curso.                      retry_wait: falhou uma vez, aguardando.
 */
type Phase = 'debouncing' | 'ready' | 'running' | 'retry_wait';

/** O identificador do timer vem embrulhado porque um timer falso pode devolver 0 ou undefined. */
interface TimerRef {
  handle: unknown;
}

interface Entry {
  key: string;
  storeId: string;
  productId: string;
  phase: Phase;
  timer: TimerRef | null;
  attempt: number;
  /** Chegou evento novo enquanto a releitura corria: o que foi lido pode já estar velho. */
  dirty: boolean;
}

interface StoreState {
  storeId: string;
  ready: Entry[];
  running: boolean;
  /** Está na fila de espera por uma vaga de execução. */
  waiting: boolean;
  /** Quantas entradas pendentes pertencem a esta loja (para liberar o estado quando zera). */
  entries: number;
  rematchTimer: TimerRef | null;
  /** O catálogo da loja mudou desde o último recálculo de mapeamentos. */
  rematchDue: boolean;
  /** Adiamentos seguidos do recálculo por loja ocupada (zera quando ele roda). */
  rematchDeferrals: number;
}

// Os timers reais não seguram o processo aberto: no desligamento quem manda é stop().
const realTimers: QueueTimers = {
  setTimeout: (fn, ms) => {
    const handle = globalThis.setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function delayOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 100;
}

/** A mensagem só entra no log quando o erro é nosso; a de terceiros pode trazer trechos de resposta. */
function errorInfo(err: unknown): Record<string, unknown> {
  return {
    errorName: err instanceof Error ? err.name : typeof err,
    code: isBridgeError(err) ? err.code : undefined,
    errorMessage: isBridgeError(err) ? truncate(err.message, 300) : undefined,
  };
}

export function createCatalogEventQueue(deps: CatalogEventQueueDeps): CatalogEventQueue {
  const { sync, matcher, logger, metrics } = deps;
  const timers = deps.timers ?? realTimers;
  const debounceMs = delayOr(deps.debounceMs, DEFAULT_DEBOUNCE_MS);
  const rematchDebounceMs = delayOr(deps.rematchDebounceMs, DEFAULT_REMATCH_DEBOUNCE_MS);

  const pending = new Map<string, Entry>();
  const stores = new Map<string, StoreState>();
  /** Lojas com trabalho pronto esperando vaga, em ordem de chegada. */
  const waitingStores: StoreState[] = [];
  const idleWaiters: Array<() => void> = [];
  let active = 0;
  let rematchTimers = 0;
  let stopped = false;
  /** Evita um log por evento descartado durante uma enxurrada; a métrica conta todos. */
  let overflowLogged = false;

  function stateOf(storeId: string): StoreState {
    let state = stores.get(storeId);
    if (!state) {
      state = {
        storeId,
        ready: [],
        running: false,
        waiting: false,
        entries: 0,
        rematchTimer: null,
        rematchDue: false,
        rematchDeferrals: 0,
      };
      stores.set(storeId, state);
    }
    return state;
  }

  function releaseIfUnused(state: StoreState): void {
    if (state.running || state.waiting || state.entries > 0 || state.rematchTimer !== null || state.rematchDue) return;
    if (stores.get(state.storeId) === state) stores.delete(state.storeId);
  }

  function isIdle(): boolean {
    return pending.size === 0 && active === 0 && rematchTimers === 0;
  }

  function checkIdle(): void {
    if (idleWaiters.length === 0 || !isIdle()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function cancelTimer(ref: TimerRef | null): void {
    if (ref === null) return;
    try {
      timers.clearTimeout(ref.handle);
    } catch {
      // Um timer que não pôde ser cancelado dispara e é ignorado pelas guardas do callback.
    }
  }

  function arm(entry: Entry, phase: 'debouncing' | 'retry_wait', ms: number): void {
    entry.phase = phase;
    const ref: TimerRef = { handle: undefined };
    entry.timer = ref;
    ref.handle = timers.setTimeout(() => {
      // Guardas: fila parada, entrada cancelada ou timer já substituído.
      if (stopped || pending.get(entry.key) !== entry || entry.timer !== ref) return;
      entry.timer = null;
      entry.phase = 'ready';
      const state = stateOf(entry.storeId);
      state.ready.push(entry);
      enqueueStore(state);
      pump();
    }, ms);
  }

  function removeEntry(entry: Entry): void {
    if (pending.get(entry.key) !== entry) return;
    pending.delete(entry.key);
    const state = stores.get(entry.storeId);
    if (state) state.entries = Math.max(0, state.entries - 1);
    if (pending.size < MAX_PENDING) overflowLogged = false;
    metrics.gauge('bridge_catalog_queue_pending', pending.size);
  }

  function enqueueStore(state: StoreState): void {
    if (stopped || state.running || state.waiting || state.ready.length === 0) return;
    state.waiting = true;
    waitingStores.push(state);
  }

  /** Dá vaga às lojas em espera. Cada vaga roda UMA releitura e a loja volta ao fim da fila. */
  function pump(): void {
    while (!stopped && active < MAX_PARALLEL_STORES) {
      const state = waitingStores.shift();
      if (!state) return;
      state.waiting = false;
      const entry = state.ready.shift();
      if (!entry) {
        releaseIfUnused(state);
        continue;
      }
      void runEntry(state, entry);
    }
  }

  async function runEntry(state: StoreState, entry: Entry): Promise<void> {
    state.running = true;
    active += 1;
    entry.phase = 'running';
    let ok = false;
    let failure: unknown;
    try {
      await sync.refreshProduct(entry.storeId, entry.productId);
      ok = true;
    } catch (err) {
      failure = err;
    }
    state.running = false;
    active -= 1;
    try {
      settle(state, entry, ok, failure);
    } catch (err) {
      // Nada aqui pode virar rejeição sem tratamento: a entrada é abandonada e a
      // sincronização periódica cobre o produto.
      removeEntry(entry);
      logger.error({ storeId: entry.storeId, productId: entry.productId, ...errorInfo(err) }, 'falha interna na fila de catálogo');
    }
    enqueueStore(state);
    pump();
    releaseIfUnused(state);
    checkIdle();
  }

  function settle(state: StoreState, entry: Entry, ok: boolean, failure: unknown): void {
    if (stopped) return;
    const context = { storeId: entry.storeId, productId: entry.productId };
    metrics.inc('bridge_catalog_queue_refresh_total', { result: ok ? 'ok' : 'error' });
    if (ok) state.rematchDue = true;

    if (entry.dirty) {
      // Evento novo durante a releitura (ou exclusão, veja productDeleted): lê de novo,
      // como se fosse um evento recém-chegado.
      entry.dirty = false;
      entry.attempt = 0;
      arm(entry, 'debouncing', debounceMs);
    } else if (ok) {
      removeEntry(entry);
    } else if (entry.attempt === 0) {
      entry.attempt = 1;
      logger.warn({ ...context, retryInMs: RETRY_DELAY_MS, ...errorInfo(failure) }, 'releitura de produto falhou; nova tentativa agendada');
      arm(entry, 'retry_wait', RETRY_DELAY_MS);
    } else {
      removeEntry(entry);
      metrics.inc('bridge_catalog_queue_dropped_total', { reason: 'retry_exhausted' });
      logger.error(
        { ...context, ...errorInfo(failure) },
        'releitura de produto falhou de novo; evento descartado (a sincronização periódica corrige)',
      );
    }
    armRematch(state);
  }

  /**
   * Agenda o recálculo dos mapeamentos da loja. Pedidos repetidos dentro da janela caem no
   * mesmo timer: o primeiro pedido fixa o prazo. Se, no prazo, a loja ainda tem releitura
   * em curso ou na vez, o recálculo é adiado por mais uma janela (recalcular agora seria
   * trabalho repetido logo em seguida), mas só até MAX_REMATCH_DEFERRALS vezes seguidas:
   * depois disso ele roda com a loja ocupada mesmo, para uma sequência longa de eventos não
   * deixar os produtos já relidos sem mapeamento até a fila esvaziar.
   */
  function armRematch(state: StoreState): void {
    if (stopped || !state.rematchDue || state.rematchTimer !== null) return;
    const ref: TimerRef = { handle: undefined };
    state.rematchTimer = ref;
    rematchTimers += 1;
    ref.handle = timers.setTimeout(() => {
      if (stopped || state.rematchTimer !== ref) return;
      state.rematchTimer = null;
      rematchTimers -= 1;
      const busy = state.running || state.ready.length > 0;
      if (busy && state.rematchDeferrals < MAX_REMATCH_DEFERRALS) {
        // rematchDue continua ligado; a nova janela começa agora.
        state.rematchDeferrals += 1;
        armRematch(state);
      } else {
        runRematch(state);
      }
      releaseIfUnused(state);
      checkIdle();
    }, rematchDebounceMs);
  }

  /**
   * Roda o recálculo agora. Pode correr com uma releitura da mesma loja em andamento: o
   * recálculo é síncrono e cada releitura grava o produto numa única transação, então ele
   * sempre vê um catálogo consistente; o que a releitura gravar depois agenda outro.
   */
  function runRematch(state: StoreState): void {
    state.rematchDue = false;
    state.rematchDeferrals = 0;
    try {
      matcher.rematchStore(state.storeId);
      metrics.inc('bridge_catalog_queue_rematch_total', { result: 'ok' });
    } catch (err) {
      // Sem nova tentativa: o próximo evento da loja ou a sincronização periódica recalcula.
      metrics.inc('bridge_catalog_queue_rematch_total', { result: 'error' });
      logger.error({ storeId: state.storeId, ...errorInfo(err) }, 'recálculo de mapeamentos após webhook falhou');
    }
  }

  function productChanged(storeId: string, productId: string): void {
    if (stopped) return;
    // Um ID que a Admin API recusaria não vale uma releitura nem uma nova tentativa.
    if (!validId(storeId) || !validId(productId) || !isValidVariantId(productId)) {
      logger.debug({ storeId: validId(storeId) ? storeId : null }, 'evento de catálogo com identificador inválido ignorado');
      return;
    }
    const key = `${storeId}\n${productId}`;
    const existing = pending.get(key);
    if (existing) {
      // Esperando a janela, a vez ou a nova tentativa: a leitura que vem já pega o estado
      // atual. Só uma releitura em curso pode ter lido antes desta mudança.
      if (existing.phase === 'running') existing.dirty = true;
      metrics.inc('bridge_catalog_queue_coalesced_total');
      return;
    }
    if (pending.size >= MAX_PENDING) {
      metrics.inc('bridge_catalog_queue_dropped_total', { reason: 'overflow' });
      if (!overflowLogged) {
        overflowLogged = true;
        logger.warn(
          { storeId, pending: pending.size, max: MAX_PENDING },
          'fila de catálogo cheia; eventos descartados até esvaziar (a sincronização periódica corrige)',
        );
      }
      return;
    }
    const entry: Entry = { key, storeId, productId, phase: 'debouncing', timer: null, attempt: 0, dirty: false };
    pending.set(key, entry);
    stateOf(storeId).entries += 1;
    metrics.gauge('bridge_catalog_queue_pending', pending.size);
    arm(entry, 'debouncing', debounceMs);
  }

  function productDeleted(storeId: string, productId: string): void {
    if (stopped) return;
    if (!validId(storeId) || !validId(productId)) return;
    const state = stateOf(storeId);
    const entry = pending.get(`${storeId}\n${productId}`);
    if (entry) {
      if (entry.phase === 'running') {
        // A releitura em curso pode ter lido o produto antes da exclusão e regravá-lo
        // depois da remoção abaixo. Marcar como alterado força mais uma leitura, que
        // encontra o produto inexistente e o remove de vez.
        entry.dirty = true;
      } else {
        // Releitura que ainda não começou perdeu o sentido: o produto não existe mais.
        cancelTimer(entry.timer);
        entry.timer = null;
        const index = state.ready.indexOf(entry);
        if (index >= 0) state.ready.splice(index, 1);
        removeEntry(entry);
      }
    }
    try {
      // Remoção é local e síncrona; não espera a vez da loja.
      sync.removeProduct(storeId, productId);
      metrics.inc('bridge_catalog_queue_removed_total', { result: 'ok' });
      state.rematchDue = true;
      armRematch(state);
    } catch (err) {
      metrics.inc('bridge_catalog_queue_removed_total', { result: 'error' });
      logger.error({ storeId, productId, ...errorInfo(err) }, 'remoção de produto do catálogo falhou');
    }
    releaseIfUnused(state);
    checkIdle();
  }

  function idle(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  /**
   * Cancela tudo o que ainda não começou. Uma releitura já em curso termina (não há como
   * abortá-la pela porta), mas o resultado não agenda mais nada; idle() resolve quando ela
   * acabar.
   */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const entry of pending.values()) cancelTimer(entry.timer);
    for (const state of stores.values()) cancelTimer(state.rematchTimer);
    pending.clear();
    stores.clear();
    waitingStores.length = 0;
    rematchTimers = 0;
    checkIdle();
  }

  return { productChanged, productDeleted, idle, stop };
}
