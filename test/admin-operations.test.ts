import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { describe, it } from 'node:test';
import { ADMIN_COOKIE, createAdminAuth } from '../src/admin/auth.ts';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import type { AdminDeps } from '../src/routes/admin/context.ts';
import { createAdminRoutes } from '../src/routes/admin/index.ts';
import { makeStore, setup } from './db-helpers.ts';

/** Central de operações: quadro com repositórios reais e serviços falsos. */

const PASSWORD = 'senha-de-teste-123';

function harness() {
  const ctx = setup();
  const logger = createLogger({ level: 'silent', env: 'test' });
  const config = testConfig({ adminPassword: PASSWORD });
  const auth = createAdminAuth({
    adminSessions: ctx.repos.adminSessions,
    audit: ctx.repos.audit,
    config,
    loginLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 / 60, clock: ctx.clock }),
    logger,
    clock: ctx.clock,
  });
  const rematched: Array<[string, string]> = [];
  const fail = (name: string) => () => {
    throw new Error(`${name} não deveria ser chamado`);
  };
  const deps: AdminDeps = {
    repos: ctx.repos,
    auth,
    connection: { connect: fail('connect') },
    sync: { syncStore: fail('syncStore'), refreshProduct: fail('refreshProduct'), removeProduct: fail('removeProduct'), fetchShopInfo: fail('fetchShopInfo') },
    matcher: {
      rematchPair(v, c) {
        rematched.push([v, c]);
        return { vitrineStoreId: v, checkoutStoreId: c, counts: ctx.repos.mappings.counts(v, c) };
      },
      rematchStore: fail('rematchStore'),
    },
    checkout: { createCheckout: fail('createCheckout'), testLink: fail('testLink') },
    tokens: { getToken: fail('getToken'), getScopes: fail('getScopes'), invalidate() {} },
    renderSnippets: () => ({ inline: '', loader: '' }),
    config,
    logger,
    clock: ctx.clock,
  };
  const app = new Hono().route('/admin', createAdminRoutes(deps));
  const get = (path: string, cookie?: string) => app.request(path, { headers: cookie === undefined ? {} : { cookie } });
  const post = (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
      body: new URLSearchParams(fields).toString(),
    });
  const login = async () => {
    const res = await post('/admin/login', { password: PASSWORD });
    const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(token !== undefined);
    const cookie = `${ADMIN_COOKIE}=${token}`;
    const session = auth.authenticate(cookie);
    assert.ok(session !== null);
    return { cookie, csrf: session.csrfToken };
  };
  return { repos: ctx.repos, app, get, post, login, rematched };
}

describe('central de operações', () => {
  it('mostra o quadro com a vitrine na primeira coluna, move, anota e gerencia colunas', async () => {
    const h = harness();
    const vitrine = makeStore(h.repos, 'vitrine', { name: 'Vitrine Quadro' });
    const { cookie, csrf } = await h.login();
    let text = await (await h.get('/admin/operations', cookie)).text();
    assert.ok(text.includes('<h1>Central de operações</h1>'));
    for (const col of ['Aquecendo', 'Pré Escala', 'Escala', 'Block']) assert.ok(text.includes(col), col);
    const first = text.indexOf('data-column="col_aquecendo"');
    const second = text.indexOf('data-column="col_pre_escala"');
    const card = text.indexOf('Vitrine Quadro');
    assert.ok(first !== -1 && card > first && card < second, 'vitrine sem etapa aparece na primeira coluna');
    assert.ok(!text.includes(' style=') && !text.includes('<script>'), 'sem código embutido (CSP)');

    assert.equal((await h.post('/admin/operations/move', { _csrf: csrf, store: vitrine.id, column: 'col_escala', position: '0' }, cookie)).status, 303);
    assert.equal(h.repos.board.card(vitrine.id)?.columnId, 'col_escala');

    assert.equal((await h.post('/admin/operations/note', { _csrf: csrf, store: vitrine.id, note: 'Loja nova <b>x</b>' }, cookie)).status, 303);
    text = await (await h.get('/admin/operations', cookie)).text();
    assert.ok(text.includes('Loja nova &lt;b&gt;x&lt;/b&gt;') && !text.includes('Loja nova <b>'));

    assert.equal((await h.post('/admin/operations/columns', { _csrf: csrf, name: 'Pausadas' }, cookie)).status, 303);
    assert.ok(h.repos.board.columns().some((c) => c.name === 'Pausadas'));
    assert.equal((await h.post('/admin/operations/columns/col_escala/delete', { _csrf: csrf }, cookie)).status, 303);
    assert.equal(h.repos.board.card(vitrine.id)?.columnId, null);
    // Sem CSRF o POST é recusado.
    assert.equal((await h.post('/admin/operations/move', { store: vitrine.id, column: 'col_block' }, cookie)).status, 403);
    // Busca filtra os cartões pelo nome.
    const filtered = await (await h.get('/admin/operations?q=nada-a-ver', cookie)).text();
    assert.ok(!filtered.includes('Vitrine Quadro'));
  });
});

