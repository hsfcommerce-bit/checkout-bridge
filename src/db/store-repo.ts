import { isoNow } from '../lib/clock.ts';
import { randomId } from '../lib/crypto.ts';
import { isValidShopDomain, normalizeHost } from '../lib/shop.ts';
import { BridgeError } from '../types.ts';
import type {
  Clock,
  NewStore,
  SecretBox,
  Store,
  StorePatch,
  StoreRepo,
  StoreRole,
  StoreSecrets,
  StoreStatus,
  StorefrontAuthMode,
} from '../types.ts';
import type { Db, SqlParams } from './db.ts';
import {
  fromBool,
  invalid,
  isConstraintError,
  requireEnum,
  requireText,
  textOrNull,
  toBool,
  toIso,
} from './util.ts';

const STORE_ROLES: readonly StoreRole[] = ['vitrine', 'checkout'];
const STORE_STATUSES: readonly StoreStatus[] = ['pending', 'connected', 'error', 'disabled'];
const AUTH_MODES: readonly StorefrontAuthMode[] = ['private_token', 'public_token', 'tokenless'];

const MAX_NAME = 200;
const MAX_CLIENT_ID = 200;
const MAX_SECRET = 4096;
const MAX_DETAIL = 2000;

/**
 * Colunas lidas para montar um Store. As colunas cifradas ficam de fora de propósito: o
 * objeto Store nunca carrega segredo, nem cifrado; só getSecrets() lê essas colunas.
 */
const STORE_SELECT = `
  SELECT
    s.id, s.role, s.name, s.shop_domain, s.public_domain, s.proxy_path, s.client_id, s.currency,
    s.status, s.status_detail, s.storefront_auth_mode,
    (s.storefront_token_enc IS NOT NULL) AS has_storefront_token,
    s.last_sync_at, s.last_sync_ok, s.last_sync_detail,
    (SELECT COUNT(*) FROM catalog_variants cv WHERE cv.store_id = s.id) AS variant_count,
    s.created_at, s.updated_at
  FROM stores s`;

interface StoreRow {
  id: string;
  role: string;
  name: string;
  shop_domain: string;
  public_domain: string | null;
  proxy_path: string | null;
  client_id: string;
  currency: string | null;
  status: string;
  status_detail: string | null;
  storefront_auth_mode: string;
  has_storefront_token: number;
  last_sync_at: string | null;
  last_sync_ok: number | null;
  last_sync_detail: string | null;
  variant_count: number;
  created_at: string;
  updated_at: string;
}

function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    role: row.role as StoreRole,
    name: row.name,
    shopDomain: row.shop_domain,
    publicDomain: textOrNull(row.public_domain),
    proxyPath: textOrNull(row.proxy_path),
    clientId: row.client_id,
    currency: textOrNull(row.currency),
    status: row.status as StoreStatus,
    statusDetail: textOrNull(row.status_detail),
    storefrontAuthMode: row.storefront_auth_mode as StorefrontAuthMode,
    hasStorefrontToken: toBool(row.has_storefront_token),
    lastSyncAt: textOrNull(row.last_sync_at),
    lastSyncOk: row.last_sync_ok === null || row.last_sync_ok === undefined ? null : toBool(row.last_sync_ok),
    lastSyncDetail: textOrNull(row.last_sync_detail),
    variantCount: Number(row.variant_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validação estrita do domínio: põe em minúsculas e exige <rótulo>.myshopify.com.
 * Não há outra normalização (protocolo, caminho, espaços): quem aceita o que o lojista
 * cola é normalizeShopDomain, na borda; aqui só entra o domínio já limpo.
 */
function strictShopDomain(input: unknown): string {
  // Só ASCII antes de trocar a caixa: o sinal Kelvin (U+212A) vira "k" no toLowerCase().
  if (typeof input !== 'string' || !/^[\x21-\x7e]+$/.test(input)) {
    throw invalid('Domínio da loja inválido: esperado <loja>.myshopify.com', { field: 'shopDomain' });
  }
  const lower = input.toLowerCase();
  if (!isValidShopDomain(lower)) {
    throw invalid('Domínio da loja inválido: esperado <loja>.myshopify.com', { field: 'shopDomain' });
  }
  return lower;
}

function publicDomainOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw invalid('Domínio público inválido', { field: 'publicDomain' });
  if (input.trim() === '') return null;
  const host = normalizeHost(input);
  if (host === null) throw invalid('Domínio público inválido', { field: 'publicDomain' });
  return host;
}

