import { isoNow } from '../lib/clock.ts';
import { fromMicros, toMicros } from '../lib/money.ts';
import type {
  Clock,
  MoneyByCurrency,
  OrderListOptions,
  OrderRecord,
  OrderRepo,
  SalesDay,
  SalesStats,
  SalesStoreTotals,
} from '../types.ts';
import type { Db } from './db.ts';
import { clampLimit, clampOffset, invalid, requireText, textOrNull, toIso } from './util.ts';

/**
 * Pedidos registrados a partir dos webhooks das lojas.
 *
 * Só entram aqui os campos do contrato OrderRecord: nunca nome, e-mail, telefone ou
 * endereço do comprador. A receita é calculada em JavaScript com aritmética decimal exata
 * (src/lib/money.ts): somar em SQL com REAL arredondaria centavos.
 */

const ORDER_COLUMNS = `
  store_id, order_id, order_name, created_at, currency, subtotal, total, total_refunded,
  financial_status, cancelled_at, line_count, bridge_session_id, vitrine_store_id, recorded_at`;

interface OrderRow {
  store_id: string;
  order_id: string;
  order_name: string;
  created_at: string;
  currency: string;
  subtotal: string;
  total: string;
  total_refunded: string;
  financial_status: string;
  cancelled_at: string | null;
  line_count: number;
  bridge_session_id: string | null;
  vitrine_store_id: string | null;
  recorded_at: string;
}

function mapOrder(row: OrderRow): OrderRecord {
  return {
    storeId: row.store_id,
    orderId: row.order_id,
    orderName: row.order_name,
    createdAt: row.created_at,
    currency: row.currency,
    subtotal: row.subtotal,
    total: row.total,
    totalRefunded: row.total_refunded,
    financialStatus: row.financial_status,
    cancelledAt: textOrNull(row.cancelled_at),
    lineCount: Number(row.line_count ?? 0),
    bridgeSessionId: textOrNull(row.bridge_session_id),
    vitrineStoreId: textOrNull(row.vitrine_store_id),
    recordedAt: row.recorded_at,
  };
}

/** Valor monetário validado: decimal canônico ou erro de entrada. */
function money(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(`Valor inválido em ${field}`, { field });
  try {
    return fromMicros(toMicros(value.trim()));
  } catch {
    throw invalid(`Valor inválido em ${field}`, { field });
  }
}

function addTo(target: Map<string, bigint>, currency: string, micros: bigint): void {
  target.set(currency, (target.get(currency) ?? 0n) + micros);
}

function toRecord(map: Map<string, bigint>): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const [currency, micros] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[currency] = fromMicros(micros);
  }
  return out;
}