describe('assistente de nova operação e central da operação', () => {
  it('cria a operação em três passos, liga vitrine aos checkouts e sincroniza', async () => {
    const h = harness();
    const vitrine = makeStore(h.repos, 'vitrine', { name: 'Vitrine X' });
    const a = makeStore(h.repos, 'checkout', { name: 'Checkout A' });
    const b = makeStore(h.repos, 'checkout', { name: 'Checkout B' });
    const { cookie, csrf } = await h.login();

    let text = await (await h.get('/admin/operations/new', cookie)).text();
    assert.ok(text.includes('Passo 1 de 3') && text.includes('Dê um nome à operação'));
    let res = await h.post('/admin/operations/new', { _csrf: csrf, step: '1', action: 'next', name_input: 'Minha Operação' }, cookie);
    text = await res.text();
    assert.ok(text.includes('Passo 2 de 3') && text.includes('Vitrine X'));
    res = await h.post('/admin/operations/new', { _csrf: csrf, step: '2', action: 'next', name: 'Minha Operação', vitrine_input: vitrine.id }, cookie);
    text = await res.text();
    assert.ok(text.includes('Passo 3 de 3') && text.includes('Checkout A') && text.includes('Checkout B'));

    res = await h.post('/admin/operations/new', { _csrf: csrf, step: '3', action: 'create', name: 'Minha Operação', vitrine: vitrine.id, [`checkout_${a.id}`]: '1', [`checkout_${b.id}`]: '1' }, cookie);
    assert.equal(res.status, 303);
    const links = h.repos.links.list({ vitrineStoreId: vitrine.id });
    assert.equal(links.length, 2);
    assert.deepEqual(links.filter((l) => l.enabled).map((l) => l.checkoutStoreId), [a.id], 'só o primeiro checkout fica ativo');
    assert.deepEqual(h.rematched.sort(), [[vitrine.id, a.id], [vitrine.id, b.id]].sort());
    assert.equal(h.repos.board.card(vitrine.id)?.title, 'Minha Operação');

    text = await (await h.get(`/admin/operations/${vitrine.id}`, cookie)).text();
    assert.ok(text.includes('<h1>Central da operação</h1>') && text.includes('Minha Operação'));
    assert.ok(text.includes('Ativo → Checkout A') && text.includes('Disponível'));

    const linkB = links.find((l) => l.checkoutStoreId === b.id)!;
    assert.equal((await h.post(`/admin/operations/${vitrine.id}/activate/${linkB.id}`, { _csrf: csrf }, cookie)).status, 303);
    assert.deepEqual(h.repos.links.list({ vitrineStoreId: vitrine.id, enabledOnly: true }).map((l) => l.checkoutStoreId), [b.id]);

    assert.equal((await h.post(`/admin/operations/${vitrine.id}/toggle`, { _csrf: csrf }, cookie)).status, 303);
    assert.equal(h.repos.links.list({ vitrineStoreId: vitrine.id, enabledOnly: true }).length, 0, 'pausar desliga as rotas');
    text = await (await h.get(`/admin/operations/${vitrine.id}`, cookie)).text();
    assert.ok(text.includes('Pausada'));
    assert.equal((await h.post(`/admin/operations/${vitrine.id}/toggle`, { _csrf: csrf }, cookie)).status, 303);
    assert.equal(h.repos.links.list({ vitrineStoreId: vitrine.id, enabledOnly: true }).length, 1, 'reativar liga uma rota padrão');
  });
});
