import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createRepos } from '../src/db/repos.ts';
import { migrate } from '../src/db/schema.ts';
import { fakeClock } from '../src/lib/clock.ts';
import { createSecretBox } from '../src/lib/crypto.ts';
import { isBridgeError } from '../src/types.ts';
import type {
  BridgeErrorCode,
  CatalogVariant,
  CheckoutSession,
  NewStore,
  Repos,
  SecretBox,
  Store,
  StoreRole,
  VariantMapping,
} from '../src/types.ts';

/** Apoio comum aos testes do banco. Não é um arquivo de teste (não termina em .test.ts). */

export const T0 = '2026-01-01T00:00:00.000Z';

export interface TestContext {
  db: Db;
  clock: ReturnType<typeof fakeClock>;
  secretBox: SecretBox;
  repos: Repos;
}

/** Banco em memória já migrado, com relógio falso e chave de cifra fixa. */
export function setup(start: string = T0): TestContext {
  const db = openDatabase(':memory:');
  migrate(db);
  const clock = fakeClock(start);
  const secretBox = createSecretBox(Buffer.alloc(32, 1));
  const repos = createRepos(db, { secretBox, clock });
  return { db, clock, secretBox, repos };
}

/** Instante ISO a `ms` milissegundos de T0. */
export function at(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

let storeSeq = 0;

export function makeStore(repos: Repos, role: StoreRole, overrides: Partial<NewStore> = {}): Store {
  storeSeq += 1;
  return repos.stores.create({
    role,
    name: `Loja ${storeSeq}`,
    shopDomain: `loja-${role}-${storeSeq}.myshopify.com`,
    clientId: `client-${storeSeq}`,
    clientSecret: `shpss_segredo_${storeSeq}`,
    ...overrides,
  });
}

export function makeVariant(storeId: string, variantId: string, overrides: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    storeId,
    variantId,
    productId: '1000',
    productTitle: 'Camiseta',
    productHandle: 'camiseta',
    productStatus: 'ACTIVE',
    variantTitle: `Variante ${variantId}`,
    options: [{ name: 'Tamanho', value: 'M' }],
    sku: `SKU-${variantId}`,
    barcode: null,
    price: '39.90',
    compareAtPrice: null,
    currency: 'BRL',
    availableForSale: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 10,
    tracked: true,
    syncedAt: T0,
    ...overrides,
  };
}

export function makeMapping(
  vitrineStoreId: string,
  checkoutStoreId: string,
  vitrineVariantId: string,
  overrides: Partial<VariantMapping> = {},
): VariantMapping {
  return {
    vitrineStoreId,
    checkoutStoreId,
    vitrineVariantId,
    checkoutVariantId: `9${vitrineVariantId}`,
    status: 'active',
    method: 'sku',
    candidates: [],
    divergences: [],
    locked: false,
    updatedAt: T0,
    ...overrides,
  };
}

let sessionSeq = 0;

export function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  sessionSeq += 1;
  return {
    id: `cs_teste_${sessionSeq}`,
    idempotencyKey: 'chave-1',
    vitrineStoreId: 'st_vitrine',
    checkoutStoreId: 'st_checkout',
    linkId: 'ln_1',
    status: 'pending',
    strategy: null,
    lines: [{ vitrineVariantId: '1', checkoutVariantId: '91', quantity: 2 }],
    country: 'BR',
    checkoutUrl: null,
    cartId: null,
    subtotal: null,
    currency: null,
    errorCode: null,
    ipHash: 'a'.repeat(32),
    orderId: null,
    createdAt: T0,
    expiresAt: at(15 * 60_000),
    ...overrides,
  };
}

/** Verifica que fn lança BridgeError com o código esperado e devolve o erro. */
export function expectBridgeError(fn: () => unknown, code: BridgeErrorCode): Error {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== undefined, `esperava BridgeError('${code}'), mas nada foi lançado`);
  assert.ok(isBridgeError(thrown), `esperava BridgeError('${code}'), veio: ${String(thrown)}`);
  assert.equal(thrown.code, code);
  return thrown;
}

export function tableCount(db: Db, table: 'stores' | 'links' | 'catalog_variants' | 'variant_mappings' | 'checkout_sessions' | 'audit_log' | 'webhook_events' | 'admin_sessions' | 'job_runs' | 'orders' | 'board_columns' | 'board_cards'): number {
  // O nome da tabela vem do tipo literal acima, nunca de dado externo.
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
}
