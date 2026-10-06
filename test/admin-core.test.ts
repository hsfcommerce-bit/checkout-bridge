import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { describe, it } from 'node:test';
import { ADMIN_COOKIE, createAdminAuth } from '../src/admin/auth.ts';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import { readForm, redirectTo, setFlash, takeFlash } from '../src/routes/admin/context.ts';
import type { AdminDeps } from '../src/routes/admin/context.ts';
import { createAdminRoutes } from '../src/routes/admin/index.ts';
import { isBridgeError } from '../src/types.ts';
import type { AdminSession, Store } from '../src/types.ts';
import { makeSession, makeStore, setup, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

const PASSWORD = 'senha-de-teste-123';
const SECURITY_HEADERS: Array<[string, string]> = [
  ['content-security-policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: https://cdn.shopify.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
];

/** Falha de propósito: nenhum teste deste arquivo deve chegar aos serviços de verdade. */
function unexpected(name: string): () => never {
  return () => {
    throw new Error(`${name} não deveria ser chamado neste teste`);
  };
}

interface Harness extends TestContext {
  app: Hono;
  deps: AdminDeps;
  login(): Promise<{ cookie: string; session: AdminSession }>;
  get(path: string, cookie?: string): Promise<Response>;
  post(path: string, fields: Record<string, string>, cookie?: string): Promise<Response>;
}

function harness(opts: { loginCapacity?: number; globalLoginCapacity?: number } = {}): Harness {
  const ctx = setup();
  const logger = createLogger({ level: 'silent', env: 'test' });
  const config = testConfig({ adminPassword: PASSWORD });
  const auth = createAdminAuth({
    adminSessions: ctx.repos.adminSessions,
    audit: ctx.repos.audit,
    config,
    loginLimiter: createRateLimiter({ capacity: opts.loginCapacity ?? 10, refillPerSecond: 1 / 60, clock: ctx.clock }),
    ...(opts.globalLoginCapacity === undefined
      ? {}
      : { globalLoginLimiter: createRateLimiter({ capacity: opts.globalLoginCapacity, refillPerSecond: 1 / 60, clock: ctx.clock }) }),
    logger,
    clock: ctx.clock,
  });
  const deps: AdminDeps = {
    repos: ctx.repos,
    auth,
    connection: { connect: unexpected('connection.connect') },
    sync: {
      syncStore: unexpected('sync.syncStore'),
      refreshProduct: unexpected('sync.refreshProduct'),
      removeProduct: unexpected('sync.removeProduct'),
      fetchShopInfo: unexpected('sync.fetchShopInfo'),
    },
    matcher: { rematchPair: unexpected('matcher.rematchPair'), rematchStore: unexpected('matcher.rematchStore') },
    checkout: { createCheckout: unexpected('checkout.createCheckout'), testLink: unexpected('checkout.testLink') },
    tokens: { getToken: unexpected('tokens.getToken'), getScopes: unexpected('tokens.getScopes'), invalidate() {} },
    renderSnippets: () => ({ inline: '<script></script>', loader: '<script src="x"></script>' }),
    config,
    logger,
    clock: ctx.clock,
  };
  const app = new Hono().route('/admin', createAdminRoutes(deps));

  const get = async (path: string, cookie?: string) =>
    app.request(path, { headers: cookie === undefined ? {} : { cookie } });
  const post = async (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(fields).toString(),
    });
  const login = async () => {
    const res = await post('/admin/login', { password: PASSWORD });
    assert.equal(res.status, 303);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(setCookie)?.[1];
    assert.ok(token !== undefined, 'login não devolveu o cookie');
    const cookie = `${ADMIN_COOKIE}=${token}`;
    const session = auth.authenticate(cookie);
    assert.ok(session !== null);
    return { cookie, session };
  };
  return { ...ctx, app, deps, login, get, post };
}

function assertSecurityHeaders(res: Response, opts: { asset?: boolean } = {}): void {
  for (const [name, value] of SECURITY_HEADERS) assert.equal(res.headers.get(name), value, name);
  if (opts.asset) assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/);
  else assert.equal(res.headers.get('cache-control'), 'no-store');
}

function assertNoInlineCode(htmlText: string): void {
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(htmlText), 'há <script> embutido');
  assert.ok(!/\sstyle\s*=/i.test(htmlText), 'há style= embutido');
  assert.ok(!/\son[a-z]+\s*=/i.test(htmlText), 'há atributo on*= embutido');
}

