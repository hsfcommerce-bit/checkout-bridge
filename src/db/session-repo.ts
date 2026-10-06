import { BridgeError } from '../types.ts';
import type {
  BridgeErrorCode,
  CheckoutSession,
  SessionLine,
  SessionRepo,
  SessionStats,
  SessionStatus,
  SessionStrategy,
} from '../types.ts';
import type { Db } from './db.ts';
import {
  clampLimit,
  clampOffset,
  invalid,
  isConstraintError,
  parseJsonArray,
  requireEnum,
  textOrNull,
  toIso,
} from './util.ts';

const SESSION_STATUSES: readonly SessionStatus[] = ['pending', 'created', 'failed'];
const SESSION_STRATEGIES: readonly SessionStrategy[] = ['storefront_cart', 'permalink'];

/**
 * Tempo em que uma sessão 'pending' ainda conta como "em andamento". Passado isso, o
 * processo que a criou é dado como interrompido e uma nova tentativa pode prosseguir.
 */
const PENDING_GRACE_MS = 60_000;

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 50;

const SESSION_COLUMNS = `
  id, idempotency_key, vitrine_store_id, checkout_store_id, link_id, status, strategy, lines,
  country, checkout_url, cart_id, subtotal, currency, error_code, ip_hash, order_id, created_at, expires_at`;

/**
 * Regra de sessão "viva" (a mesma em findActiveByKey e insertPending): não expirada E
 * ('created' OU 'pending' criada há menos de 60 s). Nos limites: expires_at igual a
 * "agora" já é expirada, e 'pending' criada há exatamente 60 s já não conta.
 * Havendo mais de uma, a 'created' vem primeiro (já tem URL de checkout para devolver).
 */
