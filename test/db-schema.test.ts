import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.ts';
import type { Db, SqlParams } from '../src/db/db.ts';
import { migrate, SCHEMA_VERSION } from '../src/db/schema.ts';
import { isConstraintError } from '../src/db/util.ts';
import { T0, tableCount } from './db-helpers.ts';

/**
 * Esquema: migração, chaves estrangeiras e restrições. Os dados entram por SQL cru, de
 * propósito: o que se testa aqui é a última barreira do banco, a que vale mesmo quando um
 * repositório tem defeito ou alguém edita o arquivo à mão.
 */

type Table = Parameters<typeof tableCount>[1];
type Values = Record<string, string | number | null>;

const TABLES: Table[] = [
  'admin_sessions',
  'audit_log',
  'board_cards',
  'board_columns',
  'catalog_variants',
  'checkout_sessions',
  'job_runs',
  'links',
  'orders',
  'stores',
  'variant_mappings',
  'webhook_events',
];

const open: Db[] = [];
const tempDirs: string[] = [];

function memory(migrated = true): Db {
  const db = openDatabase(':memory:');
  open.push(db);
  if (migrated) migrate(db);
  return db;
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-schema-'));
  tempDirs.push(dir);
  return join(dir, 'bridge.db');
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userVersion(db: Db): number {
  return Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version);
}

/** Retrato do esquema: tudo o que o sqlite_master guarda, em ordem estável. */
function schemaDump(db: Db): string {
  return db
    .all<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .map((row) => `${row.type} ${row.name}\n${row.sql ?? ''}`)
    .join('\n\n');
}

function tableNames(db: Db): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name);
}

/** INSERT cru. Tabela e colunas vêm de literais deste arquivo; os valores vão por parâmetro. */
function insertRaw(db: Db, table: Table, values: Values): void {
  const columns = Object.keys(values);
  const params: SqlParams = Object.values(values);
  db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, params);
}

// Linhas válidas mínimas de cada tabela; cada teste troca só a coluna que quer exercitar.

