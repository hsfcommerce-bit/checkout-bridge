import type { Db } from './db.ts';

/**
 * Esquema do banco, versionado por PRAGMA user_version.
 *
 * Cada migração roda em uma transação junto com a gravação da versão nova: ou o banco
 * fica inteiro na versão seguinte, ou fica como estava. Migrações já aplicadas nunca são
 * editadas; mudanças entram como um item novo no fim da lista.
 *
 * Decisões de modelagem que valem para todas as tabelas:
 * - datas são TEXT em ISO 8601 UTC no formato do toISOString() (largura fixa), para que a
 *   comparação de texto coincida com a comparação de tempo;
 * - booleanos são INTEGER 0/1; arrays e objetos são TEXT com JSON;
 * - IDs da Shopify são TEXT (passam de 2^53 e não cabem em número do JavaScript);
 * - chave primária de texto leva NOT NULL explícito: no SQLite, "TEXT PRIMARY KEY" sozinho
 *   aceita NULL (e várias linhas com NULL), que virariam linhas inalcançáveis por id;
 * - links, catalog_variants e variant_mappings somem junto com a loja (ON DELETE CASCADE);
 *   checkout_sessions e audit_log NÃO referenciam stores: o histórico sobrevive à loja.
 */

const MIGRATIONS: readonly string[] = [
  // v1: esquema inicial
  `
  CREATE TABLE stores (
    id                    TEXT PRIMARY KEY NOT NULL,
    role                  TEXT NOT NULL CHECK (role IN ('vitrine', 'checkout')),
    name                  TEXT NOT NULL,
    shop_domain           TEXT NOT NULL UNIQUE,
    public_domain         TEXT,
    -- Só vitrine: caminho do App Proxy no domínio da loja (ex.: /apps/checkout-bridge).
    proxy_path            TEXT,
    client_id             TEXT NOT NULL,
    -- Texto cifrado pelo SecretBox (v1.<iv>.<tag>.<dados>); o segredo em claro nunca é gravado.
    client_secret_enc     TEXT NOT NULL,
    currency              TEXT,
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'connected', 'error', 'disabled')),
    status_detail         TEXT,
    storefront_auth_mode  TEXT NOT NULL DEFAULT 'tokenless'
                          CHECK (storefront_auth_mode IN ('private_token', 'public_token', 'tokenless')),
    storefront_token_enc  TEXT,
    last_sync_at          TEXT,
    last_sync_ok          INTEGER CHECK (last_sync_ok IN (0, 1)),
    last_sync_detail      TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );

  CREATE TABLE links (
    id                        TEXT PRIMARY KEY NOT NULL,
    vitrine_store_id          TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    checkout_store_id         TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    kind                      TEXT NOT NULL CHECK (kind IN ('default', 'country')),
    countries                 TEXT NOT NULL DEFAULT '[]',
    enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    parity_policy             TEXT NOT NULL DEFAULT 'block' CHECK (parity_policy IN ('block', 'warn', 'off')),
    price_tolerance_bps       INTEGER NOT NULL DEFAULT 0 CHECK (price_tolerance_bps BETWEEN 0 AND 10000),
    max_quantity_per_line     INTEGER NOT NULL DEFAULT 50 CHECK (max_quantity_per_line BETWEEN 1 AND 10000),
    max_lines                 INTEGER NOT NULL DEFAULT 100 CHECK (max_lines BETWEEN 1 AND 250),
    strategy                  TEXT NOT NULL DEFAULT 'storefront_cart'
                              CHECK (strategy IN ('storefront_cart', 'permalink')),
    allow_permalink_fallback  INTEGER NOT NULL DEFAULT 1 CHECK (allow_permalink_fallback IN (0, 1)),
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  );
  CREATE INDEX idx_links_vitrine ON links (vitrine_store_id);
  CREATE INDEX idx_links_checkout ON links (checkout_store_id);
  -- Segunda barreira da regra "no máximo uma rota default ativa por vitrine". A regra dos
  -- países não cabe em índice (a lista é JSON) e fica só na transação do repositório.
  CREATE UNIQUE INDEX idx_links_one_enabled_default ON links (vitrine_store_id)
    WHERE kind = 'default' AND enabled = 1;

  CREATE TABLE catalog_variants (
    store_id            TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    variant_id          TEXT NOT NULL,
    product_id          TEXT NOT NULL,
    product_title       TEXT NOT NULL,
    product_handle      TEXT NOT NULL,
    product_status      TEXT NOT NULL,
    variant_title       TEXT NOT NULL,
    options             TEXT NOT NULL DEFAULT '[]',
    sku                 TEXT,
    barcode             TEXT,
    price               TEXT NOT NULL,
    compare_at_price    TEXT,
    currency            TEXT NOT NULL,
    available_for_sale  INTEGER NOT NULL CHECK (available_for_sale IN (0, 1)),
    inventory_policy    TEXT NOT NULL,
    inventory_quantity  INTEGER,
    tracked             INTEGER NOT NULL CHECK (tracked IN (0, 1)),
    synced_at           TEXT NOT NULL,
    PRIMARY KEY (store_id, variant_id)
  );
  CREATE INDEX idx_catalog_product ON catalog_variants (store_id, product_id);
  CREATE INDEX idx_catalog_sku ON catalog_variants (store_id, sku);
  CREATE INDEX idx_catalog_barcode ON catalog_variants (store_id, barcode);

  CREATE TABLE variant_mappings (
    vitrine_store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    checkout_store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    vitrine_variant_id   TEXT NOT NULL,
    checkout_variant_id  TEXT,
    status               TEXT NOT NULL
                         CHECK (status IN ('active', 'suggested', 'conflict', 'unmapped', 'disabled')),
    method               TEXT
                         CHECK (method IS NULL OR method IN ('sku', 'barcode', 'handle_options', 'title_options', 'manual')),
    candidates           TEXT NOT NULL DEFAULT '[]',
    divergences          TEXT NOT NULL DEFAULT '[]',
    locked               INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (vitrine_store_id, checkout_store_id, vitrine_variant_id)
  );
  CREATE INDEX idx_mappings_status ON variant_mappings (status);
  -- A chave primária começa pela vitrine; este índice serve à exclusão pelo lado checkout.
  CREATE INDEX idx_mappings_checkout ON variant_mappings (checkout_store_id);

  -- Sem chave estrangeira para stores, de propósito: o histórico sobrevive à loja.
  CREATE TABLE checkout_sessions (
    id                 TEXT PRIMARY KEY NOT NULL,
    idempotency_key    TEXT NOT NULL,
    vitrine_store_id   TEXT NOT NULL,
    checkout_store_id  TEXT NOT NULL,
    link_id            TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed')),
    strategy           TEXT CHECK (strategy IS NULL OR strategy IN ('storefront_cart', 'permalink')),
    lines              TEXT NOT NULL DEFAULT '[]',
    country            TEXT,
    checkout_url       TEXT,
    cart_id            TEXT,
    subtotal           TEXT,
    currency           TEXT,
    error_code         TEXT,
    ip_hash            TEXT,
    created_at         TEXT NOT NULL,
    expires_at         TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_key ON checkout_sessions (idempotency_key);
  CREATE INDEX idx_sessions_created ON checkout_sessions (created_at);
  CREATE INDEX idx_sessions_vitrine ON checkout_sessions (vitrine_store_id);
  CREATE INDEX idx_sessions_checkout ON checkout_sessions (checkout_store_id);
  CREATE INDEX idx_sessions_expires ON checkout_sessions (expires_at);

  -- Também sem chave estrangeira: target_id pode apontar para algo que já não existe.
  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    detail       TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_audit_target ON audit_log (target_type, target_id);
  CREATE INDEX idx_audit_at ON audit_log (at);

  CREATE TABLE webhook_events (
    event_id  TEXT PRIMARY KEY NOT NULL,
    seen_at   TEXT NOT NULL
  );
  CREATE INDEX idx_webhook_events_seen ON webhook_events (seen_at);

  CREATE TABLE admin_sessions (
    id          TEXT PRIMARY KEY NOT NULL,
    -- Só o hash do token da sessão é guardado; o token em claro fica no cookie.
    token_hash  TEXT NOT NULL UNIQUE,
    csrf_token  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX idx_admin_sessions_expires ON admin_sessions (expires_at);
  `,
  // v2: última execução concluída de cada tarefa periódica. Sem isso, cada reinício do
  // processo zerava a contagem até a próxima ressincronização.
  `
  CREATE TABLE job_runs (
    job          TEXT PRIMARY KEY NOT NULL,
    last_run_at  TEXT NOT NULL
  );
  `,
  // v3: pedidos vindos dos webhooks (sem dados pessoais) e a ligação sessão -> pedido.
  // Sem chave estrangeira para stores: o histórico de vendas sobrevive à remoção da loja.
  `
  ALTER TABLE checkout_sessions ADD COLUMN order_id TEXT;
  CREATE TABLE orders (
    store_id            TEXT NOT NULL,
    order_id            TEXT NOT NULL,
    order_name          TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    currency            TEXT NOT NULL,
    subtotal            TEXT NOT NULL,
    total               TEXT NOT NULL,
    total_refunded      TEXT NOT NULL DEFAULT '0.00',
    financial_status    TEXT NOT NULL DEFAULT '',
    cancelled_at        TEXT,
    line_count          INTEGER NOT NULL DEFAULT 0,
    bridge_session_id   TEXT,
    vitrine_store_id    TEXT,
    recorded_at         TEXT NOT NULL,
    PRIMARY KEY (store_id, order_id)
  );
  CREATE INDEX idx_orders_created ON orders (created_at);
  CREATE INDEX idx_orders_vitrine ON orders (vitrine_store_id);
  CREATE INDEX idx_orders_session ON orders (bridge_session_id);
  `,
  // v4: quadro de operações (colunas livres + um cartão por vitrine, com observação).
  `
  CREATE TABLE board_columns (
    id        TEXT PRIMARY KEY NOT NULL,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL
  );
  CREATE TABLE board_cards (
    store_id    TEXT PRIMARY KEY NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    column_id   TEXT REFERENCES board_columns(id) ON DELETE SET NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
  );
  INSERT INTO board_columns (id, name, position) VALUES
    ('col_aquecendo', 'Aquecendo', 0), ('col_pre_escala', 'Pré Escala', 1), ('col_escala', 'Escala', 2), ('col_block', 'Block', 3);
  `,
  // v5: nome da operação no cartão do quadro.
  `
  ALTER TABLE board_cards ADD COLUMN title TEXT NOT NULL DEFAULT '';
  `,
  // v6: miniatura da variante no painel de mapeamento.
  `
  ALTER TABLE catalog_variants ADD COLUMN image_url TEXT;
  `,
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

function currentVersion(db: Db): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  return Number(row?.user_version ?? 0);
}

/**
 * Leva o banco até SCHEMA_VERSION. Idempotente: rodar de novo com o banco já atualizado
 * não faz nada.
 *
 * Lança se o banco estiver em uma versão MAIOR que a conhecida por este código (arquivo
 * criado por uma versão mais nova do serviço): seguir em frente poderia gravar dados em
 * um esquema que este código não entende.
 */
export function migrate(db: Db): void {
  const startedAt = currentVersion(db);
  if (startedAt > SCHEMA_VERSION) {
    throw new Error(
      `O banco está na versão de esquema ${startedAt}, mais nova que a suportada (${SCHEMA_VERSION})`,
    );
  }
  for (let version = startedAt; version < SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;
    db.transaction(() => {
      // Relê dentro da transação: outro processo pode ter migrado entre a leitura inicial
      // e a obtenção da trava de escrita.
      if (currentVersion(db) !== version) return;
      db.exec(sql);
      // PRAGMA não aceita parâmetro; o valor é um inteiro gerado aqui, nunca dado externo.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