describe('login do painel', () => {
  it('GET /admin sem sessão redireciona para o login', async () => {
    const h = harness();
    const res = await h.get('/admin');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/login');
    assertSecurityHeaders(res);
  });

  it('GET /admin/login mostra o formulário com os cabeçalhos de segurança e sem código embutido', async () => {
    const h = harness();
    const res = await h.get('/admin/login');
    assert.equal(res.status, 200);
    assertSecurityHeaders(res);
    const text = await res.text();
    assert.ok(text.includes('name="password"'));
    assert.ok(text.includes('/admin/assets/app.css'));
    assertNoInlineCode(text);
  });

  it('senha certa cria a sessão com os atributos de cookie exigidos e abre o painel', async () => {
    const h = harness();
    const res = await h.post('/admin/login', { password: PASSWORD }, undefined);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin');
    const setCookie = res.headers.get('set-cookie') ?? '';
    for (const attr of ['Path=/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=43200', 'Secure']) {
      assert.ok(setCookie.includes(attr), `faltou ${attr}`);
    }
    const { cookie } = await h.login();
    const panel = await h.get('/admin', cookie);
    assert.equal(panel.status, 200);
    assertSecurityHeaders(panel);
    const text = await panel.text();
    assert.ok(text.includes('<h1>Dashboard</h1>'));
    assert.ok(text.includes('action="/admin/logout"'));
    assertNoInlineCode(text);
  });

  it('senha errada responde 401 com texto genérico; GET do login com sessão volta ao painel', async () => {
    const h = harness();
    const res = await h.post('/admin/login', { password: 'outra-senha-1234' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    const text = await res.text();
    assert.ok(text.includes('Não foi possível entrar'));
    assert.ok(!text.includes('outra-senha-1234'));
    const { cookie } = await h.login();
    const again = await h.get('/admin/login', cookie);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/admin');
  });

  it('limite de tentativas por IP responde 429', async () => {
    const h = harness({ loginCapacity: 2 });
    const attempt = () =>
      h.app.request('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' },
        body: 'password=errada-12345678',
      });
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '60');
    // Outro IP continua podendo entrar.
    assert.equal((await h.post('/admin/login', { password: PASSWORD })).status, 303);
  });

  it('X-Forwarded-For forjado à esquerda não escapa do limite por IP: vale o item que o proxy reverso acrescentou', async () => {
    const h = harness({ loginCapacity: 2 });
    const attempt = (n: number) =>
      h.app.request('/admin/login', {
        method: 'POST',
        // O navegador escreve "10.0.<n>.1"; o proxy reverso (TRUSTED_PROXY_HOPS=1) acrescenta o IP real.
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `10.0.${n}.1, 198.51.100.7` },
        body: 'password=errada-12345678',
      });
    const statuses: number[] = [];
    for (let n = 0; n < 4; n += 1) statuses.push((await attempt(n)).status);
    assert.deepEqual(statuses, [401, 401, 429, 429]);
    // Só as tentativas que passaram pelo limitador viram auditoria.
    assert.equal(tableCount(h.db, 'audit_log'), 2);
  });

  it('limite global de login vale somando todos os IPs, mesmo distintos de verdade', async () => {
    const h = harness({ loginCapacity: 10, globalLoginCapacity: 3 });
    const attempt = (last: number) =>
      h.app.request('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `198.51.100.${last}` },
        body: 'password=errada-12345678',
      });
    const statuses: number[] = [];
    for (let n = 1; n <= 5; n += 1) statuses.push((await attempt(n)).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    assert.equal(tableCount(h.db, 'audit_log'), 3);
    // O balde global é um só: a senha certa também espera a reposição.
    assert.equal((await h.post('/admin/login', { password: PASSWORD })).status, 429);
    h.clock.advance(60_000);
    assert.equal((await h.post('/admin/login', { password: PASSWORD })).status, 303);
  });

  it('sessão expirada volta a exigir login', async () => {
    const h = harness();
    const { cookie } = await h.login();
    h.clock.advance(12 * 60 * 60 * 1000 + 1);
    const res = await h.get('/admin', cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/login');
  });

  it('logout exige CSRF, apaga a sessão e limpa o cookie', async () => {
    const h = harness();
    const { cookie, session } = await h.login();
    assert.equal((await h.post('/admin/logout', {}, cookie)).status, 403);
    assert.equal((await h.post('/admin/logout', { _csrf: 'errado' }, cookie)).status, 403);
    const res = await h.post('/admin/logout', { _csrf: session.csrfToken }, cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/login');
    assert.ok((res.headers.get('set-cookie') ?? '').includes('Max-Age=0'));
    assert.equal((await h.get('/admin', cookie)).status, 303);
  });
});

