import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { describe, it } from 'node:test';
import { ADMIN_COOKIE, createAdminAuth } from '../src/admin/auth.ts';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import type { AdminDeps } from '../src/routes/admin/context.ts';
import { createAdminRoutes } from '../src/routes/admin/index.ts';
import type { AdminSession, ConnectionReport, MatchSummary, SyncResult } from '../src/types.ts';
import { makeStore, setup, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/**
 * Seção "Lojas" do painel com repositórios reais e serviços falsos. Cada falso registra as
 * chamadas recebidas para que os testes confirmem quem foi acionado e com qual id.
 */

const PASSWORD = 'senha-de-teste-123';
const SECRET = 'shpss_segredo_que_nao_pode_vazar';
const TOKEN = 'shpat_token_storefront_secreto';

function okReport(storeId: string): ConnectionReport {
  return {
    storeId,
    ok: true,
    steps: [
      { name: 'credentials', ok: true, detail: 'Credenciais válidas' },
      { name: 'scopes', ok: true, detail: 'Todos os escopos presentes' },
      { name: 'webhooks', ok: true, detail: '2 assinaturas criadas' },
      { name: 'catalog', ok: true, detail: '12 variantes' },
      { name: 'mappings', ok: true, detail: '1 par recalculado' },
    ],
    missingScopes: [],
    shop: { name: 'Loja Shopify', currency: 'BRL', primaryDomainHost: 'www.loja.com.br', myshopifyDomain: 'x.myshopify.com' },
  };
}

interface Calls {
  connect: string[];
  sync: string[];
  rematchStore: string[];
  invalidate: string[];
}

interface Harness extends TestContext {
  app: Hono;
  calls: Calls;
  login(): Promise<{ cookie: string; session: AdminSession; csrf: string }>;
  get(path: string, cookie?: string): Promise<Response>;
  post(path: string, fields: Record<string, string>, cookie?: string): Promise<Response>;
}

function harness(opts: { report?: (id: string) => ConnectionReport; syncOk?: boolean; rematchError?: boolean } = {}): Harness {
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
  const calls: Calls = { connect: [], sync: [], rematchStore: [], invalidate: [] };
  const fail = (name: string) => () => {
    throw new Error(`${name} não deveria ser chamado`);
  };
  const deps: AdminDeps = {
    repos: ctx.repos,
    auth,
    connection: {
      async connect(id) {
        calls.connect.push(id);
        return (opts.report ?? okReport)(id);
      },
    },
    sync: {
      async syncStore(id): Promise<SyncResult> {
        calls.sync.push(id);
        return opts.syncOk === false
          ? { storeId: id, ok: false, variants: 0, removed: 0, durationMs: 5, detail: 'token recusado' }
          : { storeId: id, ok: true, variants: 7, removed: 1, durationMs: 5, detail: null };
      },
      refreshProduct: fail('refreshProduct'),
      removeProduct: fail('removeProduct'),
      fetchShopInfo: fail('fetchShopInfo'),
    },
    matcher: {
      rematchPair: fail('rematchPair'),
      rematchStore(id): MatchSummary[] {
        calls.rematchStore.push(id);
        if (opts.rematchError === true) throw new Error('database is locked');
        return [];
      },
    },
    checkout: { createCheckout: fail('createCheckout'), testLink: fail('testLink') },
    tokens: {
      getToken: fail('getToken'),
      getScopes: fail('getScopes'),
      invalidate(id) {
        calls.invalidate.push(id);
      },
    },
    renderSnippets: (store) => ({
      inline: `<script>/* bridge ${store.proxyPath ?? ''} */</script>`,
      loader: `<script src="${store.proxyPath ?? ''}/bridge.js" defer></script>`,
    }),
    config,
    logger,
    clock: ctx.clock,
  };
  const app = new Hono().route('/admin', createAdminRoutes(deps));

  const get = async (path: string, cookie?: string) => app.request(path, { headers: cookie === undefined ? {} : { cookie } });
  const post = async (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
      body: new URLSearchParams(fields).toString(),
    });
  const login = async () => {
    const res = await post('/admin/login', { password: PASSWORD });
    assert.equal(res.status, 303);
    const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(token !== undefined, 'login não devolveu o cookie');
    const cookie = `${ADMIN_COOKIE}=${token}`;
    const session = auth.authenticate(cookie);
    assert.ok(session !== null);
    return { cookie, session, csrf: session.csrfToken };
  };
  return { ...ctx, app, calls, login, get, post };
}

