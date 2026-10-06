import { isoNow } from '../lib/clock.ts';
import { REDACT_CENSOR, SENSITIVE_KEYS } from '../lib/logger.ts';
import { BridgeError } from '../types.ts';
import type { AdminSession, AdminSessionRepo, AuditEntry, AuditRepo, Clock, JobRunRepo, WebhookEventRepo } from '../types.ts';
import type { Db } from './db.ts';
import {
  clampLimit,
  clampOffset,
  invalid,
  isConstraintError,
  parseJsonObject,
  requireText,
  textOrNull,
  toIso,
} from './util.ts';

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_AUDIT_TEXT = 200;
const MAX_AUDIT_DETAIL_CHARS = 8000;

const SENSITIVE_LOWER = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/**
 * Serializa o detalhe da auditoria. O contrato diz que segredo não entra aqui; mesmo
 * assim as chaves sensíveis conhecidas são censuradas em qualquer profundidade, porque a
 * auditoria fica guardada por meses e é exibida no painel.
 */
function serializeDetail(detail: unknown): string {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return '{}';
  try {
    const json = JSON.stringify(detail, (key, value: unknown) => {
      if (key !== '' && SENSITIVE_LOWER.has(key.toLowerCase())) return REDACT_CENSOR;
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
    if (json === undefined) return '{}';
    if (json.length > MAX_AUDIT_DETAIL_CHARS) return JSON.stringify({ truncated: true });
    return json;
  } catch {
    // Referência circular ou getter que lança: a entrada é gravada sem o detalhe.
    return JSON.stringify({ unserializable: true });
  }
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max);
}

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string;
}

function mapAudit(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    at: row.at,
    actor: row.actor,
    action: row.action,
    targetType: textOrNull(row.target_type),
    targetId: textOrNull(row.target_id),
    detail: parseJsonObject(row.detail),
  };
}

export function createAuditRepo(db: Db, deps: { clock: Clock }): AuditRepo {
  const { clock } = deps;
  return {
    record(entry) {
      db.run('INSERT INTO audit_log (at, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)', [
        isoNow(clock),
        requireText(entry.actor, 'actor', MAX_AUDIT_TEXT),
        requireText(entry.action, 'action', MAX_AUDIT_TEXT),
        optionalText(entry.targetType, MAX_AUDIT_TEXT),
        optionalText(entry.targetId, MAX_AUDIT_TEXT),
        serializeDetail(entry.detail),
      ]);
    },

    list(opts) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.targetType !== undefined) {
        where.push('target_type = ?');
        params.push(opts.targetType);
      }
      if (opts.targetId !== undefined) {
        where.push('target_id = ?');
        params.push(opts.targetId);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      // O id cresce junto com o tempo de gravação; ordenar por ele dá "mais novo primeiro"
      // mesmo entre entradas do mesmo milissegundo.
      return db
        .all<AuditRow>(
          `SELECT id, at, actor, action, target_type, target_id, detail FROM audit_log ${clause}
           ORDER BY id DESC LIMIT ? OFFSET ?`,
          [...params, clampLimit(opts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT), clampOffset(opts.offset)],
        )
        .map(mapAudit);
    },

    purge(before) {
      return db.run('DELETE FROM audit_log WHERE at < ?', [toIso(before, 'before')]).changes;
    },
  };
}

export function createWebhookEventRepo(db: Db): WebhookEventRepo {
  return {
    markSeen(eventId, at) {
      if (typeof eventId !== 'string' || eventId === '') throw invalid('Identificador de evento ausente', { field: 'eventId' });
      // Um único statement: o SQLite decide de forma atômica se a linha entrou ou já
      // existia, sem janela entre "consultar" e "inserir".
      const result = db.run('INSERT INTO webhook_events (event_id, seen_at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING', [
        eventId,
        toIso(at, 'at'),
      ]);
      return result.changes === 0;
    },

    purge(before) {
      return db.run('DELETE FROM webhook_events WHERE seen_at < ?', [toIso(before, 'before')]).changes;
    },
  };
}

interface AdminSessionRow {
  id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}

export function createAdminSessionRepo(db: Db): AdminSessionRepo {
  return {
    create(session: AdminSession, tokenHash: string) {
      const values = [
        requireText(session.id, 'id', 200),
        requireText(tokenHash, 'tokenHash', 200),
        requireText(session.csrfToken, 'csrfToken', 500),
        toIso(session.createdAt, 'createdAt'),
        toIso(session.expiresAt, 'expiresAt'),
      ];
      try {
        db.run('INSERT INTO admin_sessions (id, token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', values);
      } catch (err) {
        if (isConstraintError(err, 'unique')) throw new BridgeError('conflict', 'Sessão administrativa duplicada');
        throw err;
      }
    },

    findByTokenHash(tokenHash, now) {
      if (typeof tokenHash !== 'string' || tokenHash === '') return null;
      // Sessão que expira exatamente "agora" já não vale.
      const row = db.get<AdminSessionRow>(
        'SELECT id, csrf_token, created_at, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
        [tokenHash, toIso(now, 'now')],
      );
      return row ? { id: row.id, csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at } : null;
    },

    delete(id) {
      db.run('DELETE FROM admin_sessions WHERE id = ?', [id]);
    },

    purgeExpired(before) {
      return db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [toIso(before, 'before')]).changes;
    },
  };
}

const MAX_JOB_NAME = 100;

/** Uma linha por tarefa; gravar de novo substitui o instante. */
export function createJobRunRepo(db: Db): JobRunRepo {
  return {
    getLastRunAt(job) {
      const row = db.get<{ last_run_at: string }>('SELECT last_run_at FROM job_runs WHERE job = ?', [
        requireText(job, 'job', MAX_JOB_NAME),
      ]);
      return row ? row.last_run_at : null;
    },

    setLastRunAt(job, at) {
      db.run('INSERT INTO job_runs (job, last_run_at) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at', [
        requireText(job, 'job', MAX_JOB_NAME),
        toIso(at, 'at'),
      ]);
    },
  };
}
