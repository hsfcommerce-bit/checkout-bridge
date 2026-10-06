import { BridgeError } from '../types.ts';
import type { CatalogRepo, CatalogVariant, InventoryPolicy, ProductStatus, VariantOption } from '../types.ts';
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
  searchText,
  textOrNull,
  toBool,
  toIso,
  uniqueStrings,
} from './util.ts';

const MAX_SEARCH_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;
/** Limite do texto de busca; o SQLite também limita o tamanho do padrão do LIKE. */
const MAX_QUERY_CHARS = 200;

const VARIANT_COLUMNS = `
  store_id, variant_id, product_id, product_title, product_handle, product_status,
  variant_title, options, sku, barcode, price, compare_at_price, currency,
  available_for_sale, inventory_policy, inventory_quantity, tracked, synced_at`;

/** Ordenação fixa das listagens; os dois últimos campos só desempatam de forma estável. */
const VARIANT_ORDER = 'ORDER BY product_title COLLATE NOCASE, variant_title COLLATE NOCASE, product_id, variant_id';

const UPSERT_SQL = `
  INSERT INTO catalog_variants (${VARIANT_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (store_id, variant_id) DO UPDATE SET
    product_id = excluded.product_id,
    product_title = excluded.product_title,
    product_handle = excluded.product_handle,
    product_status = excluded.product_status,
    variant_title = excluded.variant_title,
    options = excluded.options,
    sku = excluded.sku,
    barcode = excluded.barcode,
    price = excluded.price,
    compare_at_price = excluded.compare_at_price,
    currency = excluded.currency,
    available_for_sale = excluded.available_for_sale,
    inventory_policy = excluded.inventory_policy,
    inventory_quantity = excluded.inventory_quantity,
    tracked = excluded.tracked,
    synced_at = excluded.synced_at`;

interface VariantRow {
  store_id: string;
  variant_id: string;
  product_id: string;
  product_title: string;
  product_handle: string;
  product_status: string;
  variant_title: string;
  options: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compare_at_price: string | null;
  currency: string;
  available_for_sale: number;
  inventory_policy: string;
  inventory_quantity: number | null;
  tracked: number;
  synced_at: string;
}

function mapOptions(text: string): VariantOption[] {
  const out: VariantOption[] = [];
  for (const item of parseJsonArray(text)) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, value } = item as { name?: unknown; value?: unknown };
    if (typeof name === 'string' && typeof value === 'string') out.push({ name, value });
  }
  return out;
}

function mapVariant(row: VariantRow): CatalogVariant {
  return {
    storeId: row.store_id,
    variantId: row.variant_id,
    productId: row.product_id,
    productTitle: row.product_title,
    productHandle: row.product_handle,
    // Valor desconhecido (status novo da Shopify) é devolvido como veio: quem consome
    // compara com 'ACTIVE', e qualquer outra coisa já conta como não vendável.
    productStatus: row.product_status as ProductStatus,
    variantTitle: row.variant_title,
    options: mapOptions(row.options),
    sku: textOrNull(row.sku),
    barcode: textOrNull(row.barcode),
    price: String(row.price),
    compareAtPrice: row.compare_at_price === null || row.compare_at_price === undefined ? null : String(row.compare_at_price),
    currency: row.currency,
    availableForSale: toBool(row.available_for_sale),
    inventoryPolicy: row.inventory_policy as InventoryPolicy,
    inventoryQuantity: typeof row.inventory_quantity === 'number' ? row.inventory_quantity : null,
    tracked: toBool(row.tracked),
    syncedAt: row.synced_at,
  };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`Campo obrigatório ausente: ${field}`, { field });
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Estoque gravável: inteiro dentro da faixa segura do JavaScript, ou null.
 *
 * Um inteiro acima de 2^53 gravado na coluna faz o node:sqlite lançar ao LER a linha, o
 * que derrubaria getVariant, listAll e search da loja inteira por causa de um único
 * registro. Como a Shopify devolve estoque em Int de 32 bits, valor fora da faixa é lixo
 * e vira "desconhecido" em vez de envenenar as leituras.
 */
function toQuantity(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  const whole = Math.trunc(value);
  // "+ 0" troca -0 por 0 (Math.trunc(-0.5) devolve -0).
  return Number.isSafeInteger(whole) ? whole + 0 : null;
}

