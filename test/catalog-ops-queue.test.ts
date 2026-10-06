import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCatalogEventQueue, MAX_PENDING, MAX_REMATCH_DEFERRALS } from '../src/catalog/queue.ts';
import { createLogger } from '../src/lib/logger.ts';
import { BridgeError } from '../src/types.ts';
import type { CatalogSyncService, MatchService, MetricLabels, Metrics, ShopInfo, Store, SyncResult } from '../src/types.ts';

const logger = createLogger({ level: 'silent', env: 'test' });

/** Timers falsos: nada dispara sem advance(). Empates disparam na ordem de criação. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        seq += 1;
        tasks.set(seq, { at: now + ms, fn });
        return seq;
      },
      clearTimeout: (handle: unknown): void => {
        tasks.delete(handle as number);
      },
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let nextId: number | null = null;
        for (const [id, task] of tasks) {
          if (task.at <= target && (nextId === null || task.at < (tasks.get(nextId)?.at ?? 0))) nextId = id;
        }
        if (nextId === null) break;
        const task = tasks.get(nextId);
        tasks.delete(nextId);
        if (!task) break;
        now = task.at;
        task.fn();
      }
      now = target;
    },
    count: () => tasks.size,
  };
}

interface RefreshCall {
  storeId: string;
  productId: string;
  resolve: () => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

/** Sincronização falsa: cada releitura fica pendente até o teste resolver ou rejeitar. */
function fakeSync() {
  const refreshes: RefreshCall[] = [];
  const removed: Array<{ storeId: string; productId: string }> = [];
  let removeError: unknown = null;
  const sync: CatalogSyncService = {
    syncStore: async (storeId): Promise<SyncResult> => ({ storeId, ok: true, variants: 0, removed: 0, durationMs: 0, detail: null }),
    refreshProduct: (storeId, productId) =>
      new Promise<void>((resolve, reject) => {
        const call: RefreshCall = {
          storeId,
          productId,
          settled: false,
          resolve: () => {
            call.settled = true;
            resolve();
          },
          reject: (err) => {
            call.settled = true;
            reject(err);
          },
        };
        refreshes.push(call);
      }),
    removeProduct: (storeId, productId) => {
      if (removeError !== null) throw removeError;
      removed.push({ storeId, productId });
    },
    fetchShopInfo: async (store: Store): Promise<ShopInfo> => ({
      name: store.name,
      currency: 'BRL',
      primaryDomainHost: null,
      myshopifyDomain: store.shopDomain,
    }),
  };
  return {
    sync,
    refreshes,
    removed,
    setRemoveError: (err: unknown) => {
      removeError = err;
    },
    inFlight: () => refreshes.filter((call) => !call.settled),
  };
}

function fakeMatcher() {
  const calls: string[] = [];
  let error: unknown = null;
  const matcher: MatchService = {
    rematchPair: () => {
      throw new Error('não usado');
    },
    rematchStore: (storeId) => {
      if (error !== null) throw error;
      calls.push(storeId);
      return [];
    },
  };
  return {
    matcher,
    calls,
    setError: (err: unknown) => {
      error = err;
    },
  };
}

function fakeMetrics() {
  const counts = new Map<string, number>();
  const key = (name: string, labels?: MetricLabels) => `${name}${labels ? JSON.stringify(labels) : ''}`;
  const metrics: Metrics = {
    inc: (name, labels, value = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + value),
    observe: () => {},
    gauge: () => {},
    render: () => '',
  };
  return { metrics, count: (name: string, labels?: MetricLabels) => counts.get(key(name, labels)) ?? 0 };
}