describe('proteções comuns', () => {
  it('POST em rota protegida sem CSRF ou com CSRF errado responde 403', async () => {
    const h = harness();
    const { cookie, session } = await h.login();
    const none = await h.post('/admin/stores', {}, cookie);
    assert.equal(none.status, 403);
    assertSecurityHeaders(none);
    assert.ok((await none.text()).includes('Requisição recusada'));
    assert.equal((await h.post('/admin/stores', { _csrf: `${session.csrfToken}x` }, cookie)).status, 403);
    // Sem sessão nem chega à conferência de CSRF: vai para o login.
    assert.equal((await h.post('/admin/stores', { _csrf: session.csrfToken })).status, 303);
    // Com o token certo o middleware deixa passar: o que a rota responde a um formulário
    // vazio é assunto dela (404 na versão provisória, erro de validação na definitiva).
    const passed = await h.post('/admin/stores', { _csrf: session.csrfToken }, cookie);
    assert.notEqual(passed.status, 403);
    assert.notEqual(passed.headers.get('location'), '/admin/login');
  });

  it('cabeçalhos de segurança em 404, nos arquivos estáticos e na barra final', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const missing = await h.get('/admin/nao-existe', cookie);
    assert.equal(missing.status, 404);
    assertSecurityHeaders(missing);
    const css = await h.get('/admin/assets/app.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
    assertSecurityHeaders(css, { asset: true });
    const js = await h.get('/admin/assets/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assertSecurityHeaders(js, { asset: true });
    const slash = await h.get('/admin/', cookie);
    assert.equal(slash.status, 303);
    assert.equal(slash.headers.get('location'), '/admin');
  });

  it('escapa nome de loja com marcação em todas as páginas que o mostram', async () => {
    const h = harness();
    const evil = makeStore(h.repos, 'vitrine', { name: '<script>alert("x")</script><b>Loja</b>' });
    const checkout = makeStore(h.repos, 'checkout');
    h.repos.links.create({ vitrineStoreId: evil.id, checkoutStoreId: checkout.id, kind: 'default' });
    const { cookie } = await h.login();
    for (const path of ['/admin', '/admin/sessions']) {
      const text = await (await h.get(path, cookie)).text();
      assert.ok(!text.includes('<script>alert'), `${path} não escapou o nome`);
      assert.ok(!text.includes('<b>Loja</b>'), `${path} não escapou o nome`);
      assert.ok(text.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), `${path} não mostrou o nome escapado`);
      assertNoInlineCode(text);
    }
  });

  it('redirectTo só aceita caminhos dentro do painel', async () => {
    const app = new Hono().get('/go', (c) => redirectTo(c, c.req.query('to') ?? ''));
    const location = async (to: string) => (await app.request(`/go?to=${encodeURIComponent(to)}`)).headers.get('location');
    assert.equal(await location('/admin/stores?page=2'), '/admin/stores?page=2');
    assert.equal(await location('/admin'), '/admin');
    for (const bad of ['https://evil.example/admin', '//evil.example/admin', '/administrator', '/admin/../x', '/admin\\evil', 'admin', '']) {
      assert.equal(await location(bad), '/admin', `aceitou ${JSON.stringify(bad)}`);
    }
    assert.equal((await app.request('/go?to=/admin')).status, 303);
  });

  it('flash vai e volta pelo cookie uma única vez, limitado a 300 caracteres', async () => {
    const app = new Hono()
      .get('/set', (c) => {
        setFlash(c, { kind: 'ok', text: `Loja salva ${'x'.repeat(400)}` });
        return redirectTo(c, '/admin/x');
      })
      .get('/take', (c) => c.json(takeFlash(c)));
    const set = await app.request('/set');
    const setCookie = set.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.startsWith('cb_flash='));
    for (const attr of ['Path=/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=60']) assert.ok(setCookie.includes(attr), attr);
    const cookie = setCookie.split(';')[0] ?? '';
    const take = await app.request('/take', { headers: { cookie } });
    const flash = (await take.json()) as { kind: string; text: string };
    assert.equal(flash.kind, 'ok');
    assert.equal(flash.text.length, 300);
    assert.ok(flash.text.startsWith('Loja salva'));
    assert.ok((take.headers.get('set-cookie') ?? '').includes('Max-Age=0'));
    // Cookie forjado (sem assinatura válida) é ignorado.
    const forged = Buffer.from(JSON.stringify({ k: 'ok', t: 'forjado' })).toString('base64url');
    assert.equal(await (await app.request('/take', { headers: { cookie: `cb_flash=${forged}.00` } })).json(), null);
    assert.equal(await (await app.request('/take')).json(), null);
  });

  it('readForm limita o corpo a 64 KB, fica com o último valor e pode ser chamado duas vezes', async () => {
    const app = new Hono().post('/f', async (c) => {
      try {
        const first = await readForm(c);
        const second = await readForm(c);
        return c.json({ a: first['a'], b: second['b'], proto: Object.getPrototypeOf(second) === null });
      } catch (err) {
        return c.json({ error: isBridgeError(err) ? err.code : 'outro' }, 400);
      }
    });
    const send = (body: string) =>
      app.request('/f', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.deepEqual(await (await send('a=1&a=2&b=x')).json(), { a: '2', b: 'x', proto: true });
    const huge = await send(`a=${'z'.repeat(64 * 1024 + 1)}`);
    assert.equal(huge.status, 400);
    assert.deepEqual(await huge.json(), { error: 'invalid_request' });
    const json = await app.request('/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"1"}' });
    // Outro content-type resulta em formulário vazio (campos ausentes somem do JSON).
    assert.deepEqual(await json.json(), { proto: true });
  });
});

