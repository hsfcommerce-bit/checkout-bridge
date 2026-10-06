import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { describe, it } from 'node:test';
import { ADMIN_COOKIE, createAdminAuth } from '../src/admin/auth.ts';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import type { AdminDeps } from '../src/routes/admin/context.ts';
import { createAdminRoutes } from '../src/routes/admin/index.ts';
import { fmtMoney } from '../src/routes/admin/layout.ts';
import { parsePairs } from '../src/routes/admin/mappings.ts';
import type { AdminSession, Link, LinkTestResult, MatchSummary, Store } from '../src/types.ts';
import { makeMapping, makeStore, makeVariant, setup } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

/**
 * Seção "Rotas" do painel (rotas e mapeamentos) com repositórios reais e serviços falsos.
 * O casamento automático é um falso que só registra o par pedido: o que interessa aqui é
 * que o painel aciona a coisa certa e grava o que prometeu no repositório.
 */

const PASSWORD = 'senha-de-teste-123';

interface Calls {
  rematchPair: Array<[string, string]>;
  testLink: string[];
}

interface Harness extends TestContext {
  app: Hono;
  calls: Calls;
  testResult: (linkId: string) => LinkTestResult;
  login(): Promise<{ cookie: string; session: AdminSession; csrf: string }>;
  get(path: string, cookie?: string): Promise<Response>;
  post(path: string, fields: Record<string, string>, cookie?: string): Promise<Response>;
}

function harness(): Harness {
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
  const calls: Calls = { rematchPair: [], testLink: [] };
  const fail = (name: string) => () => {
    throw new Error(`${name} não deveria ser chamado`);
  };
  const h: Partial<Harness> = {
    testResult: (linkId) => ({ linkId, ok: true, strategy: 'storefront_cart', tested: 3, problems: [], detail: null }),
  };
  const deps: AdminDeps = {
    repos: ctx.repos,
    auth,
    connection: { connect: fail('connect') },
    sync: { syncStore: fail('syncStore'), refreshProduct: fail('refreshProduct'), removeProduct: fail('removeProduct'), fetchShopInfo: fail('fetchShopInfo') },
    matcher: {
      rematchPair(vitrineStoreId, checkoutStoreId): MatchSummary {
        calls.rematchPair.push([vitrineStoreId, checkoutStoreId]);
        return { vitrineStoreId, checkoutStoreId, counts: ctx.repos.mappings.counts(vitrineStoreId, checkoutStoreId) };
      },
      rematchStore: fail('rematchStore'),
    },
    checkout: {
      createCheckout: fail('createCheckout'),
      async testLink(linkId) {
        calls.testLink.push(linkId);
        return (h.testResult ?? fail('testResult'))(linkId);
      },
    },
    tokens: { getToken: fail('getToken'), getScopes: fail('getScopes'), invalidate() {} },
    renderSnippets: () => ({ inline: '', loader: '' }),
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
  return Object.assign(h, { ...ctx, app, calls, login, get, post }) as Harness;
}

/** Segue o redirect de um POST levando o cookie de flash junto e devolve a página de destino. */
async function follow(h: Harness, res: Response, cookie: string): Promise<{ location: string; text: string }> {
  assert.equal(res.status, 303, `esperava redirect, veio ${res.status}`);
  const location = res.headers.get('location') ?? '';
  const flash = (res.headers.get('set-cookie') ?? '').split(/,(?=\s*cb_)/).find((c) => c.trim().startsWith('cb_flash='));
  const flashPair = flash === undefined ? '' : `; ${flash.split(';')[0]?.trim() ?? ''}`;
  const next = await h.get(location, `${cookie}${flashPair}`);
  assert.equal(next.status, 200, `destino ${location} respondeu ${next.status}`);
  return { location, text: await next.text() };
}

function pair(h: Harness): { vitrine: Store; checkout: Store } {
  return { vitrine: makeStore(h.repos, 'vitrine', { name: 'Vitrine A' }), checkout: makeStore(h.repos, 'checkout', { name: 'Checkout B' }) };
}

function linkForm(vitrine: Store, checkout: Store, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    vitrineStoreId: vitrine.id,
    checkoutStoreId: checkout.id,
    kind: 'default',
    countries: '',
    strategy: 'storefront_cart',
    parityPolicy: 'block',
    tolerancePercent: '0,5',
    maxQuantityPerLine: '20',
    maxLines: '50',
    allowPermalinkFallback: '1',
    enabled: '1',
    ...overrides,
  };
}

/**
 * Catálogo e mapeamentos de exemplo para a lista: um sugerido, um conflito com dois
 * candidatos, um ativo com divergência de preço, um sem destino e um título com marcação.
 */