const LIVE_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS} FROM checkout_sessions
  WHERE idempotency_key = ?
    AND expires_at > ?
    AND (status = 'created' OR (status = 'pending' AND created_at > ?))
  ORDER BY (status = 'created') DESC, created_at DESC, rowid DESC
  LIMIT 1`;

interface SessionRow {
  id: string;
  idempotency_key: string;
  vitrine_store_id: string;
  checkout_store_id: string;
  link_id: string;
  status: string;
  strategy: string | null;
  lines: string;
  country: string | null;
  checkout_url: string | null;
  cart_id: string | null;
  subtotal: string | null;
  currency: string | null;
  error_code: string | null;
  ip_hash: string | null;
  order_id: string | null;
  created_at: string;
  expires_at: string;
}

function mapLines(text: string): SessionLine[] {
  const out: SessionLine[] = [];
  for (const item of parseJsonArray(text)) {
    if (typeof item !== 'object' || item === null) continue;
    const { vitrineVariantId, checkoutVariantId, quantity } = item as Record<string, unknown>;
    if (typeof vitrineVariantId !== 'string' || typeof checkoutVariantId !== 'string') continue;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) continue;
    out.push({ vitrineVariantId, checkoutVariantId, quantity });
  }
  return out;
}

/**
 * JSON gravado na coluna lines: só os três campos do contrato, pela mesma regra da leitura
 * (mapLines). Propriedades de linha podem conter texto do comprador (personalização) e não
 * entram no histórico. Linha fora do contrato é recusada aqui, antes de qualquer chamada à
 * Shopify: gravá-la faria a leitura devolver um carrinho diferente do que foi enviado.
 */
function serializeLines(lines: unknown): string {
  if (!Array.isArray(lines)) return '[]';
  const out: SessionLine[] = [];
  for (const item of lines as unknown[]) {
    const line = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const { vitrineVariantId, checkoutVariantId, quantity } = line;
    if (
      typeof vitrineVariantId !== 'string' ||
      typeof checkoutVariantId !== 'string' ||
      typeof quantity !== 'number' ||
      !Number.isFinite(quantity)
    ) {
      throw invalid('Linha de sessão inválida', { field: 'lines' });
    }
    out.push({ vitrineVariantId, checkoutVariantId, quantity });
  }
  return JSON.stringify(out);
}

function mapSession(row: SessionRow): CheckoutSession {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    vitrineStoreId: row.vitrine_store_id,
    checkoutStoreId: row.checkout_store_id,
    linkId: row.link_id,
    status: row.status as SessionStatus,
    strategy: textOrNull(row.strategy) as SessionStrategy | null,
    lines: mapLines(row.lines),
    country: textOrNull(row.country),
    checkoutUrl: textOrNull(row.checkout_url),
    cartId: textOrNull(row.cart_id),
    subtotal: textOrNull(row.subtotal),
    currency: textOrNull(row.currency),
    errorCode: textOrNull(row.error_code) as BridgeErrorCode | null,
    ipHash: textOrNull(row.ip_hash),
    orderId: textOrNull(row.order_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`Campo obrigatório ausente: ${field}`, { field });
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Soma em um contador por chave. A chave vem do banco, então "__proto__" fica de fora. */
function bump(counters: Record<string, number>, key: string, amount: number): void {
  if (typeof key !== 'string' || key === '__proto__') return;
  counters[key] = (Object.hasOwn(counters, key) ? (counters[key] ?? 0) : 0) + amount;
}

export function createSessionRepo(db: Db): SessionRepo {
  function findActiveByKey(idempotencyKey: string, now: string): CheckoutSession | null {
    const nowIso = toIso(now, 'now');
    const pendingCutoff = new Date(Date.parse(nowIso) - PENDING_GRACE_MS).toISOString();
    const row = db.get<SessionRow>(LIVE_SESSION_SQL, [idempotencyKey, nowIso, pendingCutoff]);
    return row ? mapSession(row) : null;
  }

  function get(id: string): CheckoutSession | null {
    if (typeof id !== 'string') return null;
    const row = db.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM checkout_sessions WHERE id = ?`, [id]);
    return row ? mapSession(row) : null;
  }

  return {
    findActiveByKey,

    insertPending(session, now) {
      const id = requireId(session.id, 'id');
      const idempotencyKey = requireId(session.idempotencyKey, 'idempotencyKey');
      const values = [
        id,
        idempotencyKey,
        requireId(session.vitrineStoreId, 'vitrineStoreId'),
        requireId(session.checkoutStoreId, 'checkoutStoreId'),
        requireId(session.linkId, 'linkId'),
        serializeLines(session.lines),
        nullableText(session.country),
        nullableText(session.ipHash),
        toIso(session.createdAt, 'createdAt'),
        toIso(session.expiresAt, 'expiresAt'),
      ];
      // A consulta e o INSERT ficam na mesma transação IMMEDIATE: duas requisições com a
      // mesma chave não conseguem, as duas, concluir que "não existe sessão viva".
      return db.transaction(() => {
        const existing = findActiveByKey(idempotencyKey, now);
        if (existing) return { inserted: false, session: existing };
        try {
          // Entra sempre como 'pending' e sem resultado, qualquer que seja o conteúdo do
          // objeto recebido; o resultado só chega por markCreated/markFailed.
          db.run(
            `INSERT INTO checkout_sessions (
               id, idempotency_key, vitrine_store_id, checkout_store_id, link_id, status, lines,
               country, ip_hash, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
            values,
          );
        } catch (err) {
          if (isConstraintError(err, 'unique')) {
            throw new BridgeError('conflict', 'Já existe uma sessão com esse id', { sessionId: id });
          }
          throw err;
        }
        const inserted = get(id);
        if (!inserted) throw new BridgeError('internal', 'Sessão recém-criada não encontrada');
        return { inserted: true, session: inserted };
      });
    },

    markCreated(id, patch) {
      const result = db.run(
        `UPDATE checkout_sessions
         SET status = 'created', strategy = ?, checkout_url = ?, cart_id = ?, subtotal = ?, currency = ?,
             error_code = NULL
         WHERE id = ?`,
        [
          requireEnum(patch.strategy, SESSION_STRATEGIES, 'strategy'),
          requireId(patch.checkoutUrl, 'checkoutUrl'),
          nullableText(patch.cartId),
          nullableText(patch.subtotal),
          nullableText(patch.currency),
          id,
        ],
      );
      if (result.changes === 0) throw new BridgeError('not_found', 'Sessão não encontrada', { sessionId: String(id) });
    },

    markConverted(id, orderId, at) {
      if (typeof id !== 'string' || typeof orderId !== 'string' || orderId === '') return;
      // Idempotente: o mesmo pedido pode chegar por orders/create e orders/updated.
      db.run('UPDATE checkout_sessions SET order_id = ? WHERE id = ? AND (order_id IS NULL OR order_id = ?)', [
        orderId,
        id,
        orderId,
      ]);
      void at;
    },

    markFailed(id, errorCode) {
      const result = db.run("UPDATE checkout_sessions SET status = 'failed', error_code = ? WHERE id = ?", [
        requireId(errorCode, 'errorCode'),
        id,
      ]);
      if (result.changes === 0) throw new BridgeError('not_found', 'Sessão não encontrada', { sessionId: String(id) });
    },

    get,

    list(opts) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.vitrineStoreId !== undefined) {
        where.push('vitrine_store_id = ?');
        params.push(opts.vitrineStoreId);
      }
      if (opts.checkoutStoreId !== undefined) {
        where.push('checkout_store_id = ?');
        params.push(opts.checkoutStoreId);
      }
      if (opts.status !== undefined) {
        where.push('status = ?');
        params.push(requireEnum(opts.status, SESSION_STATUSES, 'status'));
      }
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      return db
        .all<SessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM checkout_sessions ${clause}
           ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
          [...params, clampLimit(opts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT), clampOffset(opts.offset)],
        )
        .map(mapSession);
    },

    stats(since) {
      const sinceIso = toIso(since, 'since');
      const stats: SessionStats = { since: sinceIso, created: 0, failed: 0, byError: {}, byCheckoutStore: {} };
      // Agrupa por status, código de erro e loja de uma vez; os totais saem da soma.
      const rows = db.all<{ status: string; error_code: string | null; checkout_store_id: string; n: number }>(
        `SELECT status, error_code, checkout_store_id, COUNT(*) AS n
         FROM checkout_sessions
         WHERE created_at >= ? AND status IN ('created', 'failed')
         GROUP BY status, error_code, checkout_store_id`,
        [sinceIso],
      );
      for (const row of rows) {
        const n = Number(row.n ?? 0);
        if (row.status === 'created') {
          stats.created += n;
          bump(stats.byCheckoutStore, row.checkout_store_id, n);
        } else {
          stats.failed += n;
          bump(stats.byError, row.error_code ?? 'internal', n);
        }
      }
      return stats;
    },

    purgeExpired(before) {
      return db.run('DELETE FROM checkout_sessions WHERE expires_at < ?', [toIso(before, 'before')]).changes;
    },

    scrubExpired(now) {
      return db.run(
        `UPDATE checkout_sessions
         SET checkout_url = NULL, cart_id = NULL
         WHERE status = 'created' AND expires_at < ? AND (checkout_url IS NOT NULL OR cart_id IS NOT NULL)`,
        [toIso(now, 'now')],
      ).changes;
    },
  };
}