/** Caminho padrão do App Proxy sugerido nas instruções de instalação. */
export const DEFAULT_PROXY_PATH = '/apps/checkout-bridge';

/**
 * Caminho do App Proxy: /<prefixo>/<subcaminho>, com os prefixos que a Shopify aceita
 * (a, apps, community, tools) e subcaminho de até 30 caracteres [A-Za-z0-9_-].
 * Só a vitrine tem proxy; para loja checkout o valor é sempre null.
 */
function proxyPathFor(role: StoreRole, input: unknown): string | null {
  if (role !== 'vitrine') return null;
  if (input === null || input === undefined) return DEFAULT_PROXY_PATH;
  if (typeof input !== 'string') throw invalid('Caminho do App Proxy inválido', { field: 'proxyPath' });
  const trimmed = input.trim();
  // Só o campo em branco cai no padrão. A checagem vem ANTES de tirar a barra final: do
  // contrário "/" e "//" virariam string vazia e seriam aceitos como se fossem o padrão.
  if (trimmed === '') return DEFAULT_PROXY_PATH;
  const value = trimmed.replace(/\/+$/, '');
  if (!/^\/(a|apps|community|tools)\/[A-Za-z0-9_-]{1,30}$/.test(value)) {
    throw invalid('Caminho do App Proxy inválido: esperado /apps/<subcaminho>', { field: 'proxyPath' });
  }
  return value;
}

function currencyOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string' || !/^[A-Za-z]{3}$/.test(input.trim())) {
    throw invalid('Moeda inválida: esperado código ISO de 3 letras', { field: 'currency' });
  }
  return input.trim().toUpperCase();
}

function detailOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  return String(input).slice(0, MAX_DETAIL);
}

/**
 * O TypeScript garante o formato só em tempo de compilação. Um null ou um valor solto
 * chegando aqui em tempo de execução precisa virar invalid_request, não um TypeError que
 * a camada HTTP trataria como erro interno.
 */
function requireRecord(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid(`Dados inválidos em ${field}: esperado um objeto`, { field });
  }
  return input as Record<string, unknown>;
}

/**
 * Token de Storefront na criação: ausente, null ou em branco significam "sem token".
 * Qualquer outro tipo é recusado em vez de ignorado, para que a loja não seja criada sem
 * token (e em modo tokenless) quando quem chamou acreditava ter informado um.
 */
function newStorefrontToken(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw invalid('Token de Storefront inválido', { field: 'storefrontToken' });
  return input.trim() === '' ? null : requireText(input, 'storefrontToken', MAX_SECRET);
}