function storeRow(id: string, overrides: Values = {}): Values {
  return {
    id,
    role: 'vitrine',
    name: `Loja ${id}`,
    shop_domain: `${id}.myshopify.com`,
    client_id: 'client',
    client_secret_enc: 'v1.aa.bb.cc',
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function linkRow(id: string, vitrineId: string, checkoutId: string, overrides: Values = {}): Values {
  return { id, vitrine_store_id: vitrineId, checkout_store_id: checkoutId, kind: 'default', created_at: T0, updated_at: T0, ...overrides };
}

function variantRow(storeId: string, variantId: string, overrides: Values = {}): Values {
  return {
    store_id: storeId,
    variant_id: variantId,
    product_id: '1000',
    product_title: 'Camiseta',
    product_handle: 'camiseta',
    product_status: 'ACTIVE',
    variant_title: 'M',
    price: '39.90',
    currency: 'BRL',
    available_for_sale: 1,
    inventory_policy: 'DENY',
    tracked: 1,
    synced_at: T0,
    ...overrides,
  };
}

function mappingRow(vitrineId: string, checkoutId: string, variantId: string, overrides: Values = {}): Values {
  return {
    vitrine_store_id: vitrineId,
    checkout_store_id: checkoutId,
    vitrine_variant_id: variantId,
    checkout_variant_id: `9${variantId}`,
    status: 'active',
    method: 'sku',
    updated_at: T0,
    ...overrides,
  };
}

function sessionRow(id: string, overrides: Values = {}): Values {
  return {
    id,
    idempotency_key: `chave-${id}`,
    vitrine_store_id: 'st_v',
    checkout_store_id: 'st_c',
    link_id: 'ln_1',
    status: 'pending',
    created_at: T0,
    expires_at: '2026-01-01T00:15:00.000Z',
    ...overrides,
  };
}

/** Duas lojas e uma linha em cada tabela dependente, dos dois lados. */
function seedPair(db: Db): void {
  insertRaw(db, 'stores', storeRow('st_v'));
  insertRaw(db, 'stores', storeRow('st_c', { role: 'checkout' }));
  insertRaw(db, 'links', linkRow('ln_1', 'st_v', 'st_c'));
  insertRaw(db, 'catalog_variants', variantRow('st_v', '1'));
  insertRaw(db, 'catalog_variants', variantRow('st_c', '91'));
  insertRaw(db, 'variant_mappings', mappingRow('st_v', 'st_c', '1'));
  insertRaw(db, 'checkout_sessions', sessionRow('cs_1'));
  insertRaw(db, 'audit_log', { at: T0, actor: 'admin', action: 'store.create', target_type: 'store', target_id: 'st_v' });
  insertRaw(db, 'audit_log', { at: T0, actor: 'admin', action: 'store.create', target_type: 'store', target_id: 'st_c' });
}

/** Exige que o INSERT cru falhe por violação do tipo esperado de restrição. */
function assertRejected(db: Db, table: Table, values: Values, kind: Parameters<typeof isConstraintError>[1], label: string): void {
  const before = tableCount(db, table);
  let thrown: unknown;
  try {
    insertRaw(db, table, values);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== undefined, `${label}: o banco deveria recusar`);
  assert.ok(isConstraintError(thrown, kind), `${label}: esperava violação de ${kind}, veio ${String(thrown)}`);
  assert.equal(tableCount(db, table), before, `${label}: nada deveria ter sido gravado`);
}

describe('migrate', () => {
  it('cria o esquema e grava SCHEMA_VERSION em PRAGMA user_version', () => {
    const db = memory(false);
    assert.equal(userVersion(db), 0);
    assert.deepEqual(tableNames(db), []);

    migrate(db);

    assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.deepEqual(tableNames(db), [...TABLES]);
  });

  it('é idempotente: rodar de novo não muda o esquema nem os dados', () => {
    const db = memory();
    seedPair(db);
    const schemaBefore = schemaDump(db);
    const countsBefore = TABLES.map((table) => tableCount(db, table));

    migrate(db);
    migrate(db);

    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(schemaDump(db), schemaBefore);
    assert.deepEqual(TABLES.map((table) => tableCount(db, table)), countsBefore);
    assert.equal(db.get<{ name: string }>("SELECT name FROM stores WHERE id = 'st_v'")?.name, 'Loja st_v');
  });

  it('em arquivo: o esquema persiste e uma nova abertura não migra de novo', () => {
    const path = tempPath();
    const first = openDatabase(path);
    open.push(first);
    migrate(first);
    insertRaw(first, 'stores', storeRow('st_v'));
    const schemaBefore = schemaDump(first);
    first.close();

    const second = openDatabase(path);
    open.push(second);
    assert.equal(userVersion(second), SCHEMA_VERSION);
    migrate(second);
    assert.equal(schemaDump(second), schemaBefore);
    assert.equal(tableCount(second, 'stores'), 1);
  });

  it('duas conexões no mesmo arquivo: a segunda encontra o banco migrado e não faz nada', () => {
    const path = tempPath();
    const first = openDatabase(path);
    const second = openDatabase(path);
    open.push(first, second);
    migrate(first);
    migrate(second);
    assert.equal(userVersion(second), SCHEMA_VERSION);
    assert.deepEqual(tableNames(second), [...TABLES]);
  });

  it('recusa banco em versão mais nova que a conhecida, sem tocar nele', () => {
    const db = memory(false);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), /mais nova/);
    assert.equal(userVersion(db), SCHEMA_VERSION + 1);
    assert.deepEqual(tableNames(db), []);
  });

  it('migração que falha no meio é desfeita por inteiro (esquema e versão)', () => {
    const db = memory(false);
    // admin_sessions é a última tabela criada: a migração só tropeça depois de criar as outras.
    db.exec('CREATE TABLE admin_sessions (intrusa TEXT)');
    assert.throws(() => migrate(db), /admin_sessions/);
    assert.equal(userVersion(db), 0);
    assert.deepEqual(tableNames(db), ['admin_sessions']);

    // Removido o obstáculo, a mesma conexão migra normalmente (nenhuma transação ficou aberta).
    db.exec('DROP TABLE admin_sessions');
    migrate(db);
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.deepEqual(tableNames(db), [...TABLES]);
  });
});