function seedMappings(h: Harness, vitrine: Store, checkout: Store): Link {
  const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default', priceToleranceBps: 100 });
  h.repos.catalog.upsertVariants([
    makeVariant(vitrine.id, '101', { productTitle: 'Camiseta Azul', sku: 'AZ-M', price: '50.00' }),
    makeVariant(vitrine.id, '102', { productTitle: 'Boné <img src=x onerror=alert(1)>', sku: 'BONE', price: '30.00' }),
    makeVariant(vitrine.id, '103', { productTitle: 'Tênis Corrida', sku: 'TEN-42', price: '200.00' }),
    makeVariant(vitrine.id, '104', { productTitle: 'Meia Lisa', sku: 'MEIA', price: '10.00' }),
  ]);
  h.repos.catalog.upsertVariants([
    makeVariant(checkout.id, '9101', { productTitle: 'Camiseta Azul', sku: 'AZ-M', price: '50.00' }),
    makeVariant(checkout.id, '9102', { productTitle: 'Boné', sku: 'BONE', price: '30.00' }),
    makeVariant(checkout.id, '9112', { productTitle: 'Boné Premium', sku: 'BONE-P', price: '45.00' }),
    makeVariant(checkout.id, '9103', { productTitle: 'Tênis Corrida', sku: 'TEN-42', price: '250.00' }),
    makeVariant(checkout.id, '9999', { productTitle: 'Meia Listrada', sku: 'MEIA-L', price: '12.00' }),
  ]);
  h.repos.mappings.upsertAuto([
    makeMapping(vitrine.id, checkout.id, '101', { status: 'suggested', method: 'title_options' }),
    makeMapping(vitrine.id, checkout.id, '102', { status: 'conflict', method: null, checkoutVariantId: null, candidates: ['9102', '9112'] }),
    makeMapping(vitrine.id, checkout.id, '103', { status: 'active', method: 'sku', divergences: [{ kind: 'price', vitrine: '200.00', checkout: '250.00' }] }),
    makeMapping(vitrine.id, checkout.id, '104', { status: 'unmapped', method: null, checkoutVariantId: null }),
  ]);
  return link;
}