export function createStoreRepo(db: Db, deps: { secretBox: SecretBox; clock: Clock }): StoreRepo {
  const { secretBox, clock } = deps;

  function get(id: string): Store | null {
    if (typeof id !== 'string') return null;
    const row = db.get<StoreRow>(`${STORE_SELECT} WHERE s.id = ?`, [id]);
    return row ? mapStore(row) : null;
  }

  function mustExist(id: string): void {
    const row = typeof id === 'string' ? db.get<{ id: string }>('SELECT id FROM stores WHERE id = ?', [id]) : undefined;
    if (!row) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId: String(id) });
  }

  return {
    list(filter) {
      const role: unknown = filter?.role;
      if (role === undefined || role === null) {
        return db.all<StoreRow>(`${STORE_SELECT} ORDER BY s.created_at, s.id`).map(mapStore);
      }
      // Papel desconhecido (ou de outro tipo) não casa com loja nenhuma; nem vai ao banco.
      if (typeof role !== 'string' || !(STORE_ROLES as readonly string[]).includes(role)) return [];
      return db.all<StoreRow>(`${STORE_SELECT} WHERE s.role = ? ORDER BY s.created_at, s.id`, [role]).map(mapStore);
    },

    get,

    getByShopDomain(shopDomain) {
      // Só ASCII antes de trocar a caixa, como em strictShopDomain: sem isso, um domínio com
      // o sinal Kelvin (U+212A) no lugar de "k" encontraria a loja de outro nome.
      if (typeof shopDomain !== 'string' || !/^[\x21-\x7e]+$/.test(shopDomain)) return null;
      const row = db.get<StoreRow>(`${STORE_SELECT} WHERE s.shop_domain = ?`, [shopDomain.toLowerCase()]);
      return row ? mapStore(row) : null;
    },

    create(rawInput: NewStore): Store {
      const input = requireRecord(rawInput, 'store');
      const role = requireEnum(input.role, STORE_ROLES, 'role');
      const name = requireText(input.name, 'name', MAX_NAME);
      const shopDomain = strictShopDomain(input.shopDomain);
      const clientId = requireText(input.clientId, 'clientId', MAX_CLIENT_ID);
      const clientSecret = requireText(input.clientSecret, 'clientSecret', MAX_SECRET);
      const publicDomain = publicDomainOrNull(input.publicDomain);
      const proxyPath = proxyPathFor(role, input.proxyPath);
      const storefrontToken = newStorefrontToken(input.storefrontToken);
      const storefrontAuthMode =
        input.storefrontAuthMode !== undefined
          ? requireEnum(input.storefrontAuthMode, AUTH_MODES, 'storefrontAuthMode')
          : storefrontToken !== null
            ? 'private_token'
            : 'tokenless';

      const id = randomId('st');
      const now = isoNow(clock);
      return db.transaction(() => {
        const taken = db.get<{ id: string }>('SELECT id FROM stores WHERE shop_domain = ?', [shopDomain]);
        if (taken) {
          throw new BridgeError('conflict', 'Já existe uma loja com esse domínio', { shopDomain });
        }
        try {
          db.run(
            `INSERT INTO stores (
               id, role, name, shop_domain, public_domain, proxy_path, client_id, client_secret_enc,
               status, storefront_auth_mode, storefront_token_enc, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [
              id,
              role,
              name,
              shopDomain,
              publicDomain,
              proxyPath,
              clientId,
              secretBox.encrypt(clientSecret),
              storefrontAuthMode,
              storefrontToken === null ? null : secretBox.encrypt(storefrontToken),
              now,
              now,
            ],
          );
        } catch (err) {
          // Outro processo pode ter inserido o mesmo domínio entre a consulta e o INSERT.
          if (isConstraintError(err, 'unique')) {
            throw new BridgeError('conflict', 'Já existe uma loja com esse domínio', { shopDomain });
          }
          throw err;
        }
        const created = get(id);
        if (!created) throw new BridgeError('internal', 'Loja recém-criada não encontrada');
        return created;
      });
    },

    update(id: string, patch: StorePatch): Store {
      return db.transaction(() => {
        // A existência vem antes da validação do patch: id desconhecido é sempre
        // store_not_found, mesmo quando o patch também tem problema.
        const current = get(id);
        if (!current) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId: String(id) });
        requireRecord(patch, 'patch');

        // Cada entrada vem de um nome de coluna fixo no código; só os valores são dinâmicos
        // e vão todos por parâmetro. Chaves desconhecidas do patch são ignoradas.
        const sets: string[] = [];
        const params: Array<string | number | null> = [];
        const set = (column: string, value: string | number | null): void => {
          sets.push(`${column} = ?`);
          params.push(value);
        };

        if (patch.name !== undefined) set('name', requireText(patch.name, 'name', MAX_NAME));
        if (patch.publicDomain !== undefined) set('public_domain', publicDomainOrNull(patch.publicDomain));
        // Depende do papel da loja: em loja checkout o resultado é sempre null.
        if (patch.proxyPath !== undefined) set('proxy_path', proxyPathFor(current.role, patch.proxyPath));
        if (patch.clientId !== undefined) set('client_id', requireText(patch.clientId, 'clientId', MAX_CLIENT_ID));
        if (patch.clientSecret !== undefined) {
          set('client_secret_enc', secretBox.encrypt(requireText(patch.clientSecret, 'clientSecret', MAX_SECRET)));
        }
        if (patch.currency !== undefined) set('currency', currencyOrNull(patch.currency));
        if (patch.storefrontAuthMode !== undefined) {
          set('storefront_auth_mode', requireEnum(patch.storefrontAuthMode, AUTH_MODES, 'storefrontAuthMode'));
        }
        if (patch.storefrontToken !== undefined) {
          // null remove o token. String vazia é recusada em vez de tratada como null: um
          // campo de formulário em branco não pode apagar um token por acidente.
          set(
            'storefront_token_enc',
            patch.storefrontToken === null
              ? null
              : secretBox.encrypt(requireText(patch.storefrontToken, 'storefrontToken', MAX_SECRET)),
          );
        }
        if (patch.status !== undefined) set('status', requireEnum(patch.status, STORE_STATUSES, 'status'));
        if (patch.statusDetail !== undefined) set('status_detail', detailOrNull(patch.statusDetail));

        if (sets.length > 0) {
          set('updated_at', isoNow(clock));
          const all: SqlParams = [...params, id];
          db.run(`UPDATE stores SET ${sets.join(', ')} WHERE id = ?`, all);
        }
        const updated = get(id);
        if (!updated) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId: id });
        return updated;
      });
    },

    delete(id: string): void {
      db.transaction(() => {
        mustExist(id);
        // As chaves estrangeiras já fariam isso em cascata; a remoção explícita mantém o
        // comportamento mesmo que o pragma foreign_keys esteja desligado na conexão.
        db.run('DELETE FROM variant_mappings WHERE vitrine_store_id = ? OR checkout_store_id = ?', [id, id]);
        db.run('DELETE FROM catalog_variants WHERE store_id = ?', [id]);
        db.run('DELETE FROM links WHERE vitrine_store_id = ? OR checkout_store_id = ?', [id, id]);
        db.run('DELETE FROM stores WHERE id = ?', [id]);
      });
    },

    getSecrets(id: string): StoreSecrets {
      const row =
        typeof id === 'string'
          ? db.get<{ client_secret_enc: string; storefront_token_enc: string | null }>(
              'SELECT client_secret_enc, storefront_token_enc FROM stores WHERE id = ?',
              [id],
            )
          : undefined;
      if (!row) throw new BridgeError('store_not_found', 'Loja não encontrada', { storeId: String(id) });
      try {
        return {
          clientSecret: secretBox.decrypt(row.client_secret_enc),
          storefrontToken: row.storefront_token_enc === null ? null : secretBox.decrypt(row.storefront_token_enc),
        };
      } catch {
        // Chave de cifra trocada ou dado adulterado. O erro original fica de fora para
        // não arrastar pedaços do texto cifrado para o log.
        throw new BridgeError('internal', 'Não foi possível decifrar os segredos da loja', { storeId: id });
      }
    },

    markSynced(id, rawResult) {
      const result = requireRecord(rawResult, 'result');
      // Loja removida durante a sincronização: não há o que marcar, e isso não é erro.
      // Um id que nem é string cai no mesmo caso (o SQLite recusaria o parâmetro).
      if (typeof id !== 'string') return;
      db.run(
        'UPDATE stores SET last_sync_at = ?, last_sync_ok = ?, last_sync_detail = ?, updated_at = ? WHERE id = ?',
        [toIso(result.at, 'at'), fromBool(result.ok === true), detailOrNull(result.detail), isoNow(clock), id],
      );
    },
  };
}
