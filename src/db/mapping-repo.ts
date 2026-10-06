import { isoNow } from '../lib/clock.ts';
import { BridgeError } from '../types.ts';
import type {
  Clock,
  Divergence,
  DivergenceKind,
  MappingCounts,
  MappingRepo,
  MappingStatus,
  MatchMethod,
  VariantMapping,
} from '../types.ts';
import type { Db, SqlParams } from './db.ts';
import {
  chunk,
  clampLimit,
  clampOffset,
  fromBool,
  invalid,
  isConstraintError,
  LIKE_ESCAPE,
  likeContains,
  parseJsonArray,
  placeholders,
  requireEnum,
  searchText,
  textOrNull,
  toBool,
  uniqueStrings,
} from './util.ts';

const MAPPING_STATUSES: readonly MappingStatus[] = ['active', 'suggested', 'conflict', 'unmapped', 'disabled'];
const MATCH_METHODS: readonly MatchMethod[] = ['sku', 'barcode', 'handle_options', 'title_options', 'manual'];

const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_QUERY_CHARS = 200;

const MAPPING_COLUMNS = `
  m.vitrine_store_id, m.checkout_store_id, m.vitrine_variant_id, m.checkout_variant_id,
  m.status, m.method, m.candidates, m.divergences, m.locked, m.updated_at`;

/**
 * "Tem divergência": a coluna guarda um array JSON não vazio. O json_valid protege o
 * json_array_length de conteúdo corrompido (que a leitura defensiva trata como vazio).
 */
const IS_DIVERGENT = `(CASE WHEN json_valid(m.divergences) THEN json_array_length(m.divergences) > 0 ELSE 0 END)`;

/** O catálogo da vitrine entra só para busca e ordenação; mapeamento órfão continua listado. */
const CATALOG_JOIN = `
  LEFT JOIN catalog_variants cv
    ON cv.store_id = m.vitrine_store_id AND cv.variant_id = m.vitrine_variant_id`;

/**
 * Gravação do casamento automático. Linha existente com locked = 1 (decisão manual)
 * mantém destino, status, método, candidatos e a trava; só divergências e data mudam.
 * Nos demais casos a linha é substituída por inteiro.
 */
const UPSERT_AUTO_SQL = `
  INSERT INTO variant_mappings (
    vitrine_store_id, checkout_store_id, vitrine_variant_id, checkout_variant_id,
    status, method, candidates, divergences, locked, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (vitrine_store_id, checkout_store_id, vitrine_variant_id) DO UPDATE SET
    checkout_variant_id = CASE WHEN variant_mappings.locked = 1 THEN variant_mappings.checkout_variant_id ELSE excluded.checkout_variant_id END,
    status = CASE WHEN variant_mappings.locked = 1 THEN variant_mappings.status ELSE excluded.status END,
    method = CASE WHEN variant_mappings.locked = 1 THEN variant_mappings.method ELSE excluded.method END,
    candidates = CASE WHEN variant_mappings.locked = 1 THEN variant_mappings.candidates ELSE excluded.candidates END,
    locked = CASE WHEN variant_mappings.locked = 1 THEN 1 ELSE excluded.locked END,
    divergences = excluded.divergences,
    updated_at = excluded.updated_at`;

const UPSERT_MANUAL_SQL = `
  INSERT INTO variant_mappings (
    vitrine_store_id, checkout_store_id, vitrine_variant_id, checkout_variant_id,
    status, method, candidates, divergences, locked, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT (vitrine_store_id, checkout_store_id, vitrine_variant_id) DO UPDATE SET
    checkout_variant_id = excluded.checkout_variant_id,
    status = excluded.status,
    method = excluded.method,
    candidates = excluded.candidates,
    divergences = excluded.divergences,
    locked = 1,
    updated_at = excluded.updated_at`;

interface MappingRow {
  vitrine_store_id: string;
  checkout_store_id: string;
  vitrine_variant_id: string;
  checkout_variant_id: string | null;
  status: string;
  method: string | null;
  candidates: string;
  divergences: string;
  locked: number;
  updated_at: string;
}

function mapDivergences(text: string): Divergence[] {
  const out: Divergence[] = [];
  for (const item of parseJsonArray(text)) {
    if (typeof item !== 'object' || item === null) continue;
    const { kind, vitrine, checkout } = item as { kind?: unknown; vitrine?: unknown; checkout?: unknown };
    if (typeof kind !== 'string') continue;
    out.push({ kind: kind as DivergenceKind, vitrine: String(vitrine ?? ''), checkout: String(checkout ?? '') });
  }
  return out;
}

