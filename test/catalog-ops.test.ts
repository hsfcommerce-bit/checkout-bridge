import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingScopes, REQUIRED_SCOPES } from '../src/catalog/scopes.ts';
import { createWebhookRegistrar, topicsForRole, WEBHOOK_TOPICS } from '../src/catalog/webhooks.ts';
const CHECKOUT_TOPICS = topicsForRole('checkout');
const VITRINE_TOPICS = topicsForRole('vitrine');
import { createLogger } from '../src/lib/logger.ts';
import { BridgeError, isBridgeError } from '../src/types.ts';
import type { AdminClient, Store } from '../src/types.ts';
import { makeStore, setup } from './db-helpers.ts';

const logger = createLogger({ level: 'silent', env: 'test' });
const CALLBACK = 'https://bridge.test/webhooks/shopify';

describe('escopos exigidos', () => {
  it('lista os escopos por papel', () => {
    assert.deepEqual(REQUIRED_SCOPES.vitrine, ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders']);
    assert.deepEqual(REQUIRED_SCOPES.checkout, ['read_products', 'read_inventory', 'read_orders']);
  });

  it('não falta nada quando tudo foi concedido', () => {
    assert.deepEqual(missingScopes('vitrine', ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders']), []);
    assert.deepEqual(missingScopes('checkout', ['read_inventory', 'read_products', 'read_orders']), []);
  });

  it('devolve o que falta na ordem da lista exigida', () => {
    assert.deepEqual(missingScopes('vitrine', []), ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders']);
    assert.deepEqual(missingScopes('vitrine', ['read_products']), ['read_inventory', 'write_app_proxy', 'read_orders']);
    assert.deepEqual(missingScopes('checkout', ['read_inventory']), ['read_products', 'read_orders']);
  });

  it('write_x concedido satisfaz read_x exigido', () => {
    assert.deepEqual(missingScopes('checkout', ['write_products', 'write_inventory', 'write_orders']), []);
    assert.deepEqual(missingScopes('vitrine', ['write_products', 'read_inventory', 'write_app_proxy', 'write_orders']), []);
  });

  it('read_x não satisfaz write_x', () => {
    assert.deepEqual(missingScopes('vitrine', ['read_products', 'read_inventory', 'read_app_proxy', 'read_orders']), ['write_app_proxy']);
  });

  it('checkout não exige write_app_proxy', () => {
    assert.deepEqual(missingScopes('checkout', ['read_products', 'read_inventory', 'read_orders']), []);
  });

  it('ignora espaços, caixa e entradas vazias', () => {
    assert.deepEqual(missingScopes('checkout', [' READ_PRODUCTS ', '', 'Write_Inventory', 'read_orders']), []);
  });
});

interface Sub {
  topic: string;
  uri: string | null;
  format?: string;
}

interface Call {
  query: string;
  variables: Record<string, unknown> | undefined;
}

/** Admin API falsa: guarda as assinaturas em memória e responde à listagem e à criação. */
function fakeAdmin(initial: Sub[] = [], opts: { pageSize?: number; onCreate?: (topic: string, subs: Sub[]) => unknown } = {}) {
  const subs = [...initial];
  const calls: Call[] = [];
  const admin: AdminClient = {
    async graphql<T>(_store: Store, query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });
      if (query.includes('webhookSubscriptionCreate')) {
        const topic = String(variables?.['topic']);
        const custom = opts.onCreate?.(topic, subs);
        if (custom !== undefined) return custom as T;
        const input = variables?.['webhookSubscription'] as { uri: string; format: string };
        subs.push({ topic, uri: input.uri, format: input.format });
        return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${subs.length}` }, userErrors: [] } } as T;
      }
      const topics = (variables?.['topics'] as string[] | undefined) ?? [];
      const matching = subs.filter((sub) => topics.includes(sub.topic));
      const size = opts.pageSize ?? 100;
      const start = variables?.['after'] ? Number(variables['after']) : 0;
      const end = start + size;
      return {
        webhookSubscriptions: {
          nodes: matching.slice(start, end).map((sub) => ({ id: 'gid://shopify/WebhookSubscription/1', ...sub })),
          pageInfo: { hasNextPage: end < matching.length, endCursor: end < matching.length ? String(end) : null },
        },
      } as T;
    },
  };
  const creates = () => calls.filter((call) => call.query.includes('webhookSubscriptionCreate'));
  return { admin, calls, subs, creates };
}

function registrar(admin: AdminClient, publicBaseUrl = 'https://bridge.test') {
  return createWebhookRegistrar({ admin, config: { publicBaseUrl }, logger });
}

async function rejection(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(isBridgeError(err), `esperava BridgeError, veio: ${String(err)}`);
    return err;
  }
  throw new Error('esperava rejeição');
}

describe('registro de webhooks', () => {
  it('expõe os quatro tópicos', () => {
    assert.deepEqual(WEBHOOK_TOPICS, ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED']);
  });

  it('cria todos os tópicos quando a loja não tem nenhum, com uri e formato JSON', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin();
    const result = await registrar(fake.admin).ensure(store);
    assert.deepEqual(result, { created: VITRINE_TOPICS, existing: [] });
    const creates = fake.creates();
    assert.equal(creates.length, 5);
    for (const [index, call] of creates.entries()) {
      assert.deepEqual(call.variables, { topic: VITRINE_TOPICS[index], webhookSubscription: { uri: CALLBACK, format: 'JSON' } });
      // callbackUrl está descontinuado na 2026-10: nem na consulta nem na entrada.
      assert.ok(!call.query.includes('callbackUrl'));
    }
    const list = fake.calls[0];
    assert.ok(list && list.query.includes('webhookSubscriptions('));
    assert.ok(!list.query.includes('callbackUrl'));
    assert.deepEqual(list.variables?.['topics'], VITRINE_TOPICS);
  });

  it('cria só os que faltam e não mexe nos que apontam para outro lugar', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'checkout');
    const fake = fakeAdmin([
      { topic: 'PRODUCTS_UPDATE', uri: CALLBACK, format: 'JSON' },
      { topic: 'APP_UNINSTALLED', uri: 'https://BRIDGE.test/webhooks/shopify/', format: 'JSON' },
      { topic: 'PRODUCTS_CREATE', uri: 'https://outro.example/hooks', format: 'JSON' },
      { topic: 'PRODUCTS_DELETE', uri: 'pubsub://projeto:topico', format: 'JSON' },
    ]);
    const result = await registrar(fake.admin).ensure(store);
    assert.deepEqual(result, { created: ['PRODUCTS_CREATE', 'PRODUCTS_DELETE', 'ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'], existing: ['PRODUCTS_UPDATE', 'APP_UNINSTALLED'] });
    assert.deepEqual(fake.creates().map((call) => call.variables?.['topic']), ['PRODUCTS_CREATE', 'PRODUCTS_DELETE', 'ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']);
    // Só listagem e criação: nenhuma mutação de exclusão ou alteração foi enviada.
    assert.ok(fake.calls.every((call) => !/Delete|Update\(/.test(call.query.replace('PRODUCTS_', ''))));
    assert.ok(fake.subs.some((sub) => sub.uri === 'https://outro.example/hooks'));
    assert.equal(fake.subs.length, 10);
  });

  it('é idempotente: a segunda chamada não cria nada', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin();
    const reg = registrar(fake.admin);
    await reg.ensure(store);
    const second = await reg.ensure(store);
    assert.deepEqual(second, { created: [], existing: VITRINE_TOPICS });
    assert.equal(fake.creates().length, 5);
  });

  it('assinatura em XML no mesmo endereço não conta como nossa', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin([{ topic: 'PRODUCTS_CREATE', uri: CALLBACK, format: 'XML' }]);
    const result = await registrar(fake.admin).ensure(store);
    assert.ok(result.created.includes('PRODUCTS_CREATE'));
  });

  it('percorre todas as páginas da listagem', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin(
      [
        { topic: 'PRODUCTS_CREATE', uri: 'https://a.example/x' },
        { topic: 'PRODUCTS_CREATE', uri: 'https://b.example/x' },
        { topic: 'PRODUCTS_CREATE', uri: CALLBACK, format: 'JSON' },
      ],
      { pageSize: 2 },
    );
    const result = await registrar(fake.admin).ensure(store);
    assert.deepEqual(result.existing, ['PRODUCTS_CREATE']);
    assert.equal(fake.creates().length, 4);
  });

  it('userErrors viram BridgeError upstream_rejected com o tópico', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin([], {
      onCreate: (topic) =>
        topic === 'PRODUCTS_UPDATE'
          ? { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['webhookSubscription', 'uri'], message: 'Address is invalid' }] } }
          : undefined,
    });
    const err = await rejection(registrar(fake.admin).ensure(store));
    assert.equal(err.code, 'upstream_rejected');
    assert.equal(err.details['topic'], 'PRODUCTS_UPDATE');
    assert.deepEqual(err.details['created'], ['PRODUCTS_CREATE']);
    assert.match(err.message, /Address is invalid/);
  });

  it('userError de duplicata é tratado como existente quando a nova listagem mostra a assinatura', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin([], {
      onCreate: (topic, subs) => {
        if (topic !== 'PRODUCTS_DELETE') return undefined;
        // Outra execução criou a mesma assinatura entre a listagem e a criação.
        subs.push({ topic, uri: CALLBACK, format: 'JSON' });
        return { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: null, message: 'Address for this topic has already been taken' }] } };
      },
    });
    const result = await registrar(fake.admin).ensure(store);
    assert.deepEqual(result, { created: ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'APP_UNINSTALLED', 'ORDERS_CREATE'], existing: ['PRODUCTS_DELETE'] });
  });

  it('falha de rede vira upstream_unavailable e BridgeError do cliente passa direto', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const network: AdminClient = {
      graphql: async () => {
        throw new TypeError('fetch failed');
      },
    };
    assert.equal((await rejection(registrar(network).ensure(store))).code, 'upstream_unavailable');

    const original = new BridgeError('upstream_rejected', 'negado', { code: 'ACCESS_DENIED' });
    const denied: AdminClient = {
      graphql: async () => {
        throw original;
      },
    };
    assert.equal(await rejection(registrar(denied).ensure(store)), original);
  });

  it('resposta fora do formato vira upstream_rejected', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const broken: AdminClient = { graphql: async <T>() => ({ webhookSubscriptions: null }) as T };
    const err = await rejection(registrar(broken).ensure(store));
    assert.equal(err.code, 'upstream_rejected');
    assert.equal(err.details['reason'], 'malformed_response');

    const noPayload = fakeAdmin([], { onCreate: () => ({ webhookSubscriptionCreate: null }) });
    assert.equal((await rejection(registrar(noPayload.admin).ensure(store))).details['reason'], 'malformed_response');
  });

  it('recusa URL pública sem https antes de chamar a Shopify', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin();
    const err = await rejection(registrar(fake.admin, 'http://localhost:8787').ensure(store));
    assert.equal(err.code, 'invalid_request');
    assert.equal(fake.calls.length, 0);
  });
});