describe('rotas: listagem e criação', () => {
  it('lista as rotas agrupadas por vitrine com destino, tipo, estratégia, paridade, ativa e contagens', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const other = makeStore(h.repos, 'vitrine', { name: 'Vitrine Vazia' });
    h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default', priceToleranceBps: 50 });
    h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'country', countries: ['BR', 'PT'], enabled: false, strategy: 'permalink', parityPolicy: 'off' });
    h.repos.mappings.upsertAuto([makeMapping(vitrine.id, checkout.id, '1'), makeMapping(vitrine.id, checkout.id, '2', { status: 'conflict', candidates: ['91', '92'] })]);
    const { cookie } = await h.login();
    const text = await (await h.get('/admin/links', cookie)).text();
    // As duas vitrines nascem no mesmo instante do relógio falso, então a ordem entre os
    // cartões não é garantida; o que importa é cada rota estar no cartão da sua vitrine.
    const aAt = text.indexOf('<h2>Vitrine A');
    const vaziaAt = text.indexOf('<h2>Vitrine Vazia');
    assert.ok(aAt !== -1 && vaziaAt !== -1);
    const cardOf = (start: number) => text.slice(start, text.indexOf('</section>', start));
    assert.ok(cardOf(vaziaAt).includes('Nenhuma rota para esta vitrine.'));
    assert.ok(!cardOf(aAt).includes('Nenhuma rota para esta vitrine.'));
    assert.ok(cardOf(aAt).includes('<dd>Padrão</dd>'));
    assert.ok(text.includes('>Checkout B</a>'));
    assert.ok(text.includes('<dd>Padrão</dd>') && text.includes('<dd>Países: BR, PT</dd>'));
    assert.ok(text.includes('Carrinho pela API (recomendado)') && text.includes('Link direto de carrinho'));
    assert.ok(text.includes('(0,5%)'));
    assert.ok(text.includes('badge-ok">Ativa') && text.includes('badge-muted">Desativada'));
    assert.ok(text.includes('1 ativos') && text.includes('1 em conflito'));
    assert.ok(text.indexOf('Nenhuma rota para esta vitrine.') > vaziaAt);
    assert.ok(other.id !== vitrine.id);
  });

  it('o formulário de nova rota oferece as lojas e as duas estratégias com os rótulos certos', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const { cookie } = await h.login();
    const text = await (await h.get(`/admin/links/new?vitrine=${vitrine.id}`, cookie)).text();
    assert.ok(text.includes(`<option value="${vitrine.id}" selected>Vitrine A`));
    assert.ok(text.includes(`<option value="${checkout.id}" >Checkout B`));
    assert.ok(text.includes('<option value="storefront_cart" selected>Carrinho pela API (recomendado)</option>'));
    assert.ok(text.includes('<option value="permalink" >Link direto de carrinho</option>'));
    assert.ok(text.includes('max="100"'));
  });

  it('cria a rota convertendo a tolerância em pontos-base e recalcula o par', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const { cookie, csrf } = await h.login();
    const res = await h.post('/admin/links', { ...linkForm(vitrine, checkout, { kind: 'country', countries: 'br, PT;ar' }), _csrf: csrf }, cookie);
    const link = h.repos.links.list()[0];
    assert.ok(link !== undefined);
    assert.deepEqual(
      { kind: link.kind, countries: link.countries, bps: link.priceToleranceBps, qty: link.maxQuantityPerLine, lines: link.maxLines, strategy: link.strategy, fallback: link.allowPermalinkFallback, enabled: link.enabled },
      // O repositório normaliza (maiúsculas) e ordena os códigos.
      { kind: 'country', countries: ['AR', 'BR', 'PT'], bps: 50, qty: 20, lines: 50, strategy: 'storefront_cart', fallback: true, enabled: true },
    );
    assert.deepEqual(h.calls.rematchPair, [[vitrine.id, checkout.id]]);
    const { location, text } = await follow(h, res, cookie);
    assert.equal(location, `/admin/links/${link.id}`);
    assert.ok(text.includes('Rota criada.') && text.includes('Mapeamento recalculado'));
    assert.ok(text.includes('Países: AR, BR, PT'));
    assert.ok(h.repos.audit.list({ limit: 5, offset: 0 }).some((e) => e.action === 'link.create' && e.targetId === link.id));
  });

  it('segunda rota default e país repetido viram mensagens claras de conflito, sem perder o digitado', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'country', countries: ['BR'] });
    const { cookie, csrf } = await h.login();
    const second = await h.post('/admin/links', { ...linkForm(vitrine, checkout, { tolerancePercent: '1,25' }), _csrf: csrf }, cookie);
    assert.equal(second.status, 409);
    const text = await second.text();
    assert.ok(text.includes('A vitrine já tem uma rota default ativa') && text.includes('Desative ou edite a outra rota'));
    assert.ok(text.includes('value="1,25"'));
    const country = await h.post('/admin/links', { ...linkForm(vitrine, checkout, { kind: 'country', countries: 'PT, BR' }), _csrf: csrf }, cookie);
    assert.equal(country.status, 409);
    assert.ok((await country.text()).includes('País já atendido por outra rota ativa da vitrine (BR)'));
    assert.equal(h.repos.links.list().length, 2);
    assert.deepEqual(h.calls.rematchPair, []);
  });

  it('valida limites e campos antes de chegar ao repositório', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const { cookie, csrf } = await h.login();
    const cases: Array<[Record<string, string>, string]> = [
      [{ maxLines: '101' }, 'Máximo de linhas inválido'],
      [{ kind: 'country', countries: '' }, 'exige pelo menos um código de país'],
      [{ tolerancePercent: 'abc' }, 'Tolerância de preço inválida'],
      [{ maxQuantityPerLine: '0' }, 'Quantidade máxima por variante inválida'],
      [{ checkoutStoreId: '' }, 'Escolha a loja de checkout'],
      [{ kind: 'country', countries: 'XYZ' }, 'Código de país inválido'],
    ];
    for (const [overrides, message] of cases) {
      const res = await h.post('/admin/links', { ...linkForm(vitrine, checkout, overrides), _csrf: csrf }, cookie);
      assert.equal(res.status, 400, message);
      assert.ok((await res.text()).includes(message), message);
    }
    assert.equal(h.repos.links.list().length, 0);
  });
});