/** Segue o redirect de um POST e devolve o corpo da página de destino (com o flash). */
async function follow(h: Harness, res: Response, cookie: string): Promise<{ location: string; text: string }> {
  assert.equal(res.status, 303, `esperava redirect, veio ${res.status}`);
  const location = res.headers.get('location') ?? '';
  // O flash vai num segundo cookie; o navegador mandaria os dois juntos.
  const flash = (res.headers.get('set-cookie') ?? '').split(/,(?=\s*cb_)/).find((c) => c.trim().startsWith('cb_flash='));
  const flashPair = flash === undefined ? '' : `; ${flash.split(';')[0]?.trim() ?? ''}`;
  const next = await h.get(location, `${cookie}${flashPair}`);
  assert.equal(next.status, 200);
  return { location, text: await next.text() };
}

function assertNoSecrets(text: string): void {
  assert.ok(!text.includes(SECRET), 'o client secret apareceu na resposta');
  assert.ok(!text.includes(TOKEN), 'o token de Storefront apareceu na resposta');
}

const VITRINE_FORM = {
  role: 'vitrine',
  name: 'Vitrine Nova',
  shopDomain: 'https://Vitrine-Nova.myshopify.com/admin/settings',
  clientId: 'cid-vitrine',
  clientSecret: SECRET,
  publicDomain: 'www.vitrine.com.br',
  proxyPath: '',
};

