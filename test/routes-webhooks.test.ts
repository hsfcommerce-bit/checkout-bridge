import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { createLogger } from '../src/lib/logger.ts';
import { MAX_WEBHOOK_BODY_BYTES, createWebhookRoutes, readTopLevelField } from '../src/routes/webhooks.ts';
import type { Alert, AdminTokenProvider, Alerter, CatalogEventQueue, Metrics, Store } from '../src/types.ts';
import { makeSession, makeStore, setup, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/** Acima de 2^53: JSON.parse devolveria 9007199254740992. */
const BIG_ID = '9007199254740993';

interface Harness {
  ctx: TestContext;
  store: Store;
  secret: string;
  app: ReturnType<typeof createWebhookRoutes>;
  changed: Array<[string, string]>;
  deleted: Array<[string, string]>;
  invalidated: string[];
  alerts: Alert[];
  counted: string[];
  logLines: string[];
  queueFailure: { error: Error | null };
}

function harness(): Harness {
  const ctx = setup();
  const store = makeStore(ctx.repos, 'checkout');
  const secret = ctx.repos.stores.getSecrets(store.id).clientSecret;
  const changed: Array<[string, string]> = [];
  const deleted: Array<[string, string]> = [];
  const invalidated: string[] = [];
  const alerts: Alert[] = [];
  const counted: string[] = [];
  const logLines: string[] = [];
  const queueFailure: { error: Error | null } = { error: null };

  const queue: CatalogEventQueue = {
    productChanged(storeId, productId) {
      if (queueFailure.error) throw queueFailure.error;
      changed.push([storeId, productId]);
    },
    productDeleted(storeId, productId) {
      deleted.push([storeId, productId]);
    },
    idle: () => Promise.resolve(),
    stop() {},
  };
  const tokens: AdminTokenProvider = {
    getToken: () => Promise.reject(new Error('não usado')),
    getScopes: () => Promise.reject(new Error('não usado')),
    invalidate(storeId) {
      invalidated.push(storeId);
    },
  };
  const alerter: Alerter = { notify: (alert) => void alerts.push(alert) };
  const metrics: Metrics = {
    inc(name, labels) {
      counted.push(`${name}|${labels?.topic ?? ''}|${labels?.result ?? ''}`);
    },
    observe() {},
    gauge() {},
    render: () => '',
  };
  const logger = createLogger({ level: 'debug', env: 'test', destination: { write: (line) => void logLines.push(line) } });
  const app = createWebhookRoutes({ repos: ctx.repos, queue, tokens, logger, metrics, alerter, clock: ctx.clock });
  return { ctx, store, secret, app, changed, deleted, invalidated, alerts, counted, logLines, queueFailure };
}

function sign(body: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

interface DeliveryOptions {
  topic?: string;
  shop?: string | null;
  secret?: string;
  hmac?: string | null;
  eventId?: string;
  webhookId?: string;
  /** Corpo realmente enviado, quando difere do que foi assinado. */
  sentBody?: string | Uint8Array;
  headers?: Record<string, string>;
}

async function deliver(h: Harness, body: string | Uint8Array, opts: DeliveryOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.topic !== undefined) headers['X-Shopify-Topic'] = opts.topic;
  const shop = opts.shop === undefined ? h.store.shopDomain : opts.shop;
  if (shop !== null) headers['X-Shopify-Shop-Domain'] = shop;
  const hmac = opts.hmac === undefined ? sign(body, opts.secret ?? h.secret) : opts.hmac;
  if (hmac !== null) headers['X-Shopify-Hmac-Sha256'] = hmac;
  if (opts.eventId !== undefined) headers['X-Shopify-Event-Id'] = opts.eventId;
  if (opts.webhookId !== undefined) headers['X-Shopify-Webhook-Id'] = opts.webhookId;
  return h.app.request('/shopify', { method: 'POST', headers, body: opts.sentBody ?? body });
}

async function expectOk(res: Response): Promise<void> {
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
}

const productBody = (id: string): string =>
  JSON.stringify({ admin_graphql_api_id: `gid://shopify/Product/${id}`, title: 'Camiseta', variants: [{ id: 1 }] });

describe('POST /shopify: tópicos de produto', () => {
  it('products/create enfileira o produto do admin_graphql_api_id', async () => {
    const h = harness();
    await expectOk(await deliver(h, productBody('1234567890'), { topic: 'products/create', eventId: 'ev-1' }));
    assert.deepEqual(h.changed, [[h.store.id, '1234567890']]);
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|products/create|ok']);
  });

  it('products/update ignora ids aninhados e não perde precisão no id do produto', async () => {
    const h = harness();
    // Objetos aninhados com as mesmas chaves ANTES do campo do primeiro nível.
    const body = `{"variants":[{"id":111,"admin_graphql_api_id":"gid://shopify/ProductVariant/111"}],"image":{"id":222},"id":${BIG_ID},"admin_graphql_api_id":"gid://shopify/Product/${BIG_ID}"}`;
    await expectOk(await deliver(h, body, { topic: 'products/update', eventId: 'ev-2' }));
    assert.deepEqual(h.changed, [[h.store.id, BIG_ID]]);
  });

  it('products/update aceita GID com barras escapadas e nome de tópico em outra caixa', async () => {
    const h = harness();
    const body = '{ "admin_graphql_api_id" : "gid:\\/\\/shopify\\/Product\\/55" }';
    await expectOk(await deliver(h, body, { topic: 'Products/Update' }));
    assert.deepEqual(h.changed, [[h.store.id, '55']]);
  });

  it('products/update sem GID usa o id numérico do primeiro nível, lido como texto', async () => {
    const h = harness();
    await expectOk(await deliver(h, `{"title":"x","id":${BIG_ID}}`, { topic: 'products/update' }));
    assert.deepEqual(h.changed, [[h.store.id, BIG_ID]]);
  });

  it('products/delete preserva um id acima de 2^53', async () => {
    const h = harness();
    assert.notEqual(String(JSON.parse(`{"id":${BIG_ID}}`).id), BIG_ID);
    await expectOk(await deliver(h, `{"id":${BIG_ID}}`, { topic: 'products/delete', eventId: 'ev-3' }));
    assert.deepEqual(h.deleted, [[h.store.id, BIG_ID]]);
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|products/delete|ok']);
  });

  it('corpo sem id de produto responde 200 e não enfileira nada', async () => {
    const h = harness();
    for (const body of ['[]', 'não é json', '{"id":1.5}', '{"id":"abc"}', '{"variants":[{"id":7}]}', '']) {
      await expectOk(await deliver(h, body, { topic: 'products/delete' }));
      await expectOk(await deliver(h, body, { topic: 'products/update' }));
    }
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.deleted, []);
    assert.ok(h.counted.every((entry) => entry.endsWith('|invalid_payload')));
    assert.equal(tableCount(h.ctx.db, 'webhook_events'), 0);
  });

  it('falha ao enfileirar responde 500 e alerta', async () => {
    const h = harness();
    h.queueFailure.error = new Error('fila parada');
    const res = await deliver(h, productBody('77'), { topic: 'products/update' });
    assert.equal(res.status, 500);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|products/update|error']);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.severity, 'warning');
  });
});