describe('rotas: página e ações', () => {
  it('mostra a rota, as contagens e os botões; rota inexistente dá 404', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie } = await h.login();
    const text = await (await h.get(`/admin/links/${link.id}`, cookie)).text();
    assert.ok(text.includes('Rota: Vitrine A → Checkout B'));
    assert.ok(text.includes('1 ativos') && text.includes('1 sugeridos') && text.includes('1 em conflito') && text.includes('1 sem destino') && text.includes('1 divergentes'));
    for (const action of ['rematch', 'test', 'disable', 'delete']) assert.ok(text.includes(`action="/admin/links/${link.id}/${action}"`), action);
    assert.ok(text.includes(`href="/admin/links/${link.id}/mappings"`));
    assert.ok(!/volume|cota|quota|failover|balance/i.test(text), 'nenhum controle de seleção automática de destino');
    assert.equal((await h.get('/admin/links/ln_nada', cookie)).status, 404);
  });

  it('edita a rota; mudança de tolerância recalcula o par, as outras não', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const { cookie, csrf } = await h.login();
    const first = await h.post(`/admin/links/${link.id}`, { ...linkForm(vitrine, checkout, { strategy: 'permalink', parityPolicy: 'warn', tolerancePercent: '2', enabled: '' }), _csrf: csrf }, cookie);
    const { text } = await follow(h, first, cookie);
    assert.ok(text.includes('Rota salva.') && text.includes('Mapeamento recalculado'));
    const updated = h.repos.links.get(link.id);
    assert.deepEqual(
      { strategy: updated?.strategy, policy: updated?.parityPolicy, bps: updated?.priceToleranceBps, enabled: updated?.enabled },
      { strategy: 'permalink', policy: 'warn', bps: 200, enabled: false },
    );
    assert.deepEqual(h.calls.rematchPair, [[vitrine.id, checkout.id]]);
    const second = await h.post(`/admin/links/${link.id}`, { ...linkForm(vitrine, checkout, { tolerancePercent: '2' }), _csrf: csrf }, cookie);
    assert.equal(second.status, 303);
    assert.equal(h.calls.rematchPair.length, 1);
    const bad = await h.post(`/admin/links/${link.id}`, { ...linkForm(vitrine, checkout, { maxLines: '0' }), _csrf: csrf }, cookie);
    assert.equal(bad.status, 400);
  });

  it('testar rota chama o serviço e mostra uma linha por problema', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    h.testResult = (linkId) => ({
      linkId,
      ok: false,
      strategy: 'storefront_cart',
      tested: 2,
      problems: [
        { vitrineVariantId: '101', checkoutVariantId: '9101', problem: 'Produto não publicado no canal' },
        { vitrineVariantId: '103', checkoutVariantId: null, problem: 'Sem estoque' },
      ],
      detail: 'Carrinho de teste criado com avisos',
    });
    const { cookie, csrf } = await h.login();
    const { text } = await follow(h, await h.post(`/admin/links/${link.id}/test`, { _csrf: csrf }, cookie), cookie);
    assert.deepEqual(h.calls.testLink, [link.id]);
    assert.ok(text.includes('encontrou problemas'));
    assert.ok(text.includes('Resultado do teste da rota'));
    assert.ok(text.includes('Variantes testadas: 2'));
    assert.ok(text.includes('<li><span class="mono">101</span> → <span class="mono">9101</span>: Produto não publicado no canal</li>'));
    assert.ok(text.includes('<span class="mono">103</span> → <span class="mono">—</span>: Sem estoque'));
    assert.ok(text.includes('Carrinho de teste criado com avisos'));
  });

  it('desativa, reativa (respeitando a unicidade) e exclui a rota', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const { cookie, csrf } = await h.login();
    const off = await follow(h, await h.post(`/admin/links/${link.id}/disable`, { _csrf: csrf }, cookie), cookie);
    assert.ok(off.text.includes('Rota desativada.'));
    assert.equal(h.repos.links.get(link.id)?.enabled, false);
    assert.ok(off.text.includes(`action="/admin/links/${link.id}/enable"`));

    // Outra default ficou ativa nesse meio-tempo: reativar esta é conflito.
    const rival = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const clash = await h.post(`/admin/links/${link.id}/enable`, { _csrf: csrf }, cookie);
    assert.equal(clash.status, 409);
    assert.ok((await clash.text()).includes('já tem uma rota default ativa'));
    h.repos.links.delete(rival.id);
    const on = await follow(h, await h.post(`/admin/links/${link.id}/enable`, { _csrf: csrf }, cookie), cookie);
    assert.ok(on.text.includes('Rota ativada.'));
    assert.equal(h.repos.links.get(link.id)?.enabled, true);

    // Sem confirmação explícita o POST só mostra a página de confirmação (no servidor,
    // sem depender do script do painel) e nada é apagado.
    const ask = await h.post(`/admin/links/${link.id}/delete`, { _csrf: csrf }, cookie);
    assert.equal(ask.status, 200);
    const askText = await ask.text();
    assert.ok(askText.includes('Excluir a rota') && askText.includes('name="confirm" value="sim"'));
    assert.ok(askText.includes('ficam sem checkout'), 'avisa que a rota está ativa');
    assert.ok(h.repos.links.get(link.id) !== null);
    assert.ok(!h.repos.audit.list({ limit: 10, offset: 0 }).some((e) => e.action === 'link.delete'));
    const gone = await follow(h, await h.post(`/admin/links/${link.id}/delete`, { _csrf: csrf, confirm: 'sim' }, cookie), cookie);
    assert.equal(gone.location, '/admin/links');
    assert.ok(gone.text.includes('Rota excluída.'));
    assert.equal(h.repos.links.get(link.id), null);
    const actions = h.repos.audit.list({ limit: 10, offset: 0 }).map((e) => e.action);
    for (const a of ['link.disable', 'link.enable', 'link.delete']) assert.ok(actions.includes(a), a);
  });

  it('todo POST de rota exige o token de CSRF', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default' });
    const { cookie } = await h.login();
    for (const path of ['/admin/links', ...['', '/rematch', '/test', '/enable', '/disable', '/delete'].map((p) => `/admin/links/${link.id}${p}`)]) {
      assert.equal((await h.post(path, linkForm(vitrine, checkout), cookie)).status, 403, path);
    }
    assert.equal(h.repos.links.list().length, 1);
    assert.deepEqual(h.calls, { rematchPair: [], testLink: [] });
  });
});