describe('lojas: listagem e cadastro', () => {
  it('lista as lojas agrupadas por papel e escapa marcação no nome', async () => {
    const h = harness();
    makeStore(h.repos, 'vitrine', { name: '<b>Vitrine</b> Má' });
    makeStore(h.repos, 'checkout', { name: 'Checkout Bom' });
    const { cookie } = await h.login();
    const text = await (await h.get('/admin/stores', cookie)).text();
    const vitrinesAt = text.indexOf('<h2>Vitrines</h2>');
    const checkoutsAt = text.indexOf('<h2>Lojas de checkout</h2>');
    assert.ok(vitrinesAt !== -1 && checkoutsAt !== -1);
    assert.ok(text.indexOf('&lt;b&gt;Vitrine&lt;/b&gt; Má') > vitrinesAt && text.indexOf('&lt;b&gt;Vitrine&lt;/b&gt; Má') < checkoutsAt);
    assert.ok(text.indexOf('Checkout Bom') > checkoutsAt);
    assert.ok(!text.includes('<b>Vitrine</b>'));
    assert.ok(text.includes('href="/admin/stores/new"'));
  });

  it('cria uma vitrine a partir de um domínio colado, conecta e mostra o relatório', async () => {
    const h = harness();
    const { cookie, csrf } = await h.login();
    const created = await h.post('/admin/stores', { ...VITRINE_FORM, _csrf: csrf }, cookie);
    const store = h.repos.stores.list()[0];
    assert.ok(store !== undefined);
    assert.equal(store.shopDomain, 'vitrine-nova.myshopify.com');
    assert.equal(store.proxyPath, '/apps/checkout-bridge');
    assert.equal(store.publicDomain, 'www.vitrine.com.br');
    assert.equal(h.repos.stores.getSecrets(store.id).clientSecret, SECRET);
    assert.deepEqual(h.calls.connect, [store.id]);

    const { location, text } = await follow(h, created, cookie);
    assert.equal(location, `/admin/stores/${store.id}`);
    assert.ok(text.includes('Loja cadastrada e conectada.'));
    assert.ok(text.includes('Resultado da última conexão'));
    assert.ok(text.includes('2 assinaturas criadas'));
    assert.ok(text.includes('Loja Shopify'));
    assertNoSecrets(text);
    const audit = h.repos.audit.list({ limit: 10, offset: 0 }).map((e) => e.action);
    assert.ok(audit.includes('store.create'));
  });

  it('erro de validação volta ao formulário com os campos preenchidos, menos o segredo', async () => {
    const h = harness();
    const { cookie, csrf } = await h.login();
    const res = await h.post('/admin/stores', { ...VITRINE_FORM, shopDomain: 'loja.exemplo.com', _csrf: csrf }, cookie);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.includes('Domínio inválido'));
    assert.ok(text.includes('value="Vitrine Nova"'));
    assert.ok(text.includes('value="loja.exemplo.com"'));
    assert.ok(text.includes('value="cid-vitrine"'));
    assertNoSecrets(text);
    assert.equal(h.repos.stores.list().length, 0);
    assert.deepEqual(h.calls.connect, []);
  });

  it('domínio repetido vira mensagem de conflito (409)', async () => {
    const h = harness();
    makeStore(h.repos, 'vitrine', { shopDomain: 'vitrine-nova.myshopify.com' });
    const { cookie, csrf } = await h.login();
    const res = await h.post('/admin/stores', { ...VITRINE_FORM, _csrf: csrf }, cookie);
    assert.equal(res.status, 409);
    assert.ok((await res.text()).includes('Já existe uma loja com esse domínio'));
  });

  it('checkout com modo por token exige o token; com ele, guarda cifrado', async () => {
    const h = harness();
    const { cookie, csrf } = await h.login();
    const base = { role: 'checkout', name: 'Checkout', shopDomain: 'chk.myshopify.com', clientId: 'cid', clientSecret: SECRET, storefrontAuthMode: 'private_token', _csrf: csrf };
    const missing = await h.post('/admin/stores', base, cookie);
    assert.equal(missing.status, 400);
    assert.ok((await missing.text()).includes('exige um token'));
    const ok = await h.post('/admin/stores', { ...base, storefrontToken: TOKEN }, cookie);
    assert.equal(ok.status, 303);
    const store = h.repos.stores.list()[0];
    assert.ok(store !== undefined);
    assert.equal(store.storefrontAuthMode, 'private_token');
    assert.equal(store.hasStorefrontToken, true);
    assert.equal(h.repos.stores.getSecrets(store.id).storefrontToken, TOKEN);
  });
});

describe('lojas: página da loja', () => {
  it('vitrine mostra escopos, valores do App Proxy, ping, trechos do tema e aviso dos botões acelerados', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'vitrine', { proxyPath: '/apps/ponte', publicDomain: 'www.loja.com.br', clientSecret: SECRET });
    const { cookie } = await h.login();
    const text = await (await h.get(`/admin/stores/${store.id}`, cookie)).text();
    for (const scope of ['read_products', 'read_inventory', 'write_app_proxy']) assert.ok(text.includes(`<code>${scope}</code>`), scope);
    assert.ok(text.includes('<dt>Subpath prefix</dt><dd><code>apps</code></dd>'));
    assert.ok(text.includes('<dt>Subpath</dt><dd><code>ponte</code></dd>'));
    assert.ok(text.includes('<code>https://bridge.test/proxy</code>'));
    assert.ok(text.includes('https://www.loja.com.br/apps/ponte/ping'));
    assert.ok(text.includes('id="snippet-inline"') && text.includes('readonly'));
    assert.ok(text.includes('&lt;script&gt;/* bridge /apps/ponte */&lt;/script&gt;'), 'o trecho vai dentro do textarea, escapado');
    assert.ok(text.includes('data-copy="#snippet-inline"') && text.includes('data-copy="#snippet-loader"'));
    assert.ok(text.includes('a cada visualização de página'));
    assert.ok(text.includes('checkout acelerado') && text.includes('Shop Pay'));
    assert.ok(text.includes('https://bridge.test/webhooks/shopify'));
    assertNoSecrets(text);
  });

  it('checkout mostra escopos, modos da Storefront API, publicação, senha da loja e webhooks', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'checkout', { clientSecret: SECRET, storefrontAuthMode: 'private_token', storefrontToken: TOKEN });
    const { cookie } = await h.login();
    const text = await (await h.get(`/admin/stores/${store.id}`, cookie)).text();
    assert.ok(text.includes('<code>read_products</code>') && text.includes('<code>read_inventory</code>'));
    assert.ok(!text.includes('write_app_proxy'));
    assert.ok(text.includes('Sem token:') && text.includes('Token privado:') && text.includes('Token público:'));
    assert.ok(text.includes('publicados no canal de vendas'));
    assert.ok(text.includes('senha da loja virtual'));
    assert.ok(text.includes('<code>https://bridge.test/webhooks/shopify</code>'));
    assert.ok(text.includes('Há um token guardado.'));
    assertNoSecrets(text);
  });

  it('loja inexistente dá 404 com a moldura do painel', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const res = await h.get('/admin/stores/st_nao_existe', cookie);
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes('Loja não encontrada'));
  });
});