describe('POST /shopify: autenticação', () => {
  it('recusa corpo adulterado com 401, métrica e log sem o corpo', async () => {
    const h = harness();
    const signed = productBody('1234567890');
    const sent = signed.replace('Camiseta', 'MARCADOR-DO-CORPO');
    const res = await deliver(h, signed, { topic: 'products/update', sentBody: sent });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|products/update|unauthorized']);
    const logs = h.logLines.join('\n');
    assert.match(logs, /"level":"warn"/);
    assert.match(logs, /bad_hmac/);
    assert.ok(!logs.includes('MARCADOR-DO-CORPO'));
    assert.ok(!logs.includes(sign(signed, h.secret)));
    assert.ok(!logs.includes(h.secret));
  });

  it('recusa assinatura feita com outro segredo, inclusive o de outra loja cadastrada', async () => {
    const h = harness();
    const other = makeStore(h.ctx.repos, 'vitrine');
    const otherSecret = h.ctx.repos.stores.getSecrets(other.id).clientSecret;
    assert.notEqual(otherSecret, h.secret);
    for (const secret of ['segredo-errado', otherSecret]) {
      const res = await deliver(h, productBody('5'), { topic: 'products/update', secret });
      assert.equal(res.status, 401);
    }
    assert.deepEqual(h.changed, []);
  });

  it('recusa cabeçalho de assinatura ausente ou vazio', async () => {
    const h = harness();
    assert.equal((await deliver(h, productBody('5'), { topic: 'products/update', hmac: null })).status, 401);
    assert.equal((await deliver(h, productBody('5'), { topic: 'products/update', hmac: '  ' })).status, 401);
    assert.deepEqual(h.changed, []);
  });

  it('recusa loja desconhecida, domínio malformado e domínio ausente', async () => {
    const h = harness();
    for (const shop of ['nao-cadastrada.myshopify.com', 'evil.com', `${h.store.shopDomain}.evil.com`, null]) {
      const res = await deliver(h, productBody('5'), { topic: 'products/update', shop });
      assert.equal(res.status, 401, String(shop));
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
    assert.deepEqual(h.changed, []);
    assert.ok(h.counted.every((entry) => entry === 'bridge_webhooks_total|products/update|unauthorized'));
    assert.ok(!h.logLines.join('\n').includes('evil.com'));
  });

  it('aceita o domínio da loja em outra caixa e os cabeçalhos sem o prefixo X-', async () => {
    const h = harness();
    const body = productBody('42');
    await expectOk(await deliver(h, body, { topic: 'products/update', shop: h.store.shopDomain.toUpperCase() }));
    const res = await h.app.request('/shopify', {
      method: 'POST',
      headers: {
        'Shopify-Topic': 'products/update',
        'Shopify-Shop-Domain': h.store.shopDomain,
        'Shopify-Hmac-Sha256': sign(body, h.secret),
      },
      body,
    });
    await expectOk(res);
    assert.equal(h.changed.length, 2);
  });

  it('tópico não assinado e desconhecido não vira rótulo de métrica', async () => {
    const h = harness();
    const res = await deliver(h, '{}', { topic: 'qualquer/coisa"\n', hmac: 'errado' });
    assert.equal(res.status, 401);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|other|unauthorized']);
  });
});

describe('POST /shopify: entregas repetidas', () => {
  it('a segunda entrega com o mesmo Event-Id responde 200 sem reprocessar', async () => {
    const h = harness();
    const opts = { topic: 'products/update', eventId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043', webhookId: 'wh-1' };
    await expectOk(await deliver(h, productBody('10'), opts));
    // Outra assinatura do mesmo tópico: Webhook-Id diferente, mesmo Event-Id.
    await expectOk(await deliver(h, productBody('10'), { ...opts, webhookId: 'wh-2' }));
    assert.deepEqual(h.changed, [[h.store.id, '10']]);
    assert.deepEqual(h.counted, [
      'bridge_webhooks_total|products/update|ok',
      'bridge_webhooks_total|products/update|duplicate',
    ]);
  });

  it('sem Event-Id, deduplica pelo Webhook-Id', async () => {
    const h = harness();
    await expectOk(await deliver(h, `{"id":10}`, { topic: 'products/delete', webhookId: 'wh-9' }));
    await expectOk(await deliver(h, `{"id":10}`, { topic: 'products/delete', webhookId: 'wh-9' }));
    await expectOk(await deliver(h, `{"id":10}`, { topic: 'products/delete', webhookId: 'wh-10' }));
    assert.equal(h.deleted.length, 2);
  });

  it('o mesmo Event-Id em produtos, tópicos ou lojas diferentes não é repetição', async () => {
    const h = harness();
    const other = makeStore(h.ctx.repos, 'vitrine');
    const otherSecret = h.ctx.repos.stores.getSecrets(other.id).clientSecret;
    const eventId = 'acao-em-massa';
    await expectOk(await deliver(h, productBody('10'), { topic: 'products/update', eventId }));
    await expectOk(await deliver(h, productBody('11'), { topic: 'products/update', eventId }));
    await expectOk(await deliver(h, `{"id":10}`, { topic: 'products/delete', eventId }));
    await expectOk(
      await deliver(h, productBody('10'), { topic: 'products/update', eventId, shop: other.shopDomain, secret: otherSecret }),
    );
    assert.deepEqual(h.changed, [
      [h.store.id, '10'],
      [h.store.id, '11'],
      [other.id, '10'],
    ]);
    assert.deepEqual(h.deleted, [[h.store.id, '10']]);
  });

  it('entrega sem nenhum id é sempre processada', async () => {
    const h = harness();
    await expectOk(await deliver(h, productBody('10'), { topic: 'products/update' }));
    await expectOk(await deliver(h, productBody('10'), { topic: 'products/update' }));
    assert.equal(h.changed.length, 2);
    assert.equal(tableCount(h.ctx.db, 'webhook_events'), 0);
  });

  it('entrega recusada não consome o id: a legítima ainda é processada depois', async () => {
    const h = harness();
    const opts = { topic: 'products/update', eventId: 'ev-77' };
    assert.equal((await deliver(h, productBody('10'), { ...opts, hmac: 'forjado' })).status, 401);
    await expectOk(await deliver(h, productBody('10'), opts));
    assert.equal(h.changed.length, 1);
  });

  it('id de entrega fora do formato esperado é guardado só como hash', async () => {
    const h = harness();
    const eventId = `x y z ${'a'.repeat(300)}`;
    await expectOk(await deliver(h, productBody('10'), { topic: 'products/update', eventId }));
    await expectOk(await deliver(h, productBody('10'), { topic: 'products/update', eventId }));
    assert.equal(h.changed.length, 1);
    const row = h.ctx.db.get<{ event_id: string }>('SELECT event_id FROM webhook_events');
    assert.ok(row !== undefined && row.event_id.startsWith('h:') && row.event_id.length < 200);
  });
});

describe('POST /shopify: tamanho do corpo', () => {
  it('recusa com 413 pelo Content-Length, sem autenticar nem processar', async () => {
    const h = harness();
    const res = await deliver(h, productBody('10'), {
      topic: 'products/update',
      headers: { 'Content-Length': String(MAX_WEBHOOK_BODY_BYTES + 1) },
    });
    assert.equal(res.status, 413);
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|products/update|too_large']);
  });

  it('recusa com 413 um corpo grande demais mesmo sem Content-Length', async () => {
    const h = harness();
    const big = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1).fill(0x20);
    big.set(new TextEncoder().encode(productBody('10')));
    const res = await deliver(h, big, { topic: 'products/update' });
    assert.equal(res.status, 413);
    assert.deepEqual(h.changed, []);
  });

  it('aceita um corpo exatamente no limite', async () => {
    const h = harness();
    const exact = new Uint8Array(MAX_WEBHOOK_BODY_BYTES).fill(0x20);
    exact.set(new TextEncoder().encode(productBody('10')));
    await expectOk(await deliver(h, exact, { topic: 'products/update' }));
    assert.deepEqual(h.changed, [[h.store.id, '10']]);
  });
});

describe('POST /shopify: app/uninstalled e demais tópicos', () => {
  const shopBody = (store: Store): string =>
    JSON.stringify({ id: 548380009, name: 'Loja', domain: 'loja.example', myshopify_domain: store.shopDomain });

  it('marca a loja com erro, invalida o token, audita e alerta', async () => {
    const h = harness();
    h.ctx.repos.stores.update(h.store.id, { status: 'connected' });
    await expectOk(await deliver(h, shopBody(h.store), { topic: 'app/uninstalled', eventId: 'ev-u' }));

    const after = h.ctx.repos.stores.get(h.store.id);
    assert.equal(after?.status, 'error');
    assert.equal(after?.statusDetail, 'App desinstalado na loja');
    assert.deepEqual(h.invalidated, [h.store.id]);
    const audit = h.ctx.repos.audit.list({ limit: 10, offset: 0, targetType: 'store', targetId: h.store.id });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor, 'webhook');
    assert.equal(audit[0]?.action, 'store.app_uninstalled');
    assert.equal(audit[0]?.detail.previousStatus, 'connected');
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.severity, 'critical');
    assert.equal(h.alerts[0]?.key, `app_uninstalled:${h.store.id}`);
    assert.deepEqual(h.counted, ['bridge_webhooks_total|app/uninstalled|ok']);

    // A retentativa da mesma entrega não repete auditoria nem alerta.
    await expectOk(await deliver(h, shopBody(h.store), { topic: 'app/uninstalled', eventId: 'ev-u' }));
    assert.equal(h.ctx.repos.audit.list({ limit: 10, offset: 0 }).length, 1);
    assert.equal(h.alerts.length, 1);
    assert.deepEqual(h.changed, []);
  });

  it('loja desligada pelo lojista continua desligada', async () => {
    const h = harness();
    h.ctx.repos.stores.update(h.store.id, { status: 'disabled' });
    await expectOk(await deliver(h, shopBody(h.store), { topic: 'app/uninstalled' }));
    const after = h.ctx.repos.stores.get(h.store.id);
    assert.equal(after?.status, 'disabled');
    assert.equal(after?.statusDetail, 'App desinstalado na loja');
    assert.deepEqual(h.invalidated, [h.store.id]);
  });

  it('corpo assinado de outro tópico ou de outra loja não desinstala nada', async () => {
    const h = harness();
    h.ctx.repos.stores.update(h.store.id, { status: 'connected' });
    const foreign = JSON.stringify({ id: 1, myshopify_domain: 'outra-loja.myshopify.com' });
    for (const body of [productBody('10'), foreign]) {
      await expectOk(await deliver(h, body, { topic: 'app/uninstalled' }));
    }
    assert.equal(h.ctx.repos.stores.get(h.store.id)?.status, 'connected');
    assert.deepEqual(h.invalidated, []);
    assert.deepEqual(h.alerts, []);
    assert.ok(h.counted.every((entry) => entry === 'bridge_webhooks_total|app/uninstalled|invalid_payload'));
  });

  it('qualquer outro tópico autenticado responde 200 e não faz mais nada', async () => {
    const h = harness();
    const before = h.ctx.repos.stores.get(h.store.id);
    for (const topic of ['shop/update', 'inventory_levels/update', 'customers/create', undefined]) {
      await expectOk(await deliver(h, productBody('10'), { topic, eventId: 'ev-o' }));
    }
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.invalidated, []);
    assert.deepEqual(h.alerts, []);
    assert.deepEqual(h.ctx.repos.stores.get(h.store.id), before);
    assert.equal(tableCount(h.ctx.db, 'webhook_events'), 0);
    assert.equal(tableCount(h.ctx.db, 'audit_log'), 0);
    assert.ok(h.counted.every((entry) => entry === 'bridge_webhooks_total|other|ignored'));
  });

  it('só existe POST /shopify', async () => {
    const h = harness();
    assert.equal((await h.app.request('/shopify')).status, 404);
    assert.equal((await h.app.request('/outra', { method: 'POST', body: '{}' })).status, 404);
  });
});