function toParams(variant: CatalogVariant): SqlParams {
  return [
    requireId(variant.storeId, 'storeId'),
    requireId(variant.variantId, 'variantId'),
    requireId(variant.productId, 'productId'),
    String(variant.productTitle ?? ''),
    String(variant.productHandle ?? ''),
    String(variant.productStatus ?? ''),
    String(variant.variantTitle ?? ''),
    JSON.stringify(Array.isArray(variant.options) ? variant.options : []),
    nullableText(variant.sku),
    nullableText(variant.barcode),
    requireId(variant.price, 'price'),
    nullableText(variant.compareAtPrice),
    String(variant.currency ?? ''),
    fromBool(variant.availableForSale === true),
    String(variant.inventoryPolicy ?? ''),
    toQuantity(variant.inventoryQuantity),
    fromBool(variant.tracked === true),
    toIso(variant.syncedAt, 'syncedAt'),
  ];
}

export function createCatalogRepo(db: Db): CatalogRepo {
  function upsertAll(variants: CatalogVariant[]): void {
    for (const variant of variants) {
      try {
        db.run(UPSERT_SQL, toParams(variant));
      } catch (err) {
        if (isConstraintError(err, 'foreign_key')) {
          throw new BridgeError('store_not_found', 'Loja do catálogo não encontrada', { storeId: variant.storeId });
        }
        throw err;
      }
    }
  }

  return {
    upsertVariants(variants) {
      if (variants.length === 0) return;
      db.transaction(() => upsertAll(variants));
    },

    replaceProduct(storeId, productId, variants) {
      for (const variant of variants) {
        if (variant.storeId !== storeId || variant.productId !== productId) {
          throw invalid('Variante de outra loja ou de outro produto em replaceProduct', {
            storeId,
            productId,
            variantId: String(variant.variantId),
          });
        }
      }
      db.transaction(() => {
        // Apagar tudo e regravar, dentro da mesma transação, equivale a remover as
        // variantes que sumiram: nenhum leitor enxerga o estado intermediário.
        db.run('DELETE FROM catalog_variants WHERE store_id = ? AND product_id = ?', [storeId, productId]);
        upsertAll(variants);
      });
    },

    deleteProduct(storeId, productId) {
      db.run('DELETE FROM catalog_variants WHERE store_id = ? AND product_id = ?', [storeId, productId]);
    },

    deleteStale(storeId, olderThan) {
      return db.run('DELETE FROM catalog_variants WHERE store_id = ? AND synced_at < ?', [
        storeId,
        toIso(olderThan, 'olderThan'),
      ]).changes;
    },

    deleteStore(storeId) {
      db.run('DELETE FROM catalog_variants WHERE store_id = ?', [storeId]);
    },

    getVariant(storeId, variantId) {
      const row = db.get<VariantRow>(
        `SELECT ${VARIANT_COLUMNS} FROM catalog_variants WHERE store_id = ? AND variant_id = ?`,
        [storeId, variantId],
      );
      return row ? mapVariant(row) : null;
    },

    getVariants(storeId, variantIds) {
      const found = new Map<string, CatalogVariant>();
      for (const ids of chunk(uniqueStrings(variantIds))) {
        const rows = db.all<VariantRow>(
          `SELECT ${VARIANT_COLUMNS} FROM catalog_variants
           WHERE store_id = ? AND variant_id IN (${placeholders(ids.length)})`,
          [storeId, ...ids],
        );
        for (const row of rows) found.set(row.variant_id, mapVariant(row));
      }
      return found;
    },

    listAll(storeId) {
      return db
        .all<VariantRow>(`SELECT ${VARIANT_COLUMNS} FROM catalog_variants WHERE store_id = ? ${VARIANT_ORDER}`, [storeId])
        .map(mapVariant);
    },

    search(storeId, opts) {
      const limit = clampLimit(opts.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
      const offset = clampOffset(opts.offset);
      const query = searchText(opts.query, MAX_QUERY_CHARS);
      if (query === '') {
        return db
          .all<VariantRow>(
            `SELECT ${VARIANT_COLUMNS} FROM catalog_variants WHERE store_id = ? ${VARIANT_ORDER} LIMIT ? OFFSET ?`,
            [storeId, limit, offset],
          )
          .map(mapVariant);
      }
      const pattern = likeContains(query);
      return db
        .all<VariantRow>(
          `SELECT ${VARIANT_COLUMNS} FROM catalog_variants
           WHERE store_id = ? AND (
             product_title LIKE ? ${LIKE_ESCAPE}
             OR variant_title LIKE ? ${LIKE_ESCAPE}
             OR sku LIKE ? ${LIKE_ESCAPE}
             OR barcode LIKE ? ${LIKE_ESCAPE}
           )
           ${VARIANT_ORDER} LIMIT ? OFFSET ?`,
          [storeId, pattern, pattern, pattern, pattern, limit, offset],
        )
        .map(mapVariant);
    },

    count(storeId) {
      const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM catalog_variants WHERE store_id = ?', [storeId]);
      return Number(row?.n ?? 0);
    },
  };
}