describe('chaves estrangeiras', () => {
  interface FkRow {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }

  function foreignKeys(db: Db, table: Table): FkRow[] {
    // PRAGMA não aceita parâmetro; o nome vem do tipo literal Table.
    return db.all<FkRow>(`PRAGMA foreign_key_list(${table})`);
  }

  it('estão ligadas na conexão', () => {
    const db = memory();
    assert.equal(Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys), 1);
  });

  it('recusam linha que aponta para loja inexistente', () => {
    const db = memory();
    insertRaw(db, 'stores', storeRow('st_v'));
    insertRaw(db, 'stores', storeRow('st_c', { role: 'checkout' }));

    assertRejected(db, 'links', linkRow('ln_x', 'st_fantasma', 'st_c'), 'foreign_key', 'rota sem vitrine');
    assertRejected(db, 'links', linkRow('ln_x', 'st_v', 'st_fantasma'), 'foreign_key', 'rota sem checkout');
    assertRejected(db, 'catalog_variants', variantRow('st_fantasma', '1'), 'foreign_key', 'variante sem loja');
    assertRejected(db, 'variant_mappings', mappingRow('st_fantasma', 'st_c', '1'), 'foreign_key', 'mapeamento sem vitrine');
    assertRejected(db, 'variant_mappings', mappingRow('st_v', 'st_fantasma', '1'), 'foreign_key', 'mapeamento sem checkout');
  });

  it('links, catalog_variants e variant_mappings declaram ON DELETE CASCADE para stores', () => {
    const db = memory();
    const summary = (table: Table): string[] =>
      foreignKeys(db, table)
        .map((fk) => `${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`)
        .sort();

    assert.deepEqual(summary('links'), ['checkout_store_id->stores.id:CASCADE', 'vitrine_store_id->stores.id:CASCADE']);
    assert.deepEqual(summary('catalog_variants'), ['store_id->stores.id:CASCADE']);
    assert.deepEqual(summary('variant_mappings'), [
      'checkout_store_id->stores.id:CASCADE',
      'vitrine_store_id->stores.id:CASCADE',
    ]);
  });

  it('checkout_sessions, audit_log, webhook_events e admin_sessions não têm chave estrangeira', () => {
    const db = memory();
    for (const table of ['checkout_sessions', 'audit_log', 'webhook_events', 'admin_sessions'] as const) {
      assert.deepEqual(foreignKeys(db, table), [], table);
    }
  });

  it('excluir a vitrine leva rotas, catálogo e mapeamentos dela; o histórico fica', () => {
    const db = memory();
    seedPair(db);
    insertRaw(db, 'stores', storeRow('st_outra'));
    insertRaw(db, 'catalog_variants', variantRow('st_outra', '1'));

    db.run('DELETE FROM stores WHERE id = ?', ['st_v']);

    assert.equal(tableCount(db, 'links'), 0);
    assert.equal(tableCount(db, 'variant_mappings'), 0);
    // Só o catálogo da loja excluída some; o das outras lojas fica intacto.
    assert.deepEqual(
      db.all<{ store_id: string }>('SELECT store_id FROM catalog_variants ORDER BY store_id').map((row) => row.store_id),
      ['st_c', 'st_outra'],
    );
    assert.equal(tableCount(db, 'stores'), 2);
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
    assert.equal(tableCount(db, 'audit_log'), 2);
  });

  it('excluir a loja checkout leva as rotas e os mapeamentos que apontam para ela', () => {
    const db = memory();
    seedPair(db);
    insertRaw(db, 'stores', storeRow('st_c2', { role: 'checkout' }));
    insertRaw(db, 'links', linkRow('ln_2', 'st_v', 'st_c2', { kind: 'country', countries: '["PT"]' }));
    insertRaw(db, 'variant_mappings', mappingRow('st_v', 'st_c2', '1'));

    db.run('DELETE FROM stores WHERE id = ?', ['st_c']);

    assert.deepEqual(db.all<{ id: string }>('SELECT id FROM links').map((row) => row.id), ['ln_2']);
    assert.deepEqual(
      db.all<{ checkout_store_id: string }>('SELECT checkout_store_id FROM variant_mappings').map((row) => row.checkout_store_id),
      ['st_c2'],
    );
    assert.deepEqual(
      db.all<{ store_id: string }>('SELECT store_id FROM catalog_variants').map((row) => row.store_id),
      ['st_v'],
    );
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
    assert.equal(tableCount(db, 'audit_log'), 2);
  });

  it('sessões e auditoria sobrevivem à exclusão de todas as lojas e não deixam violação pendente', () => {
    const db = memory();
    seedPair(db);
    db.exec('DELETE FROM stores');

    assert.equal(tableCount(db, 'stores'), 0);
    assert.equal(tableCount(db, 'links'), 0);
    assert.equal(tableCount(db, 'catalog_variants'), 0);
    assert.equal(tableCount(db, 'variant_mappings'), 0);
    const session = db.get<{ vitrine_store_id: string; checkout_store_id: string; link_id: string }>(
      'SELECT vitrine_store_id, checkout_store_id, link_id FROM checkout_sessions WHERE id = ?',
      ['cs_1'],
    );
    assert.deepEqual({ ...session }, { vitrine_store_id: 'st_v', checkout_store_id: 'st_c', link_id: 'ln_1' });
    assert.equal(tableCount(db, 'audit_log'), 2);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  });

  it('sessão e auditoria aceitam ids de loja que nunca existiram', () => {
    const db = memory();
    insertRaw(db, 'checkout_sessions', sessionRow('cs_x', { vitrine_store_id: 'st_nunca', checkout_store_id: 'st_jamais' }));
    insertRaw(db, 'audit_log', { at: T0, actor: 'system', action: 'x', target_type: 'store', target_id: 'st_nunca' });
    assert.equal(tableCount(db, 'checkout_sessions'), 1);
    assert.equal(tableCount(db, 'audit_log'), 1);
  });
});