/** Vitrine, checkout, rota e três sessões (uma criada, duas falhas) para as páginas de relatório. */
function seed(h: Harness): { vitrine: Store; checkout: Store } {
  const vitrine = makeStore(h.repos, 'vitrine', { name: 'Vitrine Teste' });
  const checkout = makeStore(h.repos, 'checkout', { name: 'Checkout Teste' });
  h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
  const now = h.clock.now().toISOString();
  const base = { vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, createdAt: now, ipHash: 'f'.repeat(32) };
  const created = h.repos.sessions.insertPending(makeSession({ ...base, id: 'cs_criada_1', idempotencyKey: 'k1' }), now);
  h.repos.sessions.markCreated(created.session.id, {
    strategy: 'storefront_cart',
    checkoutUrl: 'https://checkout-teste.myshopify.com/cart/c/Z2NwLXVz?key=SEGREDO-DA-URL',
    cartId: 'gid://shopify/Cart/Z2NwLXVz?key=SEGREDO-DA-URL',
    subtotal: '79.80',
    currency: 'BRL',
  });
  for (const [id, code] of [['cs_falha_1', 'unmapped_variant'], ['cs_falha_2', 'upstream_unavailable']] as const) {
    const failed = h.repos.sessions.insertPending(makeSession({ ...base, id, idempotencyKey: id }), now);
    h.repos.sessions.markFailed(failed.session.id, code);
  }
  return { vitrine, checkout };
}

