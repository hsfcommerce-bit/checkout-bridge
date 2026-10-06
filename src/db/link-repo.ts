import { isoNow } from '../lib/clock.ts';
import { randomId } from '../lib/crypto.ts';
import { isCountryCode, normalizeCountryCode } from '../lib/shop.ts';
import { BridgeError } from '../types.ts';
import type {
  Clock,
  Link,
  LinkKind,
  LinkPatch,
  LinkRepo,
  NewLink,
  ParityPolicy,
  SessionStrategy,
} from '../types.ts';
import type { Db } from './db.ts';
import {
  fromBool,
  invalid,
  isConstraintError,
  parseJsonArray,
  requireBoolean,
  requireEnum,
  requireIntInRange,
  toBool,
} from './util.ts';

const LINK_KINDS: readonly LinkKind[] = ['default', 'country'];
const PARITY_POLICIES: readonly ParityPolicy[] = ['block', 'warn', 'off'];
const STRATEGIES: readonly SessionStrategy[] = ['storefront_cart', 'permalink'];

/** Folga generosa: existem cerca de 250 códigos ISO 3166-1 alpha-2. */
const MAX_COUNTRIES = 300;

const LINK_COLUMNS = `
  id, vitrine_store_id, checkout_store_id, kind, countries, enabled, parity_policy,
  price_tolerance_bps, max_quantity_per_line, max_lines, strategy, allow_permalink_fallback,
  created_at, updated_at`;

interface LinkRow {
  id: string;
  vitrine_store_id: string;
  checkout_store_id: string;
  kind: string;
  countries: string;
  enabled: number;
  parity_policy: string;
  price_tolerance_bps: number;
  max_quantity_per_line: number;
  max_lines: number;
  strategy: string;
  allow_permalink_fallback: number;
  created_at: string;
  updated_at: string;
}

function mapLink(row: LinkRow): Link {
  return {
    id: row.id,
    vitrineStoreId: row.vitrine_store_id,
    checkoutStoreId: row.checkout_store_id,
    kind: row.kind as LinkKind,
    countries: parseJsonArray(row.countries).filter((c): c is string => typeof c === 'string' && isCountryCode(c)),
    enabled: toBool(row.enabled),
    parityPolicy: row.parity_policy as ParityPolicy,
    priceToleranceBps: Number(row.price_tolerance_bps),
    maxQuantityPerLine: Number(row.max_quantity_per_line),
    maxLines: Number(row.max_lines),
    strategy: row.strategy === 'permalink' ? 'permalink' : 'storefront_cart',
    allowPermalinkFallback: toBool(row.allow_permalink_fallback),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Regra de forma: 'default' não tem países; 'country' tem pelo menos um código ISO
 * alpha-2 válido. Devolve a lista em maiúsculas, sem repetição e ordenada.
 */
function normalizeCountries(kind: LinkKind, input: unknown): string[] {
  const list = input === undefined || input === null ? [] : input;
  if (!Array.isArray(list)) throw invalid('Lista de países inválida', { field: 'countries' });
  if (list.length > MAX_COUNTRIES) throw invalid('Lista de países longa demais', { field: 'countries' });
  if (kind === 'default') {
    if (list.length > 0) throw invalid("Rota 'default' não aceita países", { field: 'countries' });
    return [];
  }
  const codes = new Set<string>();
  for (const item of list) {
    const code = normalizeCountryCode(typeof item === 'string' ? item : null);
    if (code === null) throw invalid('Código de país inválido: esperado ISO 3166-1 alpha-2', { field: 'countries' });
    codes.add(code);
  }
  if (codes.size === 0) throw invalid("Rota 'country' exige pelo menos um país", { field: 'countries' });
  return [...codes].sort();
}

/**
 * O TypeScript garante o formato só em tempo de compilação. Um null ou um valor solto
 * chegando aqui em tempo de execução precisa virar invalid_request, não um TypeError que
 * a camada HTTP trataria como erro interno.
 */
function requireRecord(input: unknown, field: string): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid(`Dados inválidos em ${field}: esperado um objeto`, { field });
  }
}

