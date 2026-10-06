import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScheduler, MIN_SYNC_START_DELAY_MS, RESYNC_JOB, START_PURGE_DELAY_MS } from '../src/jobs/scheduler.ts';
import type { SchedulerTimers } from '../src/jobs/scheduler.ts';
import { createLogger } from '../src/lib/logger.ts';
import type { CatalogSyncService, MatchService, Store, SyncResult, WebhookRegistrar } from '../src/types.ts';
import { makeSession, makeStore, setup } from './db-helpers.ts';

/**
 * Agendador com timers manuais e serviços falsos: ordem das etapas por loja, lojas
 * desativadas de fora, erro de webhook ignorado, sem sobreposição, stop() idempotente e a
 * limpeza de retenção.
 */

/** Timers que guardam o atraso pedido, para disparar só os curtos e conferir o agendamento. */
function recordingTimers(): SchedulerTimers & { flush(maxDelayMs?: number): void; delays(): number[]; size(): number } {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    /** Dispara os timers pendentes com atraso até `maxDelayMs` (os armados durante o disparo ficam para a próxima). */
    flush(maxDelayMs = Number.POSITIVE_INFINITY) {
      for (const [id, entry] of [...pending]) {
        if (entry.ms > maxDelayMs) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    delays: () => [...pending.values()].map((entry) => entry.ms).sort((a, b) => a - b),
    size: () => pending.size,
  };
}

interface Calls {
  webhooks: string[];
  sync: string[];
  rematch: string[];
}

function harness(opts: { resyncMinutes?: number; syncOk?: boolean; webhookFails?: string } = {}) {
  const ctx = setup();
  const timers = recordingTimers();
  const calls: Calls = { webhooks: [], sync: [], rematch: [] };
  let release: (() => void) | null = null;
  const sync: CatalogSyncService = {
    async syncStore(storeId): Promise<SyncResult> {
      calls.sync.push(storeId);
      // Permite segurar uma sincronização para testar a ausência de sobreposição.
      if (release === null) await new Promise<void>((resolve) => {
        release = resolve;
      });
      release = null;
      return { storeId, ok: opts.syncOk !== false, variants: 1, removed: 0, durationMs: 1, detail: opts.syncOk === false ? 'falhou' : null };
    },
    refreshProduct: async () => undefined,
    removeProduct: () => undefined,
    fetchShopInfo: async () => {
      throw new Error('não usado');
    },
  };
  const matcher: MatchService = {
    rematchPair: () => {
      throw new Error('não usado');
    },
    rematchStore(storeId) {
      calls.rematch.push(storeId);
      return [];
    },
  };
  const webhooks: WebhookRegistrar = {
    async ensure(store: Store) {
      calls.webhooks.push(store.id);
      if (store.shopDomain === opts.webhookFails) throw new Error('webhook indisponível');
      return { created: [], existing: [] };
    },
  };
  const scheduler = createScheduler({
    repos: ctx.repos,
    sync,
    matcher,
    webhooks,
    config: { catalogResyncMinutes: opts.resyncMinutes ?? 60, retentionDays: 30 },
    logger: createLogger({ level: 'silent', env: 'test' }),
    clock: ctx.clock,
    timers,
  });
  const releaseSync = (): void => {
    release?.();
  };
  return { ...ctx, timers, calls, scheduler, releaseSync };
}

/** Alguns giros do event loop, para as promessas dos falsos avançarem. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('agendador', () => {
  it('ressincroniza as lojas ativas em sequência: webhooks (erro ignorado), catálogo, mapeamentos', async () => {
    const h = harness({ webhookFails: 'loja-vitrine-1.myshopify.com' });
    // Instantes de criação distintos: a listagem ordena por created_at e desempata pelo id
    // aleatório, então lojas criadas no mesmo milissegundo sairiam em ordem imprevisível.
    const a = makeStore(h.repos, 'vitrine', { shopDomain: 'loja-vitrine-1.myshopify.com' });
    h.clock.advance(1000);
    const b = makeStore(h.repos, 'checkout');
    h.clock.advance(1000);
    const disabled = makeStore(h.repos, 'checkout');
    h.repos.stores.update(disabled.id, { status: 'disabled' });

    const run = h.scheduler.runSyncOnce();
    await settle();
    // A primeira loja está sincronizando (segurada); a segunda ainda não começou.
    assert.deepEqual(h.calls.webhooks, [a.id]);
    assert.deepEqual(h.calls.sync, [a.id]);
    assert.deepEqual(h.calls.rematch, []);
    // Pedido concorrente devolve a mesma rodada, sem iniciar outra.
    assert.equal(h.scheduler.runSyncOnce(), run);
    h.releaseSync();
    await settle();
    assert.deepEqual(h.calls.rematch, [a.id]);
    assert.deepEqual(h.calls.sync, [a.id, b.id]);
    h.releaseSync();
    await run;
    assert.deepEqual(h.calls.webhooks, [a.id, b.id]);
    assert.deepEqual(h.calls.rematch, [a.id, b.id]);
    assert.ok(!h.calls.sync.includes(disabled.id));
  });

  it('catálogo que falha não recalcula os mapeamentos', async () => {
    const h = harness({ syncOk: false });
    const a = makeStore(h.repos, 'vitrine');
    const run = h.scheduler.runSyncOnce();
    await settle();
    h.releaseSync();
    await run;
    assert.deepEqual(h.calls.sync, [a.id]);
    assert.deepEqual(h.calls.rematch, []);
  });

  it('start agenda ressincronização e limpeza; 0 minutos desliga a ressincronização; stop é idempotente', async () => {
    const h = harness({ resyncMinutes: 15 });
    makeStore(h.repos, 'vitrine');
    h.scheduler.start();
    h.scheduler.start();
    assert.equal(h.timers.size(), 2);
    h.timers.flush();
    await settle();
    h.releaseSync();
    await settle();
    assert.equal(h.calls.sync.length, 1);
    // Terminada a rodada, a próxima fica agendada (e a limpeza diária foi reagendada).
    assert.equal(h.timers.size(), 2);
    h.scheduler.stop();
    h.scheduler.stop();
    assert.equal(h.timers.size(), 0);

    const off = harness({ resyncMinutes: 0 });
    off.scheduler.start();
    assert.equal(off.timers.size(), 1);
    off.scheduler.stop();
    assert.equal(off.timers.size(), 0);
  });

  it('na partida: limpeza 1 minuto depois; ressincronização só depois da espera mínima quando não há registro', async () => {
    const h = harness({ resyncMinutes: 60 });
    makeStore(h.repos, 'vitrine');
    const day = 24 * 60 * 60 * 1000;
    h.repos.audit.record({ actor: 'system', action: 'velha', targetType: null, targetId: null, detail: {} });
    h.clock.advance(31 * day);
    h.scheduler.start();
    assert.deepEqual(h.timers.delays(), [START_PURGE_DELAY_MS, MIN_SYNC_START_DELAY_MS]);
    h.timers.flush(START_PURGE_DELAY_MS);
    await settle();
    assert.equal(h.repos.audit.list({ limit: 10, offset: 0 }).length, 0, 'a limpeza deveria ter rodado logo após a partida');
    assert.deepEqual(h.calls.sync, [], 'a ressincronização não roda na partida');
    // A limpeza foi reagendada para dali a um dia; a ressincronização continua armada.
    assert.deepEqual(h.timers.delays(), [MIN_SYNC_START_DELAY_MS, day]);
    h.timers.flush(MIN_SYNC_START_DELAY_MS);
    await settle();
    h.releaseSync();
    await settle();
    assert.equal(h.calls.sync.length, 1);
    // A rodada concluída fica registrada e a próxima vale o intervalo inteiro.
    assert.equal(h.repos.jobRuns.getLastRunAt(RESYNC_JOB), h.clock.now().toISOString());
    assert.deepEqual(h.timers.delays(), [60 * 60_000, day]);
    h.scheduler.stop();
  });

  it('a primeira ressincronização depois de um reinício espera só o que faltava do intervalo', () => {
    const interval = 60 * 60_000;
    const h = harness({ resyncMinutes: 60 });
    h.repos.jobRuns.setLastRunAt(RESYNC_JOB, new Date(h.clock.now().getTime() - (interval - 5 * 60_000)).toISOString());
    h.scheduler.start();
    assert.deepEqual(h.timers.delays(), [START_PURGE_DELAY_MS, 5 * 60_000]);
    h.scheduler.stop();

    // Última rodada há mais tempo que o intervalo: espera mínima, nunca imediata.
    const late = harness({ resyncMinutes: 60 });
    late.repos.jobRuns.setLastRunAt(RESYNC_JOB, new Date(late.clock.now().getTime() - 3 * interval).toISOString());
    late.scheduler.start();
    assert.deepEqual(late.timers.delays(), [START_PURGE_DELAY_MS, MIN_SYNC_START_DELAY_MS]);
    late.scheduler.stop();

    // Registro no futuro (relógio que voltou): no máximo um intervalo.
    const skew = harness({ resyncMinutes: 60 });
    skew.repos.jobRuns.setLastRunAt(RESYNC_JOB, new Date(skew.clock.now().getTime() + 10 * interval).toISOString());
    skew.scheduler.start();
    assert.deepEqual(skew.timers.delays(), [START_PURGE_DELAY_MS, interval]);
    skew.scheduler.stop();
  });

  it('reinícios mais frequentes que o intervalo não adiam a ressincronização para sempre', async () => {
    const h = harness({ resyncMinutes: 60 });
    makeStore(h.repos, 'vitrine');
    // Três "partidas" separadas por 20 minutos: nenhuma chega a ficar um intervalo inteiro no ar.
    for (let boot = 0; boot < 3; boot += 1) {
      h.scheduler.start();
      h.timers.flush(MIN_SYNC_START_DELAY_MS);
      await settle();
      h.releaseSync();
      await settle();
      h.scheduler.stop();
      assert.equal(h.timers.size(), 0);
      h.clock.advance(20 * 60_000);
    }
    // A primeira partida ressincronizou (espera mínima); a segunda e a terceira foram agendadas para o
    // restante do intervalo (40 e 20 minutos), acima da espera mínima, e por isso não dispararam.
    assert.equal(h.calls.sync.length, 1);
    // Quarta partida: já se passou uma hora desde a rodada, então vale a espera mínima e ela roda.
    h.scheduler.start();
    assert.deepEqual(h.timers.delays(), [START_PURGE_DELAY_MS, MIN_SYNC_START_DELAY_MS]);
    h.timers.flush(MIN_SYNC_START_DELAY_MS);
    await settle();
    h.releaseSync();
    await settle();
    assert.equal(h.calls.sync.length, 2);
    h.scheduler.stop();
  });

  it('stop() e start() no meio de uma rodada não duplicam a cadeia de timers', async () => {
    const h = harness({ resyncMinutes: 15 });
    makeStore(h.repos, 'vitrine');
    h.scheduler.start();
    h.timers.flush();
    await settle();
    // A rodada está em curso (segurada).
    assert.equal(h.calls.sync.length, 1);
    h.scheduler.stop();
    h.scheduler.start();
    // start() armou um timer de ressincronização e um de limpeza...
    assert.equal(h.timers.size(), 2);
    h.releaseSync();
    await settle();
    // ...e o fim da rodada não armou um segundo timer de ressincronização.
    assert.equal(h.timers.size(), 2);
    h.scheduler.stop();
    assert.equal(h.timers.size(), 0);
  });

  it('runPurgeOnce apaga só o que passou da retenção e as sessões do painel expiradas', () => {
    const h = harness();
    const vitrine = makeStore(h.repos, 'vitrine');
    const checkout = makeStore(h.repos, 'checkout');
    const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const base = { vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, linkId: link.id, lines: [] };
    const now = h.clock.now().getTime();
    const day = 24 * 60 * 60 * 1000;
    h.repos.sessions.insertPending(makeSession({ ...base, idempotencyKey: 'velha', createdAt: new Date(now - 40 * day).toISOString(), expiresAt: new Date(now - 39 * day).toISOString() }), new Date(now - 40 * day).toISOString());
    h.repos.sessions.insertPending(makeSession({ ...base, idempotencyKey: 'recente', createdAt: new Date(now - day).toISOString(), expiresAt: new Date(now - day + 900_000).toISOString() }), new Date(now - day).toISOString());
    h.repos.audit.record({ actor: 'system', action: 'teste', targetType: null, targetId: null, detail: {} });
    h.repos.webhookEvents.markSeen('evento-velho', new Date(now - 10 * day).toISOString());
    h.repos.webhookEvents.markSeen('evento-novo', new Date(now - day).toISOString());
    h.repos.adminSessions.create({ id: 'as_1', csrfToken: 'c', createdAt: new Date(now - 2 * day).toISOString(), expiresAt: new Date(now - day).toISOString() }, 'hash-1');
    h.repos.adminSessions.create({ id: 'as_2', csrfToken: 'c', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + day).toISOString() }, 'hash-2');

    h.scheduler.runPurgeOnce();

    const remaining = h.repos.sessions.list({ limit: 10, offset: 0 }).map((s) => s.idempotencyKey);
    assert.deepEqual(remaining, ['recente']);
    assert.equal(h.repos.audit.list({ limit: 10, offset: 0 }).length, 1);
    // Evento antigo apagado volta a ser "novo"; o recente continua marcado.
    assert.equal(h.repos.webhookEvents.markSeen('evento-velho', new Date(now).toISOString()), false);
    assert.equal(h.repos.webhookEvents.markSeen('evento-novo', new Date(now).toISOString()), true);
    assert.equal(h.repos.adminSessions.findByTokenHash('hash-1', new Date(now - 36 * 60 * 60 * 1000).toISOString()), null);
    assert.ok(h.repos.adminSessions.findByTokenHash('hash-2', new Date(now).toISOString()) !== null);
  });
});