describe('mapeamentos', () => {
  it('lista produto, variante, SKU e preço dos dois lados, método, status, divergências e candidatos, escapando marcação', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie } = await h.login();
    const res = await h.get(`/admin/links/${link.id}/mappings`, cookie);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Mapeamentos: Vitrine A → Checkout B'));
    assert.ok(text.includes('<strong>Camiseta Azul</strong>') && text.includes('SKU AZ-M') && text.includes(fmtMoney('50.00', 'BRL')));
    assert.ok(text.includes('SKU TEN-42') && text.includes(fmtMoney('250.00', 'BRL')), 'lado do checkout com SKU e preço');
    assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!text.includes('<img src=x'));
    for (const label of ['Sugerido', 'Conflito', 'Ativo', 'Sem destino']) assert.ok(text.includes(`">${label}</span>`), label);
    assert.ok(text.includes('Título + opções') && text.includes('· SKU</span>'));
    assert.ok(text.includes('id="list-vitrine"') && text.includes('id="list-checkout"'), 'duas colunas lado a lado');
    assert.ok(text.includes('draggable="true" data-checkout="9101"'), 'linha do checkout arrastável');
    assert.ok(text.includes('class="pair-row is-diverge" data-vitrine="103"'), 'linha divergente destacada');
    assert.ok(text.includes('id="pairs-input" value="') && text.includes('101:9101'), 'pares atuais no campo oculto do Salvar');
    assert.ok(text.includes('>Auto-Mapear</span>') && text.includes('>Salvar (4)</button>'));
    assert.ok(text.includes('badge-error">Preço</span> <span class="muted">200.00 → 250.00</span>'));
    assert.ok(text.includes('Boné Premium') && text.includes('name="checkoutVariantId" value="9112"'));
    assert.equal(text.match(/>Aprovar</g)?.length, 1, 'só a linha sugerida tem Aprovar');
    assert.ok(!text.includes('Voltar ao automático'));
    assert.ok(text.includes(`href="/admin/links/${link.id}/mappings/search?for=104"`));
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(text) && !/\sstyle\s*=/i.test(text));
  });

  it('filtra por status, só divergentes e busca, mantendo os filtros selecionados', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie } = await h.login();
    const base = `/admin/links/${link.id}/mappings`;
    const conflict = await (await h.get(`${base}?status=conflict`, cookie)).text();
    assert.ok(conflict.includes('BONE') && !conflict.includes('Camiseta Azul') && !conflict.includes('Tênis'));
    assert.ok(conflict.includes('<option value="conflict" selected>'));
    const divergent = await (await h.get(`${base}?divergent=1`, cookie)).text();
    assert.ok(divergent.includes('Tênis Corrida') && !divergent.includes('Camiseta Azul'));
    assert.ok(divergent.includes('name="divergent" value="1" checked'));
    const search = await (await h.get(`${base}?q=camiseta`, cookie)).text();
    assert.ok(search.includes('Camiseta Azul') && !search.includes('Tênis Corrida'));
    assert.ok(search.includes('value="camiseta"'));
    assert.ok(search.includes('name="return" value="/admin/links/' + link.id + '/mappings?q=camiseta"'), 'as ações voltam para a lista filtrada');
    const none = await (await h.get(`${base}?status=disabled`, cookie)).text();
    assert.ok(none.includes('Nenhum mapeamento com esses filtros.'));
  });

  it('pagina de 50 em 50 preservando os filtros na navegação', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const extra = Array.from({ length: 60 }, (_, i) => String(200 + i));
    h.repos.catalog.upsertVariants(extra.map((id) => makeVariant(vitrine.id, id, { productTitle: `Produto ${id}`, sku: `P-${id}` })));
    h.repos.mappings.upsertAuto(extra.map((id) => makeMapping(vitrine.id, checkout.id, id)));
    const { cookie } = await h.login();
    const first = await (await h.get(`/admin/links/${link.id}/mappings?status=active`, cookie)).text();
    assert.equal(first.match(/ data-vitrine="/g)?.length, 50);
    assert.ok(first.includes('Página 1 de 2') && first.includes('61 registros'));
    // Dentro de atributo o & sai escapado, como manda o HTML.
    assert.ok(first.includes(`href="/admin/links/${link.id}/mappings?status=active&amp;page=2"`));
    const second = await (await h.get(`/admin/links/${link.id}/mappings?status=active&page=2`, cookie)).text();
    assert.equal(second.match(/ data-vitrine="/g)?.length, 11);
    assert.ok(second.includes('Página 2 de 2'));
    assert.ok(second.includes('name="return" value="/admin/links/' + link.id + '/mappings?status=active&amp;page=2"'));
  });

  it('aprovar, escolher candidato, definir manualmente e desativar gravam decisões travadas com divergências atuais', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie, csrf } = await h.login();
    const base = `/admin/links/${link.id}/mappings`;
    const get = (id: string) => h.repos.mappings.get(vitrine.id, checkout.id, id);

    const approved = await follow(h, await h.post(`${base}/approve`, { vitrineVariantId: '101', _csrf: csrf }, cookie), cookie);
    assert.ok(approved.text.includes('Sugestão aprovada'));
    assert.deepEqual(
      { ...get('101'), updatedAt: undefined },
      { vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, vitrineVariantId: '101', checkoutVariantId: '9101', status: 'active', method: 'manual', candidates: [], divergences: [], locked: true, updatedAt: undefined },
    );

    const chosen = await follow(h, await h.post(`${base}/choose`, { vitrineVariantId: '102', checkoutVariantId: '9112', _csrf: csrf }, cookie), cookie);
    assert.ok(chosen.text.includes('Candidato escolhido'));
    const m102 = get('102');
    assert.equal(m102?.checkoutVariantId, '9112');
    assert.equal(m102?.status, 'active');
    assert.equal(m102?.locked, true);
    assert.ok(m102?.divergences.some((d) => d.kind === 'price' && d.vitrine === '30.00' && d.checkout === '45.00'), 'divergência de preço vinda do catálogo atual');

    const manual = await follow(h, await h.post(`${base}/manual`, { vitrineVariantId: '104', checkoutVariantId: ' 9999 ', _csrf: csrf }, cookie), cookie);
    assert.ok(manual.text.includes('Destino definido manualmente: variante 9999.'));
    const m104 = get('104');
    assert.equal(m104?.checkoutVariantId, '9999');
    assert.equal(m104?.method, 'manual');
    assert.ok(m104?.divergences.some((d) => d.kind === 'price'));

    const disabled = await follow(h, await h.post(`${base}/disable`, { vitrineVariantId: '103', _csrf: csrf }, cookie), cookie);
    assert.ok(disabled.text.includes('Mapeamento desativado.'));
    assert.deepEqual({ status: get('103')?.status, locked: get('103')?.locked, checkout: get('103')?.checkoutVariantId }, { status: 'disabled', locked: true, checkout: '9103' });
    assert.ok(disabled.text.includes('Voltar ao automático'));

    const actions = h.repos.audit.list({ limit: 10, offset: 0 }).filter((e) => e.targetType === 'mapping');
    assert.deepEqual(actions.map((e) => e.action).sort(), ['mapping.approve', 'mapping.choose', 'mapping.disable', 'mapping.manual']);
    assert.ok(actions.every((e) => e.detail['linkId'] === link.id));
  });

  it('decisão manual grava divergências com a menor tolerância do par, como o recálculo automático', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    seedMappings(h, vitrine, checkout); // rota default com 1% de tolerância
    const br = h.repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'country', countries: ['BR'], priceToleranceBps: 500 });
    h.repos.catalog.upsertVariants([makeVariant(vitrine.id, '105', { productTitle: 'Caneca', sku: 'CAN', price: '100.00' })]);
    h.repos.catalog.upsertVariants([makeVariant(checkout.id, '9105', { productTitle: 'Caneca', sku: 'CAN', price: '103.00' })]);
    h.repos.mappings.upsertAuto([makeMapping(vitrine.id, checkout.id, '105', { status: 'unmapped', method: null, checkoutVariantId: null })]);
    const { cookie, csrf } = await h.login();
    // 3% cabe na tolerância da rota BR (5%) mas não na da rota default (1%): o par usa a
    // menor, senão a marca "Preço" sumiria aqui e voltaria no próximo recálculo automático.
    const manual = await follow(h, await h.post(`/admin/links/${br.id}/mappings/manual`, { vitrineVariantId: '105', checkoutVariantId: '9105', _csrf: csrf }, cookie), cookie);
    assert.ok(manual.text.includes('Destino definido manualmente: variante 9105.'));
    const stored = h.repos.mappings.get(vitrine.id, checkout.id, '105');
    assert.equal(stored?.checkoutVariantId, '9105');
    assert.ok(stored?.divergences.some((d) => d.kind === 'price' && d.vitrine === '100.00' && d.checkout === '103.00'), JSON.stringify(stored?.divergences));
  });

  it('recusa candidato que não está na lista, destino fora do catálogo e id inválido, sem alterar nada', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie, csrf } = await h.login();
    const base = `/admin/links/${link.id}/mappings`;
    const cases: Array<[string, Record<string, string>, string]> = [
      ['choose', { vitrineVariantId: '102', checkoutVariantId: '9101' }, 'Escolha um dos candidatos listados'],
      ['manual', { vitrineVariantId: '104', checkoutVariantId: '123456' }, 'não existe no catálogo do checkout'],
      ['manual', { vitrineVariantId: '104', checkoutVariantId: 'abc' }, 'Informe o ID numérico'],
      ['approve', { vitrineVariantId: '104' }, 'não tem sugestão para aprovar'],
      ['manual', { vitrineVariantId: '999', checkoutVariantId: '9101' }, 'não está no catálogo sincronizado'],
    ];
    for (const [action, fields, message] of cases) {
      const { text } = await follow(h, await h.post(`${base}/${action}`, { ...fields, _csrf: csrf }, cookie), cookie);
      assert.ok(text.includes(message), `${action}: ${message}`);
    }
    assert.equal(h.repos.mappings.get(vitrine.id, checkout.id, '102')?.status, 'conflict');
    assert.equal(h.repos.mappings.get(vitrine.id, checkout.id, '104')?.status, 'unmapped');
    assert.equal(h.repos.mappings.get(vitrine.id, checkout.id, '999'), null);
    assert.equal(h.repos.audit.list({ limit: 20, offset: 0 }).filter((e) => e.targetType === 'mapping').length, 0);
  });

  it('voltar ao automático destrava a linha e recalcula o par; o retorno só aceita caminhos do painel', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    h.repos.mappings.setManual(makeMapping(vitrine.id, checkout.id, '101', { method: 'manual', locked: true }));
    const { cookie, csrf } = await h.login();
    const base = `/admin/links/${link.id}/mappings`;
    const res = await h.post(`${base}/reset`, { vitrineVariantId: '101', return: `${base}?status=active`, _csrf: csrf }, cookie);
    const { location, text } = await follow(h, res, cookie);
    assert.equal(location, `${base}?status=active`);
    assert.ok(text.includes('devolvida ao casamento automático'));
    assert.equal(h.repos.mappings.get(vitrine.id, checkout.id, '101')?.locked, false);
    assert.deepEqual(h.calls.rematchPair, [[vitrine.id, checkout.id]]);
    const hostile = await h.post(`${base}/disable`, { vitrineVariantId: '103', return: 'https://evil.example/x', _csrf: csrf }, cookie);
    assert.equal(hostile.headers.get('location'), '/admin');
  });

  it('busca variantes no catálogo do checkout e oferece "Usar esta" quando há uma linha alvo', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie } = await h.login();
    const base = `/admin/links/${link.id}/mappings/search`;
    const empty = await (await h.get(base, cookie)).text();
    assert.ok(empty.includes('Digite um termo para buscar.'));
    const targeted = await (await h.get(`${base}?q=bon%C3%A9&for=102`, cookie)).text();
    assert.ok(targeted.includes('Boné Premium') && targeted.includes('>9112</td>'));
    assert.ok(!targeted.includes('Camiseta'));
    assert.ok(targeted.includes(`action="/admin/links/${link.id}/mappings/manual"`));
    assert.ok(targeted.includes('name="vitrineVariantId" value="102"') && targeted.includes('name="checkoutVariantId" value="9112"'));
    assert.ok(targeted.includes('>Usar esta</button>'));
    const free = await (await h.get(`${base}?q=meia`, cookie)).text();
    assert.ok(free.includes('Meia Listrada') && !free.includes('Usar esta'));
    const nothing = await (await h.get(`${base}?q=inexistente`, cookie)).text();
    assert.ok(nothing.includes('Nenhuma variante encontrada'));
  });

  it('ações de mapeamento exigem CSRF e rota existente', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie, csrf } = await h.login();
    for (const action of ['approve', 'choose', 'manual', 'disable', 'reset']) {
      assert.equal((await h.post(`/admin/links/${link.id}/mappings/${action}`, { vitrineVariantId: '101', checkoutVariantId: '9101' }, cookie)).status, 403, action);
    }
    assert.equal(h.repos.mappings.get(vitrine.id, checkout.id, '101')?.status, 'suggested');
    assert.equal((await h.get('/admin/links/ln_nada/mappings', cookie)).status, 404);
    assert.equal((await h.post('/admin/links/ln_nada/mappings/approve', { vitrineVariantId: '101', _csrf: csrf }, cookie)).status, 404);
  });
});