describe('readTopLevelField', () => {
  it('devolve o número como texto, sem arredondar', () => {
    assert.deepEqual(readTopLevelField(`{"id":${BIG_ID}}`, 'id'), { kind: 'number', value: BIG_ID });
    assert.deepEqual(readTopLevelField(' \n{ "a" : [1,{"id":2}] , "id" :\t18446744073709551615 }', 'id'), {
      kind: 'number',
      value: '18446744073709551615',
    });
  });

  it('decodifica strings e não confunde valor com chave', () => {
    assert.deepEqual(readTopLevelField('{"x":"id","id":"a\\/b\\u0041"}', 'id'), { kind: 'string', value: 'a/bA' });
    assert.deepEqual(readTopLevelField('{"t":"com \\"id\\": 9 dentro","id":3}', 'id'), { kind: 'number', value: '3' });
    assert.deepEqual(readTopLevelField('{"t":"chaves } ] { [ no texto","id":4}', 'id'), { kind: 'number', value: '4' });
  });

  it('devolve null quando não há campo escalar com esse nome no primeiro nível', () => {
    for (const text of ['', 'null', '[{"id":1}]', '{"a":{"id":1}}', '{"id":null}', '{"id":{"x":1}}', '{"id":[1]}', '{"idx":1}', '{"id', '{"id":"sem fim']) {
      assert.equal(readTopLevelField(text, 'id'), null, text);
    }
    assert.equal(readTopLevelField('{"a":1}{"id":2}', 'id'), null);
  });
});