function mapMapping(row: MappingRow): VariantMapping {
  return {
    vitrineStoreId: row.vitrine_store_id,
    checkoutStoreId: row.checkout_store_id,
    vitrineVariantId: row.vitrine_variant_id,
    checkoutVariantId: textOrNull(row.checkout_variant_id),
    status: row.status as MappingStatus,
    method: textOrNull(row.method) as MatchMethod | null,
    candidates: parseJsonArray(row.candidates).filter((c): c is string => typeof c === 'string'),
    divergences: mapDivergences(row.divergences),
    locked: toBool(row.locked),
    updatedAt: row.updated_at,
  };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`Campo obrigatório ausente: ${field}`, { field });
  return value;
}

export function createMappingRepo(db: Db, deps: { clock: Clock }): MappingRepo {
  const { clock } = deps;

  /** Valores comuns às duas gravações, já validados e serializados. */
  function writeValues(mapping: VariantMapping): {
    keys: [string, string, string];
    checkoutVariantId: string | null;
    status: MappingStatus;
    method: MatchMethod | null;
    candidates: string;
    divergences: string;
    updatedAt: string;
  } {
    const parsedAt = typeof mapping.updatedAt === 'string' ? Date.parse(mapping.updatedAt) : Number.NaN;
    const parsedIso = Number.isNaN(parsedAt) ? '' : new Date(parsedAt).toISOString();
    return {
      keys: [
        requireId(mapping.vitrineStoreId, 'vitrineStoreId'),
        requireId(mapping.checkoutStoreId, 'checkoutStoreId'),
        requireId(mapping.vitrineVariantId, 'vitrineVariantId'),
      ],
      checkoutVariantId:
        mapping.checkoutVariantId === null || mapping.checkoutVariantId === undefined
          ? null
          : requireId(mapping.checkoutVariantId, 'checkoutVariantId'),
      status: requireEnum(mapping.status, MAPPING_STATUSES, 'status'),
      method:
        mapping.method === null || mapping.method === undefined ? null : requireEnum(mapping.method, MATCH_METHODS, 'method'),
      candidates: JSON.stringify(Array.isArray(mapping.candidates) ? uniqueStrings(mapping.candidates) : []),
      divergences: JSON.stringify(Array.isArray(mapping.divergences) ? mapping.divergences : []),
      // Data ausente ou ilegível não impede a gravação: vale o relógio do serviço. O mesmo
      // para anos fora de 0000-9999, que o toISOString() escreve com sinal e seis dígitos,
      // fora do formato de largura fixa que o esquema exige para as colunas de data.
      updatedAt: parsedIso.length === 24 ? parsedIso : isoNow(clock),
    };
  }

  function runWrite(sql: string, params: SqlParams, mapping: VariantMapping): void {
    try {
      db.run(sql, params);
    } catch (err) {
      if (isConstraintError(err, 'foreign_key')) {
        throw new BridgeError('store_not_found', 'Loja do mapeamento não encontrada', {
          vitrineStoreId: mapping.vitrineStoreId,
          checkoutStoreId: mapping.checkoutStoreId,
        });
      }
      throw err;
    }
  }

  return {
    get(vitrineStoreId, checkoutStoreId, vitrineVariantId) {
      const row = db.get<MappingRow>(
        `SELECT ${MAPPING_COLUMNS} FROM variant_mappings m
         WHERE m.vitrine_store_id = ? AND m.checkout_store_id = ? AND m.vitrine_variant_id = ?`,
        [vitrineStoreId, checkoutStoreId, vitrineVariantId],
      );
      return row ? mapMapping(row) : null;
    },

    getMany(vitrineStoreId, checkoutStoreId, vitrineVariantIds) {
      const found = new Map<string, VariantMapping>();
      for (const ids of chunk(uniqueStrings(vitrineVariantIds))) {
        const rows = db.all<MappingRow>(
          `SELECT ${MAPPING_COLUMNS} FROM variant_mappings m
           WHERE m.vitrine_store_id = ? AND m.checkout_store_id = ?
             AND m.vitrine_variant_id IN (${placeholders(ids.length)})`,
          [vitrineStoreId, checkoutStoreId, ...ids],
        );
        for (const row of rows) found.set(row.vitrine_variant_id, mapMapping(row));
      }
      return found;
    },

    listAll(vitrineStoreId, checkoutStoreId) {
      return db
        .all<MappingRow>(
          `SELECT ${MAPPING_COLUMNS} FROM variant_mappings m
           WHERE m.vitrine_store_id = ? AND m.checkout_store_id = ?
           ORDER BY m.vitrine_variant_id`,
          [vitrineStoreId, checkoutStoreId],
        )
        .map(mapMapping);
    },

    list(vitrineStoreId, checkoutStoreId, opts) {
      // Os fragmentos abaixo são todos texto fixo; o que varia entra por parâmetro.
      const where: string[] = ['m.vitrine_store_id = ?', 'm.checkout_store_id = ?'];
      const params: Array<string | number> = [vitrineStoreId, checkoutStoreId];
      if (opts.status !== undefined) {
        where.push('m.status = ?');
        params.push(requireEnum(opts.status, MAPPING_STATUSES, 'status'));
      }
      if (opts.divergentOnly === true) where.push(`${IS_DIVERGENT} = 1`);
      const query = searchText(opts.search, MAX_QUERY_CHARS);
      if (query !== '') {
        const pattern = likeContains(query);
        where.push(
          `(cv.product_title LIKE ? ${LIKE_ESCAPE} OR cv.variant_title LIKE ? ${LIKE_ESCAPE} OR cv.sku LIKE ? ${LIKE_ESCAPE})`,
        );
        params.push(pattern, pattern, pattern);
      }
      const from = `FROM variant_mappings m ${CATALOG_JOIN} WHERE ${where.join(' AND ')}`;

      const totalRow = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, params);
      const rows = db.all<MappingRow>(
        `SELECT ${MAPPING_COLUMNS} ${from}
         ORDER BY cv.product_title COLLATE NOCASE, cv.variant_title COLLATE NOCASE, m.vitrine_variant_id
         LIMIT ? OFFSET ?`,
        [...params, clampLimit(opts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT), clampOffset(opts.offset)],
      );
      return { rows: rows.map(mapMapping), total: Number(totalRow?.n ?? 0) };
    },

    counts(vitrineStoreId, checkoutStoreId) {
      const counts: MappingCounts = {
        active: 0,
        suggested: 0,
        conflict: 0,
        unmapped: 0,
        disabled: 0,
        divergent: 0,
        total: 0,
      };
      const rows = db.all<{ status: string; n: number; divergent: number | null }>(
        `SELECT m.status AS status, COUNT(*) AS n, SUM(${IS_DIVERGENT}) AS divergent
         FROM variant_mappings m
         WHERE m.vitrine_store_id = ? AND m.checkout_store_id = ?
         GROUP BY m.status`,
        [vitrineStoreId, checkoutStoreId],
      );
      for (const row of rows) {
        const n = Number(row.n ?? 0);
        counts.total += n;
        counts.divergent += Number(row.divergent ?? 0);
        const status = MAPPING_STATUSES.find((s) => s === row.status);
        if (status !== undefined) counts[status] += n;
      }
      return counts;
    },

    upsertAuto(mappings) {
      if (mappings.length === 0) return;
      db.transaction(() => {
        for (const mapping of mappings) {
          const v = writeValues(mapping);
          runWrite(
            UPSERT_AUTO_SQL,
            [
              ...v.keys,
              v.checkoutVariantId,
              v.status,
              v.method,
              v.candidates,
              v.divergences,
              fromBool(mapping.locked === true),
              v.updatedAt,
            ],
            mapping,
          );
        }
      });
    },

    setManual(mapping) {
      const v = writeValues(mapping);
      runWrite(
        UPSERT_MANUAL_SQL,
        [...v.keys, v.checkoutVariantId, v.status, v.method, v.candidates, v.divergences, v.updatedAt],
        mapping,
      );
    },

    unlock(vitrineStoreId, checkoutStoreId, vitrineVariantId) {
      // Só a trava muda. Destino, status, método, candidatos, divergências e updatedAt
      // ficam como estavam: quem regrava a linha (e a data) é o casamento automático que
      // vem em seguida. Destravar uma linha já destravada ou inexistente não faz nada.
      db.run(
        `UPDATE variant_mappings SET locked = 0
         WHERE vitrine_store_id = ? AND checkout_store_id = ? AND vitrine_variant_id = ?`,
        [vitrineStoreId, checkoutStoreId, vitrineVariantId],
      );
    },

    deleteMissing(vitrineStoreId, checkoutStoreId, keepVitrineVariantIds) {
      return db.transaction(() => {
        if (keepVitrineVariantIds.length === 0) {
          return db.run('DELETE FROM variant_mappings WHERE vitrine_store_id = ? AND checkout_store_id = ?', [
            vitrineStoreId,
            checkoutStoreId,
          ]).changes;
        }
        // NOT IN não pode ser quebrado em lotes (cada lote apagaria o que está nos
        // outros). A diferença é calculada aqui e a exclusão é que vai em lotes.
        const keep = new Set(keepVitrineVariantIds);
        const existing = db.all<{ id: string }>(
          'SELECT vitrine_variant_id AS id FROM variant_mappings WHERE vitrine_store_id = ? AND checkout_store_id = ?',
          [vitrineStoreId, checkoutStoreId],
        );
        const doomed = existing.map((row) => row.id).filter((id) => !keep.has(id));
        let removed = 0;
        for (const ids of chunk(doomed)) {
          removed += db.run(
            `DELETE FROM variant_mappings
             WHERE vitrine_store_id = ? AND checkout_store_id = ?
               AND vitrine_variant_id IN (${placeholders(ids.length)})`,
            [vitrineStoreId, checkoutStoreId, ...ids],
          ).changes;
        }
        return removed;
      });
    },

    deleteForStore(storeId) {
      db.run('DELETE FROM variant_mappings WHERE vitrine_store_id = ? OR checkout_store_id = ?', [storeId, storeId]);
    },
  };
}