describe('CHECK: valores de enum inválidos escritos por SQL cru são recusados', () => {
  /** Banco com as duas lojas de base, para que as linhas dependentes passem pela chave estrangeira. */
  function withStores(): Db {
    const db = memory();
    insertRaw(db, 'stores', storeRow('st_v'));
    insertRaw(db, 'stores', storeRow('st_c', { role: 'checkout' }));
    return db;
  }

  it('stores: role, status, storefront_auth_mode e last_sync_ok', () => {
    const db = memory();
    for (const role of ['admin', 'Vitrine', 'CHECKOUT', '', ' vitrine']) {
      assertRejected(db, 'stores', storeRow('st_x', { role }), 'check', `role=${JSON.stringify(role)}`);
    }
    for (const status of ['ok', 'active', 'Connected', '']) {
      assertRejected(db, 'stores', storeRow('st_x', { status }), 'check', `status=${JSON.stringify(status)}`);
    }
    for (const mode of ['basic', 'private', 'TOKENLESS', '']) {
      assertRejected(db, 'stores', storeRow('st_x', { storefront_auth_mode: mode }), 'check', `auth=${JSON.stringify(mode)}`);
    }
    for (const flag of [2, -1, 'true']) {
      assertRejected(db, 'stores', storeRow('st_x', { last_sync_ok: flag }), 'check', `last_sync_ok=${flag}`);
    }
  });

  it('stores: todos os valores válidos são aceitos', () => {
    const db = memory();
    let n = 0;
    const accept = (overrides: Values): void => {
      n += 1;
      insertRaw(db, 'stores', storeRow(`st_ok_${n}`, overrides));
    };
    for (const role of ['vitrine', 'checkout']) accept({ role });
    for (const status of ['pending', 'connected', 'error', 'disabled']) accept({ status });
    for (const mode of ['private_token', 'public_token', 'tokenless']) accept({ storefront_auth_mode: mode });
    for (const flag of [0, 1, null]) accept({ last_sync_ok: flag });
    assert.equal(tableCount(db, 'stores'), n);
  });

  it('links: kind, parity_policy, strategy e booleanos', () => {
    const db = withStores();
    const bad: Array<[string, Values]> = [
      ['kind=region', { kind: 'region' }],
      ['kind=DEFAULT', { kind: 'DEFAULT' }],
      ['kind vazio', { kind: '' }],
      ['parity_policy=ignore', { parity_policy: 'ignore' }],
      ['parity_policy=BLOCK', { parity_policy: 'BLOCK' }],
      ['strategy=draft_order', { strategy: 'draft_order' }],
      ['strategy vazia', { strategy: '' }],
      ['enabled=2', { enabled: 2 }],
      ['enabled=true', { enabled: 'true' }],
      ['allow_permalink_fallback=2', { allow_permalink_fallback: 2 }],
    ];
    for (const [label, overrides] of bad) assertRejected(db, 'links', linkRow('ln_x', 'st_v', 'st_c', overrides), 'check', label);
  });

  it('links: limites numéricos de tolerância, quantidade e linhas', () => {
    const db = withStores();
    const bad: Array<[string, Values]> = [
      ['tolerância negativa', { price_tolerance_bps: -1 }],
      ['tolerância acima de 100%', { price_tolerance_bps: 10001 }],
      ['quantidade zero', { max_quantity_per_line: 0 }],
      ['quantidade acima do teto', { max_quantity_per_line: 10001 }],
      ['zero linhas', { max_lines: 0 }],
      ['linhas acima do teto', { max_lines: 251 }],
    ];
    for (const [label, overrides] of bad) assertRejected(db, 'links', linkRow('ln_x', 'st_v', 'st_c', overrides), 'check', label);

    // Os extremos válidos entram (rotas por país, para não esbarrar na regra da rota default).
    insertRaw(db, 'links', linkRow('ln_min', 'st_v', 'st_c', { kind: 'country', price_tolerance_bps: 0, max_quantity_per_line: 1, max_lines: 1 }));
    insertRaw(
      db,
      'links',
      linkRow('ln_max', 'st_v', 'st_c', { kind: 'country', price_tolerance_bps: 10000, max_quantity_per_line: 10000, max_lines: 250 }),
    );
    assert.equal(tableCount(db, 'links'), 2);
  });

  it('links: todos os valores válidos são aceitos', () => {
    const db = withStores();
    let n = 0;
    const accept = (overrides: Values): void => {
      n += 1;
      insertRaw(db, 'links', linkRow(`ln_ok_${n}`, 'st_v', 'st_c', { kind: 'country', ...overrides }));
    };
    accept({ kind: 'default' });
    for (const policy of ['block', 'warn', 'off']) accept({ parity_policy: policy });
    for (const strategy of ['storefront_cart', 'permalink']) accept({ strategy });
    for (const flag of [0, 1]) accept({ enabled: flag, allow_permalink_fallback: flag });
    assert.equal(tableCount(db, 'links'), n);
  });

  it('variant_mappings: status, method e locked', () => {
    const db = withStores();
    const bad: Array<[string, Values]> = [
      ['status=pending', { status: 'pending' }],
      ['status=ACTIVE', { status: 'ACTIVE' }],
      ['status vazio', { status: '' }],
      ['method=fuzzy', { method: 'fuzzy' }],
      ['method=SKU', { method: 'SKU' }],
      ['method vazio', { method: '' }],
      ['locked=2', { locked: 2 }],
    ];
    for (const [label, overrides] of bad) assertRejected(db, 'variant_mappings', mappingRow('st_v', 'st_c', '1', overrides), 'check', label);

    let variant = 100;
    for (const status of ['active', 'suggested', 'conflict', 'unmapped', 'disabled']) {
      variant += 1;
      insertRaw(db, 'variant_mappings', mappingRow('st_v', 'st_c', String(variant), { status }));
    }
    for (const method of ['sku', 'barcode', 'handle_options', 'title_options', 'manual', null]) {
      variant += 1;
      insertRaw(db, 'variant_mappings', mappingRow('st_v', 'st_c', String(variant), { method }));
    }
    assert.equal(tableCount(db, 'variant_mappings'), 11);
  });

  it('checkout_sessions: status e strategy', () => {
    const db = memory();
    const bad: Array<[string, Values]> = [
      ['status=done', { status: 'done' }],
      ['status=CREATED', { status: 'CREATED' }],
      ['status=expired', { status: 'expired' }],
      ['status vazio', { status: '' }],
      ['strategy=draft_order', { strategy: 'draft_order' }],
      ['strategy=Permalink', { strategy: 'Permalink' }],
      ['strategy vazia', { strategy: '' }],
    ];
    for (const [label, overrides] of bad) assertRejected(db, 'checkout_sessions', sessionRow('cs_x', overrides), 'check', label);

    let n = 0;
    for (const status of ['pending', 'created', 'failed']) {
      n += 1;
      insertRaw(db, 'checkout_sessions', sessionRow(`cs_ok_${n}`, { status }));
    }
    for (const strategy of ['storefront_cart', 'permalink', null]) {
      n += 1;
      insertRaw(db, 'checkout_sessions', sessionRow(`cs_ok_${n}`, { strategy }));
    }
    assert.equal(tableCount(db, 'checkout_sessions'), n);
  });

  it('UPDATE cru também não consegue gravar valor inválido', () => {
    const db = withStores();
    insertRaw(db, 'checkout_sessions', sessionRow('cs_1'));
    const attempts = [
      "UPDATE checkout_sessions SET status = 'done' WHERE id = 'cs_1'",
      "UPDATE checkout_sessions SET strategy = 'outra' WHERE id = 'cs_1'",
      "UPDATE stores SET role = 'ambas' WHERE id = 'st_v'",
      "UPDATE stores SET status = 'ok' WHERE id = 'st_v'",
    ];
    for (const sql of attempts) {
      assert.throws(
        () => db.exec(sql),
        (err: unknown) => isConstraintError(err, 'check'),
        sql,
      );
    }
    assert.equal(db.get<{ status: string }>("SELECT status FROM checkout_sessions WHERE id = 'cs_1'")?.status, 'pending');
    assert.equal(db.get<{ role: string }>("SELECT role FROM stores WHERE id = 'st_v'")?.role, 'vitrine');
  });

  it('catalog_variants: booleanos só 0 ou 1', () => {
    const db = withStores();
    assertRejected(db, 'catalog_variants', variantRow('st_v', '1', { available_for_sale: 2 }), 'check', 'available_for_sale=2');
    assertRejected(db, 'catalog_variants', variantRow('st_v', '1', { tracked: -1 }), 'check', 'tracked=-1');
    assertRejected(db, 'catalog_variants', variantRow('st_v', '1', { tracked: 'sim' }), 'check', 'tracked=sim');
  });

  it('enum obrigatório não aceita NULL (o CHECK sozinho deixaria passar)', () => {
    const db = withStores();
    assertRejected(db, 'stores', storeRow('st_x', { role: null }), 'not_null', 'role nulo');
    assertRejected(db, 'links', linkRow('ln_x', 'st_v', 'st_c', { kind: null }), 'not_null', 'kind nulo');
    assertRejected(db, 'variant_mappings', mappingRow('st_v', 'st_c', '1', { status: null }), 'not_null', 'status nulo');
    assertRejected(db, 'checkout_sessions', sessionRow('cs_x', { status: null }), 'not_null', 'status nulo');
    assertRejected(db, 'checkout_sessions', sessionRow('cs_x', { idempotency_key: null }), 'not_null', 'chave nula');
    assertRejected(db, 'checkout_sessions', sessionRow('cs_x', { expires_at: null }), 'not_null', 'expiração nula');
    assertRejected(db, 'admin_sessions', { id: 'as_1', token_hash: null, csrf_token: 'c', created_at: T0, expires_at: T0 }, 'not_null', 'hash nulo');
    assertRejected(db, 'webhook_events', { event_id: 'e', seen_at: null }, 'not_null', 'seen_at nulo');
    assertRejected(db, 'audit_log', { at: null, actor: 'a', action: 'b' }, 'not_null', 'at nulo');
  });
});