describe('páginas de relatório', () => {
  it('painel mostra lojas, rota com contagens, estatísticas e últimas falhas, sem URL nem IP', async () => {
    const h = harness();
    seed(h);
    const { cookie } = await h.login();
    const res = await h.get('/admin', cookie);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const expected of ['Vitrine Teste', 'Checkout Teste', 'Faturamento', 'checkouts criados', 'Vendas ao longo do tempo', 'cs_falha_1', 'cs_falha_2', 'Variante sem correspondência', 'Shopify indisponível']) {
      assert.ok(text.includes(expected), `faltou "${expected}"`);
    }
    assert.ok(!text.includes('key=SEGREDO'));
    assert.ok(!text.includes('f'.repeat(32)));
    assert.ok(!text.includes('cs_criada_1'), 'sessão criada não é falha');
    assertNoInlineCode(text);
  });

  it('painel vazio orienta a cadastrar loja e rota', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const text = await (await h.get('/admin', cookie)).text();
    assert.ok(text.includes('Nenhuma loja cadastrada'));
    assert.ok(text.includes('Nenhuma sessão encontrada'));
  });

  it('sessões lista com filtros por loja e status e esconde URL, carrinho e hash do IP', async () => {
    const h = harness();
    const { vitrine } = seed(h);
    const { cookie } = await h.login();
    const all = await (await h.get('/admin/sessions', cookie)).text();
    for (const expected of ['cs_criada_1', 'cs_falha_1', 'cs_falha_2', 'Carrinho (Storefront API)', 'Criada', 'Falhou', 'unmapped_variant', 'R$']) {
      assert.ok(all.includes(expected), `faltou "${expected}"`);
    }
    assert.ok(!all.includes('SEGREDO'));
    assert.ok(!all.includes('Z2NwLXVz'));
    assert.ok(!all.includes('f'.repeat(32)));

    const failed = await (await h.get(`/admin/sessions?status=failed&store=${vitrine.id}`, cookie)).text();
    assert.ok(!failed.includes('cs_criada_1'));
    assert.ok(failed.includes('cs_falha_1'));
    assert.ok(failed.includes(`value="${vitrine.id}" selected`));

    const other = await (await h.get('/admin/sessions?status=created&store=st_inexistente', cookie)).text();
    assert.ok(other.includes('cs_criada_1'));
    assert.ok(!other.includes('cs_falha_1'));

    const weird = await h.get('/admin/sessions?status=<x>&page=abc', cookie);
    assert.equal(weird.status, 200);
  });

  it('sessões pagina com "uma linha a mais" sem conhecer o total', async () => {
    const h = harness();
    const { vitrine, checkout } = seed(h);
    const now = h.clock.now().toISOString();
    for (let i = 0; i < 60; i += 1) {
      const id = `cs_lote_${i}`;
      h.repos.sessions.insertPending(makeSession({ id, idempotencyKey: id, vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, createdAt: now }), now);
    }
    const { cookie } = await h.login();
    const first = await (await h.get('/admin/sessions', cookie)).text();
    assert.ok(first.includes('href="/admin/sessions?page=2"'));
    assert.ok(first.includes('Página 1<'));
    assert.ok(!first.includes('Página 1 de'), 'não deve inventar total');
    const second = await (await h.get('/admin/sessions?page=2', cookie)).text();
    assert.ok(second.includes('href="/admin/sessions?page=1"'));
    assert.ok(!second.includes('href="/admin/sessions?page=3"'));
  });

  it('auditoria lista as entradas mais novas primeiro, com filtro por alvo', async () => {
    const h = harness();
    h.repos.audit.record({ actor: 'system', action: 'catalog.sync', targetType: 'store', targetId: 'st_1', detail: { variants: 12, token: 'nao-pode-aparecer' } });
    const { cookie } = await h.login();
    const text = await (await h.get('/admin/audit', cookie)).text();
    const loginAt = text.indexOf('admin.login');
    const syncAt = text.indexOf('catalog.sync');
    assert.ok(loginAt !== -1 && syncAt !== -1 && loginAt < syncAt, 'login (mais novo) deveria vir antes');
    assert.ok(text.includes('&quot;variants&quot;:12'));
    assert.ok(!text.includes('nao-pode-aparecer'));
    const filtered = await (await h.get('/admin/audit?targetType=store&targetId=st_1', cookie)).text();
    assert.ok(filtered.includes('catalog.sync'));
    assert.ok(!filtered.includes('admin.login'));
    assert.ok(filtered.includes('Ver todos'));
  });

  it('seções de lojas e rotas estão montadas atrás da sessão e usam a moldura do painel', async () => {
    const h = harness();
    for (const path of ['/admin/stores', '/admin/links']) {
      assert.equal((await h.get(path)).headers.get('location'), '/admin/login', path);
    }
    const { cookie } = await h.login();
    for (const path of ['/admin/stores', '/admin/links']) {
      const res = await h.get(path, cookie);
      assert.equal(res.status, 200, path);
      const text = await res.text();
      // Vale tanto para a versão provisória quanto para a definitiva: moldura, menu e CSP.
      assert.ok(text.includes('aria-current="page"'), path);
      assert.ok(text.includes('action="/admin/logout"'), path);
      assertNoInlineCode(text);
      assertSecurityHeaders(res);
    }
  });
});