describe('mapeamentos: salvar pares da tela lado a lado', () => {
  it('parsePairs aceita só "vitrine:checkout" com IDs válidos, sem repetir a vitrine', () => {
    assert.deepEqual(parsePairs('101:9101,102:,abc:1,103:x,101:9999,:5,104'), [
      { vitrineVariantId: '101', checkoutVariantId: '9101' },
      { vitrineVariantId: '102', checkoutVariantId: null },
    ]);
    assert.deepEqual(parsePairs(''), []);
  });

  it('grava só os pares que mudaram: destino novo vira ativo travado, par esvaziado vira sem destino travado, inexistente é ignorado', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie, csrf } = await h.login();
    const before = h.repos.mappings.get(vitrine.id, checkout.id, '101');
    // 101 fica igual (sugerido 9101 -> aprovado como ativo), 102 recebe 9112, 103 é esvaziado,
    // 104 aponta para variante que não existe no checkout, 105 não existe na vitrine.
    const res = await h.post(`/admin/links/${link.id}/mappings/save`, { pairs: '101:9101,102:9112,103:,104:4242,105:9101', return: `/admin/links/${link.id}/mappings?page=1`, _csrf: csrf }, cookie);
    const { location, text } = await follow(h, res, cookie);
    assert.equal(location, `/admin/links/${link.id}/mappings?page=1`);
    assert.ok(text.includes('Mapeamento salvo: 3 pares atualizados. 2 pares ignorados (variante fora do catálogo).'), text.slice(text.indexOf('flash'), text.indexOf('flash') + 200));
    const after = (id: string) => h.repos.mappings.get(vitrine.id, checkout.id, id);
    assert.equal(after('101')?.status, 'active', 'sugestão com o mesmo destino vira ativa');
    assert.equal(after('101')?.locked, true);
    assert.ok(before?.status === 'suggested');
    assert.deepEqual([after('102')?.checkoutVariantId, after('102')?.status, after('102')?.method], ['9112', 'active', 'manual']);
    assert.deepEqual([after('103')?.checkoutVariantId, after('103')?.status, after('103')?.locked], [null, 'unmapped', true]);
    assert.equal(after('104')?.checkoutVariantId, null, 'destino inexistente não é gravado');
    assert.equal(after('105'), null);
    // Enviar de novo os mesmos pares não muda nada.
    const again = await follow(h, await h.post(`/admin/links/${link.id}/mappings/save`, { pairs: '101:9101,102:9112,103:', _csrf: csrf }, cookie), cookie);
    assert.ok(again.text.includes('Nada a salvar: nenhum par mudou.'));
    assert.ok(h.repos.audit.list({ limit: 10, offset: 0 }).some((e) => e.action === 'mapping.save' && e.detail['changed'] === 3 && e.detail['ignored'] === 2));
  });

  it('a última página sem filtros lista no fim as variantes do checkout que nenhum par usa', async () => {
    const h = harness();
    const { vitrine, checkout } = pair(h);
    const link = seedMappings(h, vitrine, checkout);
    const { cookie } = await h.login();
    const text = await (await h.get(`/admin/links/${link.id}/mappings`, cookie)).text();
    // 9999 (Meia Listrada) não é destino nem candidato de ninguém: aparece como linha extra,
    // com um "Sem variante" do lado da vitrine; 9102/9112 são candidatos e não repetem.
    assert.ok(text.includes('data-checkout="9999"') && text.includes('Meia Listrada'));
    assert.equal(text.match(/data-checkout="9112"/g)?.length ?? 0, 0);
    assert.equal(text.match(/<li class="pair-row pair-empty"><span class="pair-idx">05<\/span>/g)?.length, 1);
    const filtered = await (await h.get(`/admin/links/${link.id}/mappings?status=active`, cookie)).text();
    assert.ok(!filtered.includes('data-checkout="9999"'), 'com filtro as extras não aparecem');
  });
});