describe('chaves e unicidade', () => {
  it('chave primária de texto não aceita NULL', () => {
    // No SQLite, "TEXT PRIMARY KEY" sozinho aceita NULL (e várias linhas com NULL); o
    // esquema precisa dizer NOT NULL para que id nulo não vire linha inalcançável.
    const db = memory();
    insertRaw(db, 'stores', storeRow('st_v'));
    insertRaw(db, 'stores', storeRow('st_c', { role: 'checkout' }));

    assertRejected(db, 'stores', { ...storeRow('st_x'), id: null }, 'not_null', 'stores.id');
    assertRejected(db, 'links', { ...linkRow('ln_x', 'st_v', 'st_c'), id: null }, 'not_null', 'links.id');
    assertRejected(db, 'checkout_sessions', { ...sessionRow('cs_x'), id: null }, 'not_null', 'checkout_sessions.id');
    assertRejected(db, 'webhook_events', { event_id: null, seen_at: T0 }, 'not_null', 'webhook_events.event_id');
    assertRejected(
      db,
      'admin_sessions',
      { id: null, token_hash: 'h', csrf_token: 'c', created_at: T0, expires_at: T0 },
      'not_null',
      'admin_sessions.id',
    );
    assertRejected(db, 'catalog_variants', variantRow('st_v', '1', { variant_id: null }), 'not_null', 'catalog_variants.variant_id');
    assertRejected(
      db,
      'variant_mappings',
      mappingRow('st_v', 'st_c', '1', { vitrine_variant_id: null }),
      'not_null',
      'variant_mappings.vitrine_variant_id',
    );
  });

  it('ids e domínios repetidos são recusados', () => {
    const db = memory();
    seedPair(db);
    insertRaw(db, 'webhook_events', { event_id: 'evt-1', seen_at: T0 });
    insertRaw(db, 'admin_sessions', { id: 'as_1', token_hash: 'hash-1', csrf_token: 'c', created_at: T0, expires_at: T0 });

    assertRejected(db, 'stores', storeRow('st_v', { shop_domain: 'outra.myshopify.com' }), 'unique', 'stores.id');
    assertRejected(db, 'stores', storeRow('st_novo', { shop_domain: 'st_v.myshopify.com' }), 'unique', 'stores.shop_domain');
    assertRejected(db, 'links', linkRow('ln_1', 'st_v', 'st_c', { kind: 'country' }), 'unique', 'links.id');
    assertRejected(db, 'catalog_variants', variantRow('st_v', '1'), 'unique', 'catalog_variants (loja, variante)');
    assertRejected(db, 'variant_mappings', mappingRow('st_v', 'st_c', '1'), 'unique', 'variant_mappings (par, variante)');
    assertRejected(db, 'checkout_sessions', sessionRow('cs_1'), 'unique', 'checkout_sessions.id');
    assertRejected(db, 'webhook_events', { event_id: 'evt-1', seen_at: T0 }, 'unique', 'webhook_events.event_id');
    assertRejected(
      db,
      'admin_sessions',
      { id: 'as_2', token_hash: 'hash-1', csrf_token: 'c', created_at: T0, expires_at: T0 },
      'unique',
      'admin_sessions.token_hash',
    );
  });

  it('a mesma variante pode existir em lojas diferentes, e a mesma chave de idempotência em várias sessões', () => {
    const db = memory();
    seedPair(db);
    insertRaw(db, 'catalog_variants', variantRow('st_c', '1'));
    // Tentativas sucessivas do mesmo carrinho (uma falhou, outra entrou) compartilham a chave.
    insertRaw(db, 'checkout_sessions', sessionRow('cs_2', { idempotency_key: 'chave-cs_1', status: 'failed' }));
    assert.equal(tableCount(db, 'catalog_variants'), 3);
    assert.equal(tableCount(db, 'checkout_sessions'), 2);
  });

  it('no máximo uma rota default ativa por vitrine', () => {
    const db = memory();
    seedPair(db);
    insertRaw(db, 'stores', storeRow('st_c2', { role: 'checkout' }));
    insertRaw(db, 'stores', storeRow('st_v2'));

    assertRejected(db, 'links', linkRow('ln_2', 'st_v', 'st_c2'), 'unique', 'segunda default ativa');
    // Desligada, por país ou de outra vitrine: nenhuma disputa o destino padrão.
    insertRaw(db, 'links', linkRow('ln_3', 'st_v', 'st_c2', { enabled: 0 }));
    insertRaw(db, 'links', linkRow('ln_4', 'st_v', 'st_c2', { kind: 'country', countries: '["PT"]' }));
    insertRaw(db, 'links', linkRow('ln_5', 'st_v2', 'st_c'));
    assert.equal(tableCount(db, 'links'), 4);
    // Religar a segunda default por UPDATE cru também esbarra no índice.
    assert.throws(
      () => db.exec("UPDATE links SET enabled = 1 WHERE id = 'ln_3'"),
      (err: unknown) => isConstraintError(err, 'unique'),
    );
  });
});