export function createLinkRepo(db: Db, deps: { clock: Clock }): LinkRepo {
  const { clock } = deps;

  function get(id: string): Link | null {
    if (typeof id !== 'string') return null;
    const row = db.get<LinkRow>(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ?`, [id]);
    return row ? mapLink(row) : null;
  }

  function requireStoreWithRole(storeId: unknown, role: 'vitrine' | 'checkout', field: string): string {
    const row =
      typeof storeId === 'string' ? db.get<{ role: string }>('SELECT role FROM stores WHERE id = ?', [storeId]) : undefined;
    if (!row || row.role !== role) {
      throw invalid(`${field} deve ser uma loja existente com papel '${role}'`, { field });
    }
    return storeId as string;
  }

  /**
   * Regra de unicidade entre as rotas ATIVAS de uma vitrine: no máximo uma 'default', e
   * cada país em no máximo uma rota 'country'. É ela que mantém o destino determinístico:
   * para um par (vitrine, país) existe sempre zero ou uma rota aplicável de cada tipo.
   * Rotas desativadas não participam. Precisa rodar dentro de uma transação.
   */
  function assertRouteIsUnique(candidate: {
    id: string;
    vitrineStoreId: string;
    kind: LinkKind;
    countries: string[];
    enabled: boolean;
  }): void {
    if (!candidate.enabled) return;
    const others = db.all<{ id: string; countries: string }>(
      'SELECT id, countries FROM links WHERE vitrine_store_id = ? AND kind = ? AND enabled = 1 AND id <> ?',
      [candidate.vitrineStoreId, candidate.kind, candidate.id],
    );
    if (candidate.kind === 'default') {
      const other = others[0];
      if (other) {
        throw new BridgeError('conflict', 'A vitrine já tem uma rota default ativa', { conflictingLinkId: other.id });
      }
      return;
    }
    const wanted = new Set(candidate.countries);
    for (const other of others) {
      const clash = parseJsonArray(other.countries).find((c) => typeof c === 'string' && wanted.has(c));
      if (clash !== undefined) {
        throw new BridgeError('conflict', 'País já atendido por outra rota ativa da vitrine', {
          conflictingLinkId: other.id,
          country: clash,
        });
      }
    }
  }

  function rethrowConstraint(err: unknown): never {
    // Segunda barreira (índice único parcial do esquema) para a rota default ativa.
    if (isConstraintError(err, 'unique')) {
      throw new BridgeError('conflict', 'A vitrine já tem uma rota default ativa');
    }
    // Loja removida por outro processo entre a verificação e a gravação.
    if (isConstraintError(err, 'foreign_key')) throw invalid('Loja da rota não existe mais');
    throw err;
  }

  return {
    list(filter) {
      const where: string[] = [];
      const params: string[] = [];
      const vitrineStoreId: unknown = filter?.vitrineStoreId;
      const checkoutStoreId: unknown = filter?.checkoutStoreId;
      if (vitrineStoreId !== undefined && vitrineStoreId !== null) {
        // Um id que não é string não casa com rota nenhuma; nem vai ao banco.
        if (typeof vitrineStoreId !== 'string') return [];
        where.push('vitrine_store_id = ?');
        params.push(vitrineStoreId);
      }
      if (checkoutStoreId !== undefined && checkoutStoreId !== null) {
        if (typeof checkoutStoreId !== 'string') return [];
        where.push('checkout_store_id = ?');
        params.push(checkoutStoreId);
      }
      // Qualquer valor "verdadeiro" filtra, não só o booleano true: se um valor de outro
      // tipo chegar aqui, o erro seguro é devolver rotas de menos, nunca uma rota desativada
      // para quem pediu só as ativas.
      if (filter?.enabledOnly) where.push('enabled = 1');
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      return db
        .all<LinkRow>(`SELECT ${LINK_COLUMNS} FROM links ${clause} ORDER BY created_at, id`, params)
        .map(mapLink);
    },

    get,

    create(input: NewLink): Link {
      requireRecord(input, 'link');
      const kind = requireEnum(input.kind, LINK_KINDS, 'kind');
      const countries = normalizeCountries(kind, input.countries);
      const enabled = input.enabled === undefined ? true : requireBoolean(input.enabled, 'enabled');
      const parityPolicy =
        input.parityPolicy === undefined ? 'block' : requireEnum(input.parityPolicy, PARITY_POLICIES, 'parityPolicy');
      const priceToleranceBps =
        input.priceToleranceBps === undefined ? 0 : requireIntInRange(input.priceToleranceBps, 0, 10000, 'priceToleranceBps');
      const maxQuantityPerLine =
        input.maxQuantityPerLine === undefined ? 50 : requireIntInRange(input.maxQuantityPerLine, 1, 10000, 'maxQuantityPerLine');
      const maxLines = input.maxLines === undefined ? 100 : requireIntInRange(input.maxLines, 1, 250, 'maxLines');
      const strategy =
        input.strategy === undefined ? 'storefront_cart' : requireEnum(input.strategy, STRATEGIES, 'strategy');
      const allowPermalinkFallback =
        input.allowPermalinkFallback === undefined
          ? true
          : requireBoolean(input.allowPermalinkFallback, 'allowPermalinkFallback');

      const id = randomId('ln');
      const now = isoNow(clock);
      return db.transaction(() => {
        const vitrineStoreId = requireStoreWithRole(input.vitrineStoreId, 'vitrine', 'vitrineStoreId');
        const checkoutStoreId = requireStoreWithRole(input.checkoutStoreId, 'checkout', 'checkoutStoreId');
        assertRouteIsUnique({ id, vitrineStoreId, kind, countries, enabled });
        try {
          db.run(
            `INSERT INTO links (
               id, vitrine_store_id, checkout_store_id, kind, countries, enabled, parity_policy,
               price_tolerance_bps, max_quantity_per_line, max_lines, strategy, allow_permalink_fallback,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              vitrineStoreId,
              checkoutStoreId,
              kind,
              JSON.stringify(countries),
              fromBool(enabled),
              parityPolicy,
              priceToleranceBps,
              maxQuantityPerLine,
              maxLines,
              strategy,
              fromBool(allowPermalinkFallback),
              now,
              now,
            ],
          );
        } catch (err) {
          rethrowConstraint(err);
        }
        const created = get(id);
        if (!created) throw new BridgeError('internal', 'Rota recém-criada não encontrada');
        return created;
      });
    },

    update(id: string, patch: LinkPatch): Link {
      return db.transaction(() => {
        const current = get(id);
        if (!current) throw new BridgeError('not_found', 'Rota não encontrada', { linkId: String(id) });
        requireRecord(patch, 'patch');

        const kind = patch.kind === undefined ? current.kind : requireEnum(patch.kind, LINK_KINDS, 'kind');
        // Trocar para 'default' sem informar países limpa a lista; informar países junto
        // com 'default' continua sendo erro, como na criação.
        const countriesInput =
          patch.countries !== undefined ? patch.countries : kind === 'default' ? [] : current.countries;
        const countries = normalizeCountries(kind, countriesInput);
        const enabled = patch.enabled === undefined ? current.enabled : requireBoolean(patch.enabled, 'enabled');
        const parityPolicy =
          patch.parityPolicy === undefined
            ? current.parityPolicy
            : requireEnum(patch.parityPolicy, PARITY_POLICIES, 'parityPolicy');
        const priceToleranceBps =
          patch.priceToleranceBps === undefined
            ? current.priceToleranceBps
            : requireIntInRange(patch.priceToleranceBps, 0, 10000, 'priceToleranceBps');
        const maxQuantityPerLine =
          patch.maxQuantityPerLine === undefined
            ? current.maxQuantityPerLine
            : requireIntInRange(patch.maxQuantityPerLine, 1, 10000, 'maxQuantityPerLine');
        const maxLines =
          patch.maxLines === undefined ? current.maxLines : requireIntInRange(patch.maxLines, 1, 250, 'maxLines');
        const strategy =
          patch.strategy === undefined ? current.strategy : requireEnum(patch.strategy, STRATEGIES, 'strategy');
        const allowPermalinkFallback =
          patch.allowPermalinkFallback === undefined
            ? current.allowPermalinkFallback
            : requireBoolean(patch.allowPermalinkFallback, 'allowPermalinkFallback');

        // Vale também para reativação: uma rota desativada pode ter ficado em conflito com
        // outra criada depois, e só pode voltar se a regra continuar valendo.
        assertRouteIsUnique({ id, vitrineStoreId: current.vitrineStoreId, kind, countries, enabled });
        try {
          db.run(
            `UPDATE links SET
               kind = ?, countries = ?, enabled = ?, parity_policy = ?, price_tolerance_bps = ?,
               max_quantity_per_line = ?, max_lines = ?, strategy = ?, allow_permalink_fallback = ?, updated_at = ?
             WHERE id = ?`,
            [
              kind,
              JSON.stringify(countries),
              fromBool(enabled),
              parityPolicy,
              priceToleranceBps,
              maxQuantityPerLine,
              maxLines,
              strategy,
              fromBool(allowPermalinkFallback),
              isoNow(clock),
              id,
            ],
          );
        } catch (err) {
          rethrowConstraint(err);
        }
        const updated = get(id);
        if (!updated) throw new BridgeError('not_found', 'Rota não encontrada', { linkId: id });
        return updated;
      });
    },

    delete(id: string): void {
      // Um id que não é string não pode existir (e o SQLite recusaria o parâmetro).
      const changes = typeof id === 'string' ? db.run('DELETE FROM links WHERE id = ?', [id]).changes : 0;
      if (changes === 0) throw new BridgeError('not_found', 'Rota não encontrada', { linkId: String(id) });
    },
  };
}
