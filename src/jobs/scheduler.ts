import type { Config } from '../config.ts';
import { isoNow, systemClock } from '../lib/clock.ts';
import type { CatalogSyncService, Clock, Logger, MatchService, Metrics, Repos, WebhookRegistrar } from '../types.ts';

/**
 * Tarefas periódicas do serviço.
 *
 * - Ressincronização completa de catálogo a cada `catalogResyncMinutes` (0 desliga): para
 *   cada loja não desativada, em sequência, garante os webhooks (erro ignorado: a própria
 *   ressincronização é a rede de segurança deles), sincroniza o catálogo e recalcula os
 *   mapeamentos. Em sequência, e não em paralelo, para não disputar o limite de custo da
 *   Admin API com as releituras disparadas por webhook.
 *   O instante da última rodada concluída fica no banco (job_runs): na partida, a primeira
 *   rodada é agendada para o tempo que FALTAVA do intervalo, e não para um intervalo
 *   inteiro, senão um processo reiniciado com mais frequência que o intervalo nunca
 *   ressincronizaria. Nunca antes de MIN_SYNC_START_DELAY_MS depois da partida: um
 *   processo em laço de falha não pode martelar a Admin API a cada subida.
 * - Limpeza: sessões de checkout e auditoria mais antigas que `retentionDays`, eventos de
 *   webhook com mais de 7 dias e sessões do painel expiradas. Roda pouco depois de cada
 *   partida (é barata e idempotente) e, a partir daí, uma vez por dia.
 *
 * Nunca há duas execuções da mesma tarefa ao mesmo tempo, nem duas cadeias de timer da
 * mesma tarefa: a próxima só é agendada quando a atual termina e só se não houver um timer
 * já armado (start() depois de stop() no meio de uma rodada arma um, e o fim da rodada
 * não arma outro). Os timers são unref'd para não segurarem o processo no desligamento, e
 * stop() pode ser chamado mais de uma vez.
 */