describe('colunas e valores padrão', () => {
  function columns(db: Db, table: Table): string[] {
    // PRAGMA não aceita parâmetro; o nome vem do tipo literal Table.
    return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
  }

  it('checkout_sessions guarda só o que o contrato prevê (IP apenas como hash)', () => {
    const db = memory();
    assert.deepEqual(columns(db, 'checkout_sessions').sort(), [
      'cart_id',
      'checkout_store_id',
      'checkout_url',
      'country',
      'created_at',
      'currency',
      'error_code',
      'expires_at',
      'id',
      'idempotency_key',
      'ip_hash',
      'lines',
      'link_id',
      'order_id',
      'status',
      'strategy',
      'subtotal',
      'vitrine_store_id',
    ]);
  });

  it('segredos das lojas e token do painel só têm coluna cifrada ou de hash', () => {
    const db = memory();
    const storeColumns = columns(db, 'stores');
    assert.ok(storeColumns.includes('client_secret_enc'));
    assert.ok(storeColumns.includes('storefront_token_enc'));
    for (const plain of ['client_secret', 'storefront_token', 'access_token', 'token']) {
      assert.ok(!storeColumns.includes(plain), `stores não pode ter a coluna ${plain}`);
    }
    assert.deepEqual(columns(db, 'admin_sessions').sort(), ['created_at', 'csrf_token', 'expires_at', 'id', 'token_hash']);
    assert.deepEqual(columns(db, 'webhook_events').sort(), ['event_id', 'seen_at']);
    assert.deepEqual(columns(db, 'audit_log').sort(), ['action', 'actor', 'at', 'detail', 'id', 'target_id', 'target_type']);
  });

  it('os padrões são os valores seguros', () => {
    const db = memory();
    seedPair(db);

    const store = db.get<Record<string, unknown>>("SELECT status, storefront_auth_mode, last_sync_ok FROM stores WHERE id = 'st_v'");
    assert.deepEqual({ ...store }, { status: 'pending', storefront_auth_mode: 'tokenless', last_sync_ok: null });

    const link = db.get<Record<string, unknown>>(
      `SELECT countries, enabled, parity_policy, price_tolerance_bps, max_quantity_per_line, max_lines, strategy,
              allow_permalink_fallback FROM links WHERE id = 'ln_1'`,
    );
    assert.deepEqual({ ...link }, {
      countries: '[]',
      enabled: 1,
      // Divergência de preço bloqueia e a tolerância é zero até o lojista decidir o contrário.
      parity_policy: 'block',
      price_tolerance_bps: 0,
      max_quantity_per_line: 50,
      max_lines: 100,
      strategy: 'storefront_cart',
      allow_permalink_fallback: 1,
    });

    const mapping = db.get<Record<string, unknown>>('SELECT candidates, divergences, locked FROM variant_mappings');
    assert.deepEqual({ ...mapping }, { candidates: '[]', divergences: '[]', locked: 0 });
    const session = db.get<Record<string, unknown>>("SELECT lines, strategy, checkout_url, error_code FROM checkout_sessions WHERE id = 'cs_1'");
    assert.deepEqual({ ...session }, { lines: '[]', strategy: null, checkout_url: null, error_code: null });
    assert.equal(db.get<{ detail: string }>('SELECT detail FROM audit_log LIMIT 1')?.detail, '{}');
  });

  it('existem os índices das consultas quentes e das limpezas', () => {
    const db = memory();
    const indexes = new Set(
      db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((row) => row.name),
    );
    for (const name of [
      'idx_sessions_key',
      'idx_sessions_created',
      'idx_sessions_expires',
      'idx_audit_target',
      'idx_audit_at',
      'idx_webhook_events_seen',
      'idx_admin_sessions_expires',
      'idx_links_one_enabled_default',
    ]) {
      assert.ok(indexes.has(name), `índice ausente: ${name}`);
    }
    // A busca da sessão viva (a cada clique em "finalizar compra") vai pelo índice da chave.
    const plan = db
      .all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT id FROM checkout_sessions WHERE idempotency_key = ? AND expires_at > ?', ['k', T0])
      .map((row) => row.detail)
      .join(' | ');
    assert.match(plan, /idx_sessions_key/);
  });
});