// ---------------------------------------------------------------------------
// Pedidos e reembolsos (painel de vendas) — nada pessoal do comprador é gravado
// ---------------------------------------------------------------------------

const orderBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 5551234567890,
    admin_graphql_api_id: 'gid://shopify/Order/5551234567890',
    name: '#1001',
    created_at: '2026-10-05T12:00:00-03:00',
    currency: 'BRL',
    subtotal_price: '199.90',
    total_price: '219.90',
    financial_status: 'paid',
    cancelled_at: null,
    test: false,
    email: 'comprador@example.com',
    phone: '+5511999990000',
    customer: { first_name: 'Fulano', last_name: 'Silva', email: 'comprador@example.com' },
    shipping_address: { address1: 'Rua Secreta 123', city: 'São Paulo' },
    browser_ip: '203.0.113.9',
    note_attributes: [
      { name: 'bridge_session', value: 'cs_0123456789abcdef' },
      { name: 'bridge_source', value: 'minha-vitrine.myshopify.com' },
    ],
    line_items: [{ id: 1, title: 'Camiseta', quantity: 2 }, { id: 2, title: 'Boné', quantity: 1 }],
    ...overrides,
  });

function dumpAllTables(h: Harness): string {
  const names = h.ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  return names.map((name) => JSON.stringify(h.ctx.db.all(`SELECT * FROM "${name.replace(/"/g, '')}"`))).join('\n');
}