export interface SchedulerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface SchedulerDeps {
  repos: Repos;
  sync: CatalogSyncService;
  matcher: MatchService;
  webhooks: WebhookRegistrar;
  config: Pick<Config, 'catalogResyncMinutes' | 'retentionDays'>;
  logger: Logger;
  metrics?: Metrics;
  clock?: Clock;
  timers?: SchedulerTimers;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Uma rodada de ressincronização de todas as lojas ativas. Não lança. */
  runSyncOnce(): Promise<void>;
  /** Uma rodada de limpeza. Não lança. */
  runPurgeOnce(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = DAY_MS;
const WEBHOOK_EVENT_RETENTION_MS = 7 * DAY_MS;
/** Espera entre a partida e a primeira limpeza. */
export const START_PURGE_DELAY_MS = 60_000;
/** Menor espera entre a partida e a primeira ressincronização. */
export const MIN_SYNC_START_DELAY_MS = 2 * 60_000;
/** Nome da tarefa de ressincronização em job_runs. */
export const RESYNC_JOB = 'catalog_resync';

const realTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => {
    const handle = globalThis.setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { repos, sync, matcher, webhooks, config, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const timers = deps.timers ?? realTimers;
  const syncIntervalMs = config.catalogResyncMinutes * 60_000;

  let running = false;
  let syncTimer: unknown = null;
  let purgeTimer: unknown = null;
  let syncInProgress: Promise<void> | null = null;
  let purgeInProgress = false;

  async function syncOneStore(storeId: string, shopDomain: string): Promise<void> {
    const store = repos.stores.get(storeId);
    // A loja pode ter sido apagada ou desativada enquanto as anteriores eram sincronizadas.
    if (store === null || store.status === 'disabled') return;
    try {
      await webhooks.ensure(store);
    } catch (err) {
      logger.warn({ storeId, shopDomain, errorName: errorName(err) }, 'ressincronização: webhooks não garantidos (ignorado)');
    }
    const result = await sync.syncStore(storeId);
    if (!result.ok) {
      // syncStore já alertou e gravou o detalhe na loja; aqui fica só o registro da rodada.
      logger.warn({ storeId, shopDomain, detail: result.detail }, 'ressincronização: catálogo falhou');
      return;
    }
    try {
      matcher.rematchStore(storeId);
    } catch (err) {
      logger.error({ storeId, shopDomain, errorName: errorName(err) }, 'ressincronização: recálculo dos mapeamentos falhou');
    }
  }

  /** Grava o fim da rodada; uma falha aqui não derruba nada (o agendamento só fica menos preciso). */
  function recordSyncRun(): void {
    try {
      repos.jobRuns.setLastRunAt(RESYNC_JOB, isoNow(clock));
    } catch (err) {
      logger.warn({ errorName: errorName(err) }, 'ressincronização: não foi possível gravar o instante da rodada');
    }
  }

  /**
   * `abortOnStop`: rodadas disparadas pelo timer param entre uma loja e outra quando stop()
   * é chamado (desligamento); uma rodada pedida à mão (runSyncOnce) vai até o fim.
   */
  async function runSync(abortOnStop: boolean): Promise<void> {
    const started = performance.now();
    let stores: Array<{ id: string; shopDomain: string }> = [];
    try {
      stores = repos.stores
        .list()
        .filter((store) => store.status !== 'disabled')
        .map((store) => ({ id: store.id, shopDomain: store.shopDomain }));
    } catch (err) {
      logger.error({ errorName: errorName(err) }, 'ressincronização: não foi possível listar as lojas');
      return;
    }
    let aborted = false;
    for (const store of stores) {
      if (abortOnStop && !running) {
        aborted = true;
        break;
      }
      try {
        await syncOneStore(store.id, store.shopDomain);
      } catch (err) {
        logger.error({ storeId: store.id, errorName: errorName(err) }, 'ressincronização: erro inesperado');
      }
    }
    // Uma rodada interrompida pelo desligamento não conta: na próxima partida ela é refeita.
    if (!aborted) recordSyncRun();
    const ms = Math.round(performance.now() - started);
    deps.metrics?.observe('bridge_resync_run_ms', ms);
    deps.metrics?.inc('bridge_resync_runs_total');
    logger.info({ stores: stores.length, ms, aborted }, 'ressincronização concluída');
  }

  function startRun(abortOnStop: boolean): Promise<void> {
    // Sem sobreposição: quem pede durante uma rodada recebe a promessa da rodada em curso.
    if (syncInProgress !== null) return syncInProgress;
    syncInProgress = runSync(abortOnStop).finally(() => {
      syncInProgress = null;
    });
    return syncInProgress;
  }

  function runSyncOnce(): Promise<void> {
    return startRun(false);
  }

  function runPurgeOnce(): void {
    if (purgeInProgress) return;
    purgeInProgress = true;
    try {
      const nowMs = clock.now().getTime();
      const retentionCutoff = new Date(nowMs - config.retentionDays * DAY_MS).toISOString();
      const webhookCutoff = new Date(nowMs - WEBHOOK_EVENT_RETENTION_MS).toISOString();
      const now = new Date(nowMs).toISOString();
      const removed = {
        sessions: repos.sessions.purgeExpired(retentionCutoff),
        // A URL do checkout leva a chave do carrinho: some assim que a sessão deixa de valer
        // para a idempotência, bem antes do fim da retenção.
        scrubbedSessions: repos.sessions.scrubExpired(now),
        audit: repos.audit.purge(retentionCutoff),
        webhookEvents: repos.webhookEvents.purge(webhookCutoff),
        adminSessions: repos.adminSessions.purgeExpired(now),
      };
      logger.info(removed, 'limpeza de retenção concluída');
    } catch (err) {
      logger.error({ errorName: errorName(err) }, 'limpeza de retenção falhou');
    } finally {
      purgeInProgress = false;
    }
  }

  /**
   * Espera até a primeira ressincronização depois da partida: o que faltava do intervalo
   * desde a última rodada concluída, nunca menos que MIN_SYNC_START_DELAY_MS nem mais que
   * um intervalo (relógio que voltou no tempo). Sem registro, só a espera mínima.
   */
  function firstSyncDelayMs(): number {
    let lastRunAt: string | null = null;
    try {
      lastRunAt = repos.jobRuns.getLastRunAt(RESYNC_JOB);
    } catch (err) {
      logger.warn({ errorName: errorName(err) }, 'ressincronização: não foi possível ler o instante da última rodada');
    }
    if (lastRunAt === null) return MIN_SYNC_START_DELAY_MS;
    const elapsed = clock.now().getTime() - Date.parse(lastRunAt);
    if (!Number.isFinite(elapsed)) return MIN_SYNC_START_DELAY_MS;
    return Math.max(MIN_SYNC_START_DELAY_MS, Math.min(syncIntervalMs, syncIntervalMs - elapsed));
  }

  function scheduleSync(delayMs: number): void {
    if (!running || syncIntervalMs <= 0) return;
    // Uma cadeia só: se start() já armou um timer durante a rodada, o fim dela não arma outro.
    if (syncTimer !== null) return;
    syncTimer = timers.setTimeout(() => {
      syncTimer = null;
      void startRun(true).finally(() => scheduleSync(syncIntervalMs));
    }, delayMs);
  }

  function schedulePurge(delayMs: number): void {
    if (!running || purgeTimer !== null) return;
    purgeTimer = timers.setTimeout(() => {
      purgeTimer = null;
      runPurgeOnce();
      schedulePurge(PURGE_INTERVAL_MS);
    }, delayMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      const firstSyncMs = syncIntervalMs > 0 ? firstSyncDelayMs() : null;
      if (firstSyncMs !== null) scheduleSync(firstSyncMs);
      schedulePurge(START_PURGE_DELAY_MS);
      logger.info(
        {
          catalogResyncMinutes: config.catalogResyncMinutes,
          retentionDays: config.retentionDays,
          firstResyncInMs: firstSyncMs,
          firstPurgeInMs: START_PURGE_DELAY_MS,
        },
        config.catalogResyncMinutes === 0 ? 'agendador iniciado (ressincronização desligada)' : 'agendador iniciado',
      );
    },
    stop() {
      if (!running) return;
      running = false;
      if (syncTimer !== null) timers.clearTimeout(syncTimer);
      if (purgeTimer !== null) timers.clearTimeout(purgeTimer);
      syncTimer = null;
      purgeTimer = null;
    },
    runSyncOnce,
    runPurgeOnce,
  };
}