describe('lojas: edição e ações', () => {
  it('segredo em branco mantém o guardado; segredo novo substitui e invalida o token em cache', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'checkout', { clientSecret: SECRET, storefrontAuthMode: 'public_token', storefrontToken: TOKEN });
    const { cookie, csrf } = await h.login();
    const keep = await h.post(`/admin/stores/${store.id}`, { name: 'Renomeada', clientId: store.clientId, clientSecret: '', storefrontAuthMode: 'public_token', storefrontToken: '', _csrf: csrf }, cookie);
    const kept = await follow(h, keep, cookie);
    assert.ok(kept.text.includes('Loja salva.'));
    assert.equal(h.repos.stores.get(store.id)?.name, 'Renomeada');
    assert.deepEqual(h.repos.stores.getSecrets(store.id), { clientSecret: SECRET, storefrontToken: TOKEN });
    assert.deepEqual(h.calls.invalidate, []);
    assertNoSecrets(kept.text);

    const change = await h.post(`/admin/stores/${store.id}`, { name: 'Renomeada', clientId: 'cid-novo', clientSecret: 'novo-segredo', storefrontAuthMode: 'tokenless', storefrontToken: '', _csrf: csrf }, cookie);
    const changed = await follow(h, change, cookie);
    assert.ok(changed.text.includes('Credenciais alteradas'));
    assert.deepEqual(h.repos.stores.getSecrets(store.id), { clientSecret: 'novo-segredo', storefrontToken: TOKEN });
    assert.equal(h.repos.stores.get(store.id)?.storefrontAuthMode, 'tokenless');
    assert.deepEqual(h.calls.invalidate, [store.id]);
    const entry = h.repos.audit.list({ limit: 10, offset: 0 }).find((e) => e.action === 'store.update');
    assert.ok(entry !== undefined);
    assert.ok(!JSON.stringify(entry.detail).includes('novo-segredo'));
  });

  it('edição inválida mostra o erro ao lado do formulário sem perder o nome digitado', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'vitrine');
    const { cookie, csrf } = await h.login();
    const res = await h.post(`/admin/stores/${store.id}`, { name: 'Nome Novo', clientId: '', proxyPath: '', _csrf: csrf }, cookie);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.includes('Informe o client ID'));
    assert.ok(text.includes('value="Nome Novo"'));
    assert.equal(h.repos.stores.get(store.id)?.name, store.name);
  });

  it('conectar, sincronizar, desativar e reativar acionam os serviços e mudam o status', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'vitrine');
    const { cookie, csrf } = await h.login();
    const connected = await follow(h, await h.post(`/admin/stores/${store.id}/connect`, { _csrf: csrf }, cookie), cookie);
    assert.ok(connected.text.includes('Conexão verificada com sucesso.'));
    assert.deepEqual(h.calls.connect, [store.id]);

    const synced = await follow(h, await h.post(`/admin/stores/${store.id}/sync`, { _csrf: csrf }, cookie), cookie);
    assert.ok(synced.text.includes('7 variantes (1 removidas)'));
    assert.deepEqual(h.calls.sync, [store.id]);
    assert.deepEqual(h.calls.rematchStore, [store.id]);

    const disabled = await follow(h, await h.post(`/admin/stores/${store.id}/disable`, { _csrf: csrf }, cookie), cookie);
    assert.ok(disabled.text.includes('Loja desativada.'));
    assert.equal(h.repos.stores.get(store.id)?.status, 'disabled');
    assert.ok(disabled.text.includes('action="/admin/stores/' + store.id + '/enable"'));

    const enabled = await follow(h, await h.post(`/admin/stores/${store.id}/enable`, { _csrf: csrf }, cookie), cookie);
    assert.ok(enabled.text.includes('Loja reativada.'));
    assert.equal(h.repos.stores.get(store.id)?.status, 'pending');
  });

  it('sincronização que falha não recalcula mapeamentos e avisa', async () => {
    const h = harness({ syncOk: false });
    const store = makeStore(h.repos, 'checkout');
    const { cookie, csrf } = await h.login();
    const { text } = await follow(h, await h.post(`/admin/stores/${store.id}/sync`, { _csrf: csrf }, cookie), cookie);
    assert.ok(text.includes('Sincronização falhou: token recusado'));
    assert.deepEqual(h.calls.rematchStore, []);
  });

  it('recálculo que falha depois da sincronização vira aviso e auditoria, não página de erro', async () => {
    const h = harness({ rematchError: true });
    const store = makeStore(h.repos, 'vitrine');
    const { cookie, csrf } = await h.login();
    const { location, text } = await follow(h, await h.post(`/admin/stores/${store.id}/sync`, { _csrf: csrf }, cookie), cookie);
    assert.equal(location, `/admin/stores/${store.id}`);
    // O catálogo foi sincronizado de fato; só o recálculo falhou, e o lojista sabe disso.
    assert.ok(text.includes('7 variantes (1 removidas)'));
    assert.ok(text.includes('O recálculo dos mapeamentos falhou'));
    assert.deepEqual(h.calls.sync, [store.id]);
    assert.deepEqual(h.calls.rematchStore, [store.id]);
    const entry = h.repos.audit.list({ limit: 10, offset: 0 }).find((e) => e.action === 'store.sync');
    assert.ok(entry);
    assert.equal(entry.detail['ok'], true);
    assert.equal(entry.detail['rematchFailed'], true);
  });

  it('remover exige o domínio digitado e apaga a loja com o que depende dela', async () => {
    const h = harness();
    const vitrine = makeStore(h.repos, 'vitrine');
    const checkout = makeStore(h.repos, 'checkout');
    h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const { cookie, csrf } = await h.login();
    const wrong = await h.post(`/admin/stores/${vitrine.id}/delete`, { confirmDomain: 'outra.myshopify.com', _csrf: csrf }, cookie);
    assert.equal(wrong.status, 400);
    assert.ok((await wrong.text()).includes('digite o domínio dela'));
    assert.ok(h.repos.stores.get(vitrine.id) !== null);

    const right = await h.post(`/admin/stores/${vitrine.id}/delete`, { confirmDomain: ` https://${vitrine.shopDomain}/admin `, _csrf: csrf }, cookie);
    const { location, text } = await follow(h, right, cookie);
    assert.equal(location, '/admin/stores');
    assert.ok(text.includes('removida.'));
    assert.equal(h.repos.stores.get(vitrine.id), null);
    assert.equal(tableCount(h.db, 'links'), 0);
    assert.deepEqual(h.calls.invalidate, [vitrine.id]);
  });

  it('todo POST exige o token de CSRF', async () => {
    const h = harness();
    const store = makeStore(h.repos, 'vitrine');
    const { cookie } = await h.login();
    const paths = ['', '/connect', '/sync', '/disable', '/enable', '/delete'].map((p) => `/admin/stores/${store.id}${p}`);
    paths.push('/admin/stores');
    for (const path of paths) {
      const res = await h.post(path, { name: 'x', confirmDomain: store.shopDomain }, cookie);
      assert.equal(res.status, 403, path);
    }
    assert.equal(h.repos.stores.get(store.id)?.name, store.name);
    assert.deepEqual(h.calls.connect, []);
  });
});