describe('POST /shopify: pedidos e reembolsos', () => {
  it('orders/create grava o pedido sem dados pessoais e liga a sessão da ponte', async () => {
    const h = harness();
    const vitrine = makeStore(h.ctx.repos, 'vitrine', { shopDomain: 'minha-vitrine.myshopify.com' });
    const link = h.ctx.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: h.store.id, kind: 'default' });
    const now = h.ctx.clock.now().toISOString();
    h.ctx.repos.sessions.insertPending(
      makeSession({ vitrineStoreId: vitrine.id, checkoutStoreId: h.store.id, linkId: link.id, id: 'cs_0123456789abcdef', idempotencyKey: 'k-pedido' }),
      now,
    );
    await expectOk(await deliver(h, orderBody(), { topic: 'orders/create', eventId: 'ord-1' }));

    const order = h.ctx.repos.orders.get(h.store.id, '5551234567890');
    assert.ok(order);
    assert.equal(order.orderName, '#1001');
    assert.equal(order.total, '219.90');
    assert.equal(order.currency, 'BRL');
    assert.equal(order.lineCount, 2);
    assert.equal(order.createdAt, '2026-10-05T15:00:00.000Z');
    assert.equal(order.bridgeSessionId, 'cs_0123456789abcdef');
    assert.equal(order.vitrineStoreId, vitrine.id);
    assert.equal(h.ctx.repos.sessions.get('cs_0123456789abcdef')?.orderId, '5551234567890');

    const dump = dumpAllTables(h) + h.logLines.join('\n');
    for (const secret of ['comprador@example.com', 'Fulano', 'Silva', 'Rua Secreta', '+5511999990000', '203.0.113.9']) {
      assert.ok(!dump.includes(secret), `dado pessoal gravado: ${secret}`);
    }
    assert.equal(h.alerts.length, 0);
  });

  it('orders/updated atualiza status, orders/cancelled marca cancelado e refunds/create soma o reembolso', async () => {
    const h = harness();
    await expectOk(await deliver(h, orderBody(), { topic: 'orders/create', eventId: 'o-1' }));
    await expectOk(await deliver(h, orderBody({ financial_status: 'partially_refunded' }), { topic: 'orders/updated', eventId: 'o-2' }));
    assert.equal(h.ctx.repos.orders.get(h.store.id, '5551234567890')?.financialStatus, 'partially_refunded');

    const refund = JSON.stringify({
      id: 77, order_id: 5551234567890,
      transactions: [{ kind: 'refund', status: 'success', amount: '19.90' }, { kind: 'refund', status: 'failure', amount: '100.00' }],
      refund_line_items: [{ subtotal: '999.00' }],
    });
    await expectOk(await deliver(h, refund, { topic: 'refunds/create', eventId: 'r-1' }));
    assert.equal(h.ctx.repos.orders.get(h.store.id, '5551234567890')?.totalRefunded, '19.90');

    await expectOk(await deliver(h, orderBody({ cancelled_at: '2026-10-06T10:00:00Z' }), { topic: 'orders/cancelled', eventId: 'c-1' }));
    assert.equal(h.ctx.repos.orders.get(h.store.id, '5551234567890')?.cancelledAt, '2026-10-06T10:00:00.000Z');
  });

  it('pedido de teste é ignorado e corpo sem total é inválido', async () => {
    const h = harness();
    await expectOk(await deliver(h, orderBody({ test: true }), { topic: 'orders/create', eventId: 't-1' }));
    assert.equal(h.ctx.repos.orders.get(h.store.id, '5551234567890'), null);
    await expectOk(await deliver(h, '{"id": 1, "name": "#1"}', { topic: 'orders/create', eventId: 't-2' }));
    assert.ok(h.counted.some((c) => c === 'bridge_webhooks_total|orders/create|invalid_payload'));
  });

  it('pedido numa loja vitrine é registrado como vazamento e gera alerta', async () => {
    const h = harness();
    const vitrine = makeStore(h.ctx.repos, 'vitrine');
    const secret = h.ctx.repos.stores.getSecrets(vitrine.id).clientSecret;
    await expectOk(await deliver(h, orderBody({ note_attributes: [] }), { topic: 'orders/create', eventId: 'v-1', shop: vitrine.shopDomain, secret }));
    assert.equal(h.ctx.repos.orders.get(vitrine.id, '5551234567890')?.vitrineStoreId, null);
    const stats = h.ctx.repos.orders.stats({ since: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z' });
    assert.equal(stats.leakedOrders, 1);
    assert.equal(stats.orders, 0);
    assert.ok(h.alerts.some((a) => a.key === `leak:${vitrine.id}`));
  });
});