/** Deixa as promessas encadeadas da fila andarem (sem timers reais além de um tick). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function build(opts: { debounceMs?: number; rematchDebounceMs?: number } = {}) {
  const t = fakeTimers();
  const s = fakeSync();
  const m = fakeMatcher();
  const metrics = fakeMetrics();
  const queue = createCatalogEventQueue({
    sync: s.sync,
    matcher: m.matcher,
    logger,
    metrics: metrics.metrics,
    timers: t.timers,
    ...opts,
  });
  return { queue, t, s, m, metrics };
}

describe('fila de eventos de catálogo', () => {
  it('agrupa eventos do mesmo produto e relê uma vez após 5 s (padrão)', async () => {
    const { queue, t, s } = build();
    queue.productChanged('st_a', '1001');
    queue.productChanged('st_a', '1001');
    queue.productChanged('st_a', '1001');
    queue.productChanged('st_a', '1002');
    t.advance(4999);
    assert.equal(s.refreshes.length, 0);
    t.advance(1);
    // A loja é processada em série: o segundo produto espera o primeiro terminar.
    assert.deepEqual(s.refreshes.map((call) => call.productId), ['1001']);
    s.refreshes[0]?.resolve();
    await flush();
    assert.deepEqual(s.refreshes.map((call) => call.productId), ['1001', '1002']);
    s.refreshes[1]?.resolve();
    await flush();
    assert.equal(s.refreshes.length, 2);
  });

  it('a janela é fixada pelo primeiro evento; eventos seguintes não a adiam', () => {
    const { queue, t, s } = build();
    queue.productChanged('st_a', '1001');
    t.advance(4000);
    queue.productChanged('st_a', '1001');
    t.advance(1000);
    assert.equal(s.refreshes.length, 1);
  });

  it('processa no máximo duas lojas ao mesmo tempo', async () => {
    const { queue, t, s } = build({ debounceMs: 10 });
    queue.productChanged('st_a', '1');
    queue.productChanged('st_b', '2');
    queue.productChanged('st_c', '3');
    t.advance(10);
    assert.deepEqual(s.inFlight().map((call) => call.storeId), ['st_a', 'st_b']);
    s.refreshes[0]?.resolve();
    await flush();
    assert.deepEqual(s.inFlight().map((call) => call.storeId), ['st_b', 'st_c']);
    s.refreshes[1]?.resolve();
    s.refreshes[2]?.resolve();
    await flush();
    t.advance(10_000);
    await queue.idle();
  });

  it('reveza as lojas: uma loja com muitos produtos não monopoliza as vagas', async () => {
    const { queue, t, s } = build({ debounceMs: 10 });
    queue.productChanged('st_a', '1');
    queue.productChanged('st_a', '2');
    queue.productChanged('st_a', '3');
    queue.productChanged('st_b', '4');
    queue.productChanged('st_c', '5');
    t.advance(10);
    assert.deepEqual(s.inFlight().map((call) => call.storeId), ['st_a', 'st_b']);
    s.refreshes[0]?.resolve();
    await flush();
    // st_c estava esperando antes de st_a voltar para a fila.
    assert.deepEqual(s.inFlight().map((call) => `${call.storeId}:${call.productId}`), ['st_b:4', 'st_c:5']);
  });

  it('evento durante a releitura força uma nova releitura', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    t.advance(10);
    queue.productChanged('st_a', '1');
    s.refreshes[0]?.resolve();
    await flush();
    assert.equal(s.refreshes.length, 1);
    t.advance(10);
    assert.equal(s.refreshes.length, 2);
    s.refreshes[1]?.resolve();
    await flush();
    t.advance(20);
    assert.deepEqual(m.calls, ['st_a']);
    await queue.idle();
  });

  it('releitura que falha é repetida uma vez após 30 s e depois descartada', async () => {
    const { queue, t, s, m, metrics } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    t.advance(10);
    s.refreshes[0]?.reject(new BridgeError('upstream_unavailable', 'fora do ar'));
    await flush();
    t.advance(29_999);
    assert.equal(s.refreshes.length, 1);
    t.advance(1);
    assert.equal(s.refreshes.length, 2);
    s.refreshes[1]?.reject(new TypeError('fetch failed'));
    await flush();
    assert.equal(metrics.count('bridge_catalog_queue_dropped_total', { reason: 'retry_exhausted' }), 1);
    // Nada mudou no catálogo: nenhum recálculo é agendado e a fila fica ociosa.
    assert.equal(t.count(), 0);
    await queue.idle();
    t.advance(60_000);
    assert.deepEqual(m.calls, []);
    assert.equal(s.refreshes.length, 2);
  });

  it('nova tentativa bem-sucedida agenda o recálculo', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    t.advance(10);
    s.refreshes[0]?.reject(new Error('x'));
    await flush();
    t.advance(30_000);
    s.refreshes[1]?.resolve();
    await flush();
    t.advance(20);
    assert.deepEqual(m.calls, ['st_a']);
  });

  it('agrupa o recálculo de mapeamentos por loja após 10 s (padrão) e espera a loja ficar livre', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10 });
    queue.productChanged('st_a', '1');
    queue.productChanged('st_a', '2');
    queue.productChanged('st_b', '3');
    t.advance(10);
    const byProduct = (productId: string) => s.refreshes.find((call) => call.productId === productId);
    byProduct('1')?.resolve();
    await flush();
    // 1 terminou em t=10; o recálculo de st_a fica para t=10+10000.
    t.advance(9000);
    byProduct('2')?.resolve();
    await flush();
    // 2 terminou em t=9010: cai no mesmo timer. st_b ainda está relendo.
    t.advance(1000);
    assert.deepEqual(m.calls, ['st_a']);
    t.advance(50_000);
    assert.deepEqual(m.calls, ['st_a']);
    const b = s.refreshes.find((call) => call.storeId === 'st_b');
    b?.resolve();
    await flush();
    t.advance(10_000);
    assert.deepEqual(m.calls, ['st_a', 'st_b']);
    await queue.idle();
  });

  it('recálculo adiado enquanto a loja tem trabalho em curso', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    t.advance(10);
    s.refreshes[0]?.resolve();
    await flush();
    // Novo produto entra e começa a rodar antes do recálculo disparar.
    queue.productChanged('st_a', '2');
    t.advance(10);
    assert.equal(s.inFlight().length, 1);
    t.advance(10);
    assert.deepEqual(m.calls, []);
    s.refreshes[1]?.resolve();
    await flush();
    t.advance(20);
    assert.deepEqual(m.calls, ['st_a']);
  });

  it('falha no recálculo não derruba a fila', async () => {
    const { queue, t, s, m, metrics } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    m.setError(new Error('banco'));
    queue.productChanged('st_a', '1');
    t.advance(10);
    s.refreshes[0]?.resolve();
    await flush();
    t.advance(20);
    assert.equal(metrics.count('bridge_catalog_queue_rematch_total', { result: 'error' }), 1);
    await queue.idle();
  });

  it('exclusão remove na hora, cancela a releitura pendente e agenda o recálculo', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    queue.productDeleted('st_a', '1');
    assert.deepEqual(s.removed, [{ storeId: 'st_a', productId: '1' }]);
    t.advance(10);
    assert.equal(s.refreshes.length, 0);
    t.advance(10);
    assert.deepEqual(m.calls, ['st_a']);
    await queue.idle();
  });

  it('exclusão durante a releitura força mais uma leitura (que encontra o produto apagado)', async () => {
    const { queue, t, s } = build({ debounceMs: 10 });
    queue.productChanged('st_a', '1');
    t.advance(10);
    queue.productDeleted('st_a', '1');
    assert.equal(s.removed.length, 1);
    s.refreshes[0]?.resolve();
    await flush();
    t.advance(10);
    assert.equal(s.refreshes.length, 2);
  });

  it('falha na remoção é registrada e não lança', () => {
    const { queue, s, metrics } = build();
    s.setRemoveError(new Error('banco'));
    assert.doesNotThrow(() => queue.productDeleted('st_a', '1'));
    assert.equal(metrics.count('bridge_catalog_queue_removed_total', { result: 'error' }), 1);
  });

  it('limita os pendentes a 10.000 e conta o que descarta', () => {
    const { queue, t, metrics } = build();
    for (let i = 0; i < MAX_PENDING; i += 1) queue.productChanged('st_a', String(1 + i));
    assert.equal(t.count(), MAX_PENDING);
    queue.productChanged('st_b', '999999');
    queue.productChanged('st_b', '999998');
    assert.equal(t.count(), MAX_PENDING);
    assert.equal(metrics.count('bridge_catalog_queue_dropped_total', { reason: 'overflow' }), 2);
    // Produto já pendente continua sendo agrupado, não descartado.
    queue.productChanged('st_a', '1');
    assert.equal(metrics.count('bridge_catalog_queue_dropped_total', { reason: 'overflow' }), 2);
    queue.stop();
    assert.equal(t.count(), 0);
  });

  it('ignora identificadores inválidos', () => {
    const { queue, t } = build();
    queue.productChanged('st_a', 'gid://shopify/Product/1');
    queue.productChanged('', '1');
    queue.productChanged('st_a', '');
    assert.equal(t.count(), 0);
  });

  it('idle() resolve na hora quando não há nada e espera o trabalho e os timers', async () => {
    const { queue, t, s } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    await queue.idle();
    queue.productChanged('st_a', '1');
    let idle = false;
    const waiting = queue.idle().then(() => {
      idle = true;
    });
    t.advance(10);
    s.refreshes[0]?.resolve();
    await flush();
    assert.equal(idle, false, 'o recálculo ainda está agendado');
    t.advance(20);
    await waiting;
    assert.equal(idle, true);
  });

  it('stop() cancela timers, torna as chamadas seguintes inócuas e deixa a releitura em curso terminar', async () => {
    const { queue, t, s, m, metrics } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    queue.productChanged('st_b', '2');
    t.advance(10);
    queue.productChanged('st_c', '3');
    assert.equal(t.count(), 1);
    let idle = false;
    const waiting = queue.idle().then(() => {
      idle = true;
    });
    queue.stop();
    assert.equal(t.count(), 0);
    await flush();
    assert.equal(idle, false, 'duas releituras ainda em curso');
    queue.productChanged('st_d', '4');
    queue.productDeleted('st_a', '9');
    assert.equal(t.count(), 0);
    assert.equal(s.removed.length, 0);
    s.refreshes[0]?.resolve();
    s.refreshes[1]?.reject(new Error('x'));
    await flush();
    await waiting;
    assert.equal(idle, true);
    assert.equal(t.count(), 0, 'nem recálculo nem nova tentativa após stop()');
    t.advance(100_000);
    assert.deepEqual(m.calls, []);
    assert.equal(s.refreshes.length, 2);
    assert.equal(metrics.count('bridge_catalog_queue_dropped_total', { reason: 'retry_exhausted' }), 0);
  });

  it('enxurrada longa: o recálculo é adiado no máximo MAX_REMATCH_DEFERRALS vezes e roda com a loja ocupada', async () => {
    // CAT-01: antes, o recálculo só rodava quando a loja ficava livre; numa importação de
    // 200 produtos relidos em série, os já relidos ficavam sem mapeamento até a fila esvaziar.
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    const total = 10;
    for (let i = 1; i <= total; i += 1) queue.productChanged('st_a', String(i));
    t.advance(10);
    const byProduct = (productId: string) => s.refreshes.find((call) => call.productId === productId);
    // O produto 1 termina em t=10; os seguintes demoram mais que a janela do recálculo.
    byProduct('1')?.resolve();
    await flush();
    assert.equal(s.inFlight().length, 1, 'o produto 2 está em releitura');
    const deadline = 20 * (MAX_REMATCH_DEFERRALS + 1);
    t.advance(deadline - 1);
    assert.deepEqual(m.calls, [], 'enquanto cabe adiar, o recálculo espera a loja');
    t.advance(1);
    assert.deepEqual(m.calls, ['st_a'], 'esgotados os adiamentos, roda mesmo com releitura em curso');
    assert.equal(s.inFlight().length, 1, 'a releitura em curso não foi afetada');

    // A próxima releitura concluída agenda outro ciclo, com a contagem de adiamentos zerada.
    byProduct('2')?.resolve();
    await flush();
    t.advance(deadline - 1);
    assert.deepEqual(m.calls, ['st_a']);
    t.advance(1);
    assert.deepEqual(m.calls, ['st_a', 'st_a']);

    // Fila esvaziada: o recálculo final roda uma janela depois da última releitura.
    for (let i = 3; i <= total; i += 1) {
      byProduct(String(i))?.resolve();
      await flush();
    }
    assert.equal(s.refreshes.length, total);
    t.advance(20);
    assert.deepEqual(m.calls, ['st_a', 'st_a', 'st_a']);
    await queue.idle();
  });

  it('enxurrada curta: a loja fica livre antes de esgotar os adiamentos e o recálculo roda só uma vez', async () => {
    const { queue, t, s, m } = build({ debounceMs: 10, rematchDebounceMs: 20 });
    queue.productChanged('st_a', '1');
    queue.productChanged('st_a', '2');
    queue.productChanged('st_a', '3');
    t.advance(10);
    const byProduct = (productId: string) => s.refreshes.find((call) => call.productId === productId);
    byProduct('1')?.resolve();
    await flush();
    // Timer em t=30; o produto 2 ainda corre: primeiro adiamento (novo prazo t=50).
    t.advance(20);
    assert.deepEqual(m.calls, []);
    byProduct('2')?.resolve();
    await flush();
    byProduct('3')?.resolve();
    await flush();
    t.advance(20);
    assert.deepEqual(m.calls, ['st_a']);
    await queue.idle();
  });
});