/** Receita de um pedido: total menos reembolsos, nunca negativa. */
function netMicros(row: OrderRow): bigint {
  const net = toMicros(row.total) - toMicros(row.total_refunded);
  return net < 0n ? 0n : net;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Lista de dias UTC entre since e until (inclusive), para o gráfico não ter buracos. */
function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  const start = Date.UTC(Number(since.slice(0, 4)), Number(since.slice(5, 7)) - 1, Number(since.slice(8, 10)));
  const end = Date.UTC(Number(until.slice(0, 4)), Number(until.slice(5, 7)) - 1, Number(until.slice(8, 10)));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  // Limite generoso: um intervalo de anos vira uma lista grande demais para o painel.
  for (let t = start, n = 0; t <= end && n < 400; t += 86_400_000, n += 1) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function createOrderRepo(db: Db, deps: { clock: Clock }): OrderRepo {
  const { clock } = deps;

  function roleOf(storeId: string): 'vitrine' | 'checkout' {
    const row = db.get<{ role: string }>('SELECT role FROM stores WHERE id = ?', [storeId]);
    // Loja removida: o pedido continua contando como venda (era uma loja checkout, ou já
    // não há como saber; vazamento sem loja não tem utilidade no painel).
    return row?.role === 'vitrine' ? 'vitrine' : 'checkout';
  }

  return {
    upsert(order) {
      if (typeof order !== 'object' || order === null) throw invalid('Pedido inválido');
      const storeId = requireText(order.storeId, 'storeId', 100);
      const orderId = requireText(order.orderId, 'orderId', 40);
      if (!/^[0-9]{1,20}$/.test(orderId)) throw invalid('ID de pedido inválido', { field: 'orderId' });
      const createdAt = toIso(order.createdAt, 'createdAt');
      const currency = requireText(order.currency, 'currency', 3).toUpperCase();
      const lineCount = Number.isSafeInteger(order.lineCount) && order.lineCount >= 0 ? order.lineCount : 0;
      const cancelledAt = order.cancelledAt === null || order.cancelledAt === undefined ? null : toIso(order.cancelledAt, 'cancelledAt');
      db.run(
        `INSERT INTO orders (${ORDER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (store_id, order_id) DO UPDATE SET
           order_name = excluded.order_name, created_at = excluded.created_at, currency = excluded.currency,
           subtotal = excluded.subtotal, total = excluded.total,
           total_refunded = CASE WHEN excluded.total_refunded > orders.total_refunded THEN excluded.total_refunded ELSE orders.total_refunded END,
           financial_status = excluded.financial_status,
           cancelled_at = COALESCE(excluded.cancelled_at, orders.cancelled_at),
           line_count = excluded.line_count,
           bridge_session_id = COALESCE(excluded.bridge_session_id, orders.bridge_session_id),
           vitrine_store_id = COALESCE(excluded.vitrine_store_id, orders.vitrine_store_id),
           recorded_at = excluded.recorded_at`,
        [
          storeId,
          orderId,
          requireText(order.orderName, 'orderName', 60),
          createdAt,
          currency,
          money(order.subtotal, 'subtotal'),
          money(order.total, 'total'),
          money(order.totalRefunded ?? '0', 'totalRefunded'),
          typeof order.financialStatus === 'string' ? order.financialStatus.slice(0, 40) : '',
          cancelledAt,
          lineCount,
          textOrNull(order.bridgeSessionId),
          textOrNull(order.vitrineStoreId),
          isoNow(clock),
        ],
      );
    },

    get(storeId, orderId) {
      if (typeof storeId !== 'string' || typeof orderId !== 'string') return null;
      const row = db.get<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE store_id = ? AND order_id = ?`, [storeId, orderId]);
      return row ? mapOrder(row) : null;
    },

    addRefund(storeId, orderId, amount, at) {
      const value = toMicros(money(amount, 'amount'));
      if (value <= 0n) return;
      db.transaction(() => {
        const row = db.get<{ total_refunded: string }>(
          'SELECT total_refunded FROM orders WHERE store_id = ? AND order_id = ?',
          [storeId, orderId],
        );
        if (!row) return;
        const next = fromMicros(toMicros(row.total_refunded) + value);
        db.run('UPDATE orders SET total_refunded = ?, recorded_at = ? WHERE store_id = ? AND order_id = ?', [
          next,
          toIso(at, 'at'),
          storeId,
          orderId,
        ]);
      });
    },

    markCancelled(storeId, orderId, cancelledAt) {
      db.run('UPDATE orders SET cancelled_at = ?, recorded_at = ? WHERE store_id = ? AND order_id = ?', [
        toIso(cancelledAt, 'cancelledAt'),
        isoNow(clock),
        storeId,
        orderId,
      ]);
    },

    list(opts) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (typeof opts.storeId === 'string') { where.push('store_id = ?'); params.push(opts.storeId); }
      if (typeof opts.vitrineStoreId === 'string') { where.push('vitrine_store_id = ?'); params.push(opts.vitrineStoreId); }
      if (typeof opts.since === 'string') { where.push('created_at >= ?'); params.push(toIso(opts.since, 'since')); }
      if (typeof opts.until === 'string') { where.push('created_at <= ?'); params.push(toIso(opts.until, 'until')); }
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const limit = clampLimit(opts.limit, 500, 50);
      const offset = clampOffset(opts.offset);
      const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders ${clause}`, params)?.n ?? 0);
      const rows = db.all<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders ${clause} ORDER BY created_at DESC, order_id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );
      return { rows: rows.map(mapOrder), total };
    },

    stats(opts) {
      const since = toIso(opts.since, 'since');
      const until = toIso(opts.until, 'until');
      const params: Array<string> = [since, until];
      let clause = 'WHERE created_at >= ? AND created_at <= ?';
      if (typeof opts.storeId === 'string') { clause += ' AND store_id = ?'; params.push(opts.storeId); }
      const rows = db.all<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders ${clause} ORDER BY created_at`, params);

      const roles = new Map<string, 'vitrine' | 'checkout'>();
      const revenue = new Map<string, bigint>();
      const byStore = new Map<string, { orders: number; revenue: Map<string, bigint> }>();
      const byVitrine = new Map<string | null, { orders: number; revenue: Map<string, bigint> }>();
      const byDay = new Map<string, { orders: number; revenue: Map<string, bigint> }>();
      for (const day of daysBetween(since, until)) byDay.set(day, { orders: 0, revenue: new Map() });

      let orders = 0;
      let cancelled = 0;
      let leakedOrders = 0;
      for (const row of rows) {
        let role = roles.get(row.store_id);
        if (role === undefined) { role = roleOf(row.store_id); roles.set(row.store_id, role); }
        if (role === 'vitrine') { leakedOrders += 1; continue; }
        if (row.cancelled_at !== null && row.cancelled_at !== '') { cancelled += 1; continue; }
        orders += 1;
        const net = netMicros(row);
        addTo(revenue, row.currency, net);

        const store = byStore.get(row.store_id) ?? { orders: 0, revenue: new Map<string, bigint>() };
        store.orders += 1; addTo(store.revenue, row.currency, net); byStore.set(row.store_id, store);

        const vitrineKey = textOrNull(row.vitrine_store_id);
        const vitrine = byVitrine.get(vitrineKey) ?? { orders: 0, revenue: new Map<string, bigint>() };
        vitrine.orders += 1; addTo(vitrine.revenue, row.currency, net); byVitrine.set(vitrineKey, vitrine);

        const day = byDay.get(dayOf(row.created_at)) ?? { orders: 0, revenue: new Map<string, bigint>() };
        day.orders += 1; addTo(day.revenue, row.currency, net); byDay.set(dayOf(row.created_at), day);
      }

      const sumMicros = (m: Map<string, bigint>): bigint => [...m.values()].reduce((a, b) => a + b, 0n);
      const byCheckoutStore: SalesStoreTotals[] = [...byStore.entries()]
        .map(([storeId, v]) => ({ storeId, orders: v.orders, revenueByCurrency: toRecord(v.revenue), _sum: sumMicros(v.revenue) }))
        .sort((a, b) => (a._sum === b._sum ? b.orders - a.orders : a._sum > b._sum ? -1 : 1))
        .map(({ storeId, orders: n, revenueByCurrency }) => ({ storeId, orders: n, revenueByCurrency }));
      const daily: SalesDay[] = [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, v]) => ({ day, orders: v.orders, revenueByCurrency: toRecord(v.revenue) }));

      return {
        since,
        until,
        orders,
        cancelled,
        revenueByCurrency: toRecord(revenue),
        byCheckoutStore,
        byVitrine: [...byVitrine.entries()]
          .map(([vitrineStoreId, v]) => ({ vitrineStoreId, orders: v.orders, revenueByCurrency: toRecord(v.revenue) }))
          .sort((a, b) => b.orders - a.orders),
        daily,
        leakedOrders,
      } satisfies SalesStats;
    },

    purge(before) {
      return db.run('DELETE FROM orders WHERE created_at < ?', [toIso(before, 'before')]).changes;
    },
  };
}
