import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { createMetrics } from '../src/lib/metrics.ts';
import { createHealthRoutes } from '../src/routes/health.ts';
import { setup } from './db-helpers.ts';

const TOKEN = 'token-de-metricas-123';

function routes(metricsToken: string | null, db: Db = setup().db) {
  const metrics = createMetrics();
  metrics.inc('bridge_webhooks_total', { topic: 'products/update', result: 'ok' });
  return createHealthRoutes({ db, metrics, config: { metricsToken } });
}

/** Banco cujas consultas falham, como um arquivo corrompido ou um disco fora do ar. */
function brokenDb(message: string): Db {
  const fail = (): never => {
    throw new Error(message);
  };
  return { exec: fail, run: fail, get: fail, all: fail, transaction: fail, close() {} };
}

describe('GET /healthz', () => {
  it('responde 200 { ok: true } sem depender do banco', async () => {
    const res = await routes(null, brokenDb('fora do ar')).request('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('GET /readyz', () => {
  it('responde 200 quando o SELECT 1 funciona', async () => {
    const res = await routes(null).request('/readyz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('responde 503 quando o banco falha, sem expor o motivo', async () => {
    const res = await routes(null, brokenDb('unable to open /var/data/bridge.db')).request('/readyz');
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ok: false });
    assert.ok(!text.includes('bridge.db'));
  });

  it('responde 503 quando o banco já foi fechado', async () => {
    const { db } = setup();
    const app = routes(null, db);
    db.close();
    assert.equal((await app.request('/readyz')).status, 503);
  });

  it('responde 503 quando a consulta não devolve a linha esperada', async () => {
    const odd: Db = { ...brokenDb('x'), get: () => undefined };
    assert.equal((await routes(null, odd).request('/readyz')).status, 503);
  });
});

describe('GET /metrics', () => {
  it('sem token configurado, devolve o texto do Prometheus', async () => {
    const res = await routes(null).request('/metrics');
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') ?? '';
    assert.ok(contentType.startsWith('text/plain; version=0.0.4'), contentType);
    const text = await res.text();
    assert.match(text, /bridge_webhooks_total\{[^}]*topic="products\/update"[^}]*\} 1/);
  });

  it('com token configurado, exige Authorization: Bearer <token>', async () => {
    const app = routes(TOKEN);
    const get = (authorization?: string): Promise<Response> =>
      Promise.resolve(app.request('/metrics', authorization === undefined ? {} : { headers: { Authorization: authorization } }));

    const ok = await get(`Bearer ${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /bridge_webhooks_total/);
    assert.equal((await get(`bearer ${TOKEN}`)).status, 200);

    for (const header of [undefined, '', 'Bearer', 'Bearer errado', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
      const res = await get(header);
      assert.equal(res.status, 401, String(header));
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      const text = await res.text();
      assert.ok(!text.includes('bridge_webhooks_total'));
      assert.ok(!text.includes(TOKEN));
    }
  });

  it('o token não vale por parâmetro de URL', async () => {
    const res = await routes(TOKEN).request(`/metrics?token=${TOKEN}&access_token=${TOKEN}`);
    assert.equal(res.status, 401);
  });

  it('as rotas de vida e prontidão não pedem token', async () => {
    const app = routes(TOKEN);
    assert.equal((await app.request('/healthz')).status, 200);
    assert.equal((await app.request('/readyz')).status, 200);
  });
});
