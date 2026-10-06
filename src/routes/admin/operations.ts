import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { systemClock } from '../../lib/clock.ts';
import type { BoardCard, BoardColumn, Link, Store } from '../../types.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { audit, readForm, redirectTo, setFlash, takeFlash } from './context.ts';
import { badge, csrfField, icon, page } from './layout.ts';
import type { Markup } from './layout.ts';

/**
 * Central de operações: uma "operação" é uma vitrine com suas rotas para lojas checkout.
 * A página traz um resumo e um quadro (kanban) para o lojista organizar as vitrines em
 * etapas com nomes livres e anotar observações.
 *
 * O quadro é só organização: mover um cartão não muda rota, destino nem checkout. A etapa
 * e a observação são anotações do lojista para si mesmo (ver BoardRepo em src/types.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function age(iso: string, nowMs: number): string {
  const days = Math.floor((nowMs - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return 'hoje';
  if (days === 0) return 'hoje';
  if (days === 1) return 'há 1 dia';
  return `há ${days} dias`;
}

function cardMarkup(store: Store, card: BoardCard | null, links: Link[], stores: Map<string, Store>, csrf: Markup, nowMs: number): Markup {
  const destinations = links
    .filter((l) => l.enabled)
    .map((l) => stores.get(l.checkoutStoreId)?.name ?? l.checkoutStoreId);
  return html`<article class="kanban-card" draggable="true" data-store="${store.id}">
    <div class="kanban-card-head"><span class="grip">${icon('grip')}</span><strong><a href="/admin/operations/${store.id}">${card !== null && card.title !== '' ? card.title : store.name}</a></strong>
      <a class="icon-button" href="/admin/links?vitrine=${store.id}" title="Rotas desta vitrine" aria-label="Rotas">${icon('route')}</a></div>
    <div class="domain">${store.shopDomain}</div>
    ${store.publicDomain === null ? '' : html`<div class="public">${store.publicDomain}</div>`}
    <div class="age">${age(store.createdAt, nowMs)}${destinations.length > 0 ? html` · → ${destinations.join(', ')}` : html` · <span class="muted">sem rota</span>`}</div>
    <form class="kanban-note" method="post" action="/admin/operations/note">
      ${csrf}
      <input type="hidden" name="store" value="${store.id}">
      <div class="kanban-note-label">Observações</div>
      <textarea name="note" rows="2" placeholder="Clique para adicionar observação" aria-label="Observações de ${store.name}">${card?.note ?? ''}</textarea>
      <button class="btn btn-secondary btn-small" type="submit">Salvar</button>
    </form>
    <form class="kanban-move" method="post" action="/admin/operations/move">
      ${csrf}
      <input type="hidden" name="store" value="${store.id}">
      <input type="hidden" name="column" value="">
      <input type="hidden" name="position" value="0">
    </form>
  </article>`;
}

function columnMarkup(column: BoardColumn | null, cards: Array<{ store: Store; card: BoardCard | null }>, ctx: { links: Link[]; stores: Map<string, Store>; csrf: Markup; nowMs: number }): Markup {
  const id = column?.id ?? '';
  const title = column?.name ?? 'Sem etapa';
  return html`<section class="kanban-col" data-column="${id}">
    <div class="kanban-head">
      <span class="grip">${icon('grip')}</span>
      <h3>${title} <span class="count-pill">${cards.length}</span></h3>
      ${column === null
        ? ''
        : html`<details class="menu"><summary class="icon-button" aria-label="Opções da coluna">${icon('dots')}</summary>
            <div class="menu-body">
              <form method="post" action="/admin/operations/columns/${column.id}/rename">${ctx.csrf}
                <input type="text" name="name" value="${column.name}" maxlength="60" aria-label="Novo nome"> <button class="btn btn-small" type="submit">Renomear</button></form>
              <form method="post" action="/admin/operations/columns/${column.id}/delete" data-confirm="Remover a coluna ${column.name}? Os cartões voltam para 'Sem etapa'.">${ctx.csrf}
                <button class="btn btn-danger btn-small" type="submit">Remover coluna</button></form>
            </div></details>`}
    </div>
    <div class="kanban-body">
      ${cards.length === 0 ? html`<div class="kanban-empty">Arraste uma operação para esta etapa</div>` : ''}
      ${cards.map(({ store, card }) => cardMarkup(store, card, ctx.links.filter((l) => l.vitrineStoreId === store.id), ctx.stores, ctx.csrf, ctx.nowMs))}
    </div>
  </section>`;
}

export function operationsPage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  const { repos } = deps;
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now().getTime();
  const session = c.get('session');
  const csrf = csrfField(session);

  const stores = repos.stores.list();
  const storesById = new Map(stores.map((s) => [s.id, s]));
  const vitrines = stores.filter((s) => s.role === 'vitrine');
  const links = repos.links.list();
  const columns = repos.board.columns();
  const cards = new Map(repos.board.cards().map((card) => [card.storeId, card]));

  // Mapeamentos ativos somados por par (vitrine, checkout) e checkouts criados nos últimos 7 dias.
  const pairs = new Set(links.map((l) => `${l.vitrineStoreId}\u0000${l.checkoutStoreId}`));
  let activeMappings = 0;
  for (const pair of pairs) {
    const [v, ck] = pair.split('\u0000');
    if (v !== undefined && ck !== undefined) activeMappings += repos.mappings.counts(v, ck).active;
  }
  const week = repos.sessions.stats(new Date(nowMs - 7 * DAY_MS).toISOString());

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const visible = vitrines.filter((s) => q === '' || s.name.toLowerCase().includes(q) || s.shopDomain.includes(q) || (s.publicDomain ?? '').includes(q) || (cards.get(s.id)?.title ?? '').toLowerCase().includes(q));
  const byColumn = new Map<string, Array<{ store: Store; card: BoardCard | null }>>();
  for (const col of columns) byColumn.set(col.id, []);
  const unstaged: Array<{ store: Store; card: BoardCard | null }> = [];
  for (const store of visible) {
    const card = cards.get(store.id) ?? null;
    // Vitrine sem etapa definida entra na primeira coluna (a de "entrada"), como se tivesse
    // acabado de ser criada; só vai para "Sem etapa" quando não existe coluna nenhuma.
    const columnId = card?.columnId ?? columns[0]?.id ?? null;
    const bucket = columnId === null ? undefined : byColumn.get(columnId);
    if (bucket === undefined) unstaged.push({ store, card });
    else bucket.push({ store, card });
  }
  for (const list of byColumn.values()) list.sort((a, b) => (a.card?.position ?? 0) - (b.card?.position ?? 0) || a.store.name.localeCompare(b.store.name));
  const ctx = { links, stores: storesById, csrf, nowMs };

  const body = html`
    <section class="hero">
      <div>
        <span class="hero-chip">${icon('bolt')} Pulso operacional</span>
        <h2>Suas lojas organizadas<br>para a próxima decisão.</h2>
        <p>Veja o volume configurado, encontre cada operação e continue o trabalho sem perder contexto.</p>
        <div class="hero-actions">
          <a class="btn" href="/admin/operations/new">${icon('plus')}<span>Nova operação</span></a>
          <a class="btn btn-secondary" href="/admin/stores">Organizar lojas ›</a>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat">${icon('layers')}<div class="hero-stat-label">Operações</div><div class="hero-stat-value">${vitrines.length}</div></div>
        <div class="hero-stat">${icon('store')}<div class="hero-stat-label">Lojas</div><div class="hero-stat-value">${stores.length}</div></div>
        <div class="hero-stat">${icon('swap')}<div class="hero-stat-label">Mapeamentos</div><div class="hero-stat-value">${activeMappings}</div></div>
        <div class="hero-stat">${icon('sales')}<div class="hero-stat-label">Checkouts 7d</div><div class="hero-stat-value">${week.created}</div></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head">
        <div><h2>Fluxo de trabalho</h2><div class="muted">Arraste os cartões entre as etapas para organizar suas operações.</div></div>
        <form method="get" action="/admin/operations" class="toolbar-form"><input type="search" name="q" value="${q}" placeholder="Buscar operações…" aria-label="Buscar operações"><button class="btn btn-secondary btn-small" type="submit">${icon('search')}</button></form>
      </div>
      ${vitrines.length === 0 ? html`<div class="empty-state">Nenhuma vitrine cadastrada. <a href="/admin/stores/new">Adicionar loja</a></div>` : ''}
      <div class="kanban" data-kanban>
        ${columns.map((col) => columnMarkup(col, byColumn.get(col.id) ?? [], ctx))}
        ${unstaged.length > 0 || columns.length === 0 ? columnMarkup(null, unstaged, ctx) : ''}
        <div class="kanban-new"><form method="post" action="/admin/operations/columns">${csrf}<input type="text" name="name" placeholder="Nova coluna" maxlength="60" required aria-label="Nome da coluna"><button class="btn btn-secondary btn-small" type="submit">${icon('plus')}<span>Nova coluna</span></button></form></div>
      </div>
    </section>`;

  return c.html(
    page({
      title: 'Central de operações',
      description: 'Acompanhe lojas, mapeamentos e rotas em um único espaço de decisão.',
      active: 'operations',
      session,
      flash: takeFlash(c),
      host: new URL(deps.config.publicBaseUrl).host,
      body,
    }),
  );
}

// ---------------------------------------------------------------------------
// Assistente "Nova operação": nome -> vitrine -> checkouts -> criar
// ---------------------------------------------------------------------------

interface WizardState {
  step: 1 | 2 | 3;
  name: string;
  vitrine: string;
  checkouts: string[];
  error: string | null;
}

function wizardStep(value: string | undefined): 1 | 2 | 3 {
  return value === '2' ? 2 : value === '3' ? 3 : 1;
}

function wizardPage(deps: AdminDeps, c: Context<AdminEnv>, state: WizardState, status: 200 | 400 = 200): Response | Promise<Response> {
  const session = c.get('session');
  const stores = deps.repos.stores.list();
  const vitrines = stores.filter((s) => s.role === 'vitrine');
  const checkouts = stores.filter((s) => s.role === 'checkout');
  const selectedVitrine = vitrines.find((s) => s.id === state.vitrine) ?? null;
  const stepItem = (n: 1 | 2 | 3, label: string, ic: 'store' | 'bag'): Markup => {
    const cls = n === state.step ? 'is-current' : n < state.step ? 'is-done' : '';
    return html`<li class="${cls}"><span class="step-icon">${n < state.step ? '✓' : icon(ic)}</span><div><div class="step-k">Passo ${n}</div><div class="step-l">${label}</div></div></li>`;
  };
  const hidden = html`<input type="hidden" name="name" value="${state.name}"><input type="hidden" name="vitrine" value="${state.vitrine}"><input type="hidden" name="checkouts" value="${state.checkouts.join(',')}">`;
  let content: Markup;
  if (state.step === 1) {
    content = html`<div class="wiz-k">Passo 1 de 3</div><h2 class="section-title">Dê um nome à operação</h2>
      <p class="section-sub">Use um nome claro para identificar esta estrutura na lista de operações.</p>
      <form method="post" action="/admin/operations/new">${csrfField(session)}${hidden}<input type="hidden" name="step" value="1">
        <input class="wiz-input" type="text" name="name_input" value="${state.name}" placeholder="Ex: Minha Operação" maxlength="120" required autofocus>
        <div class="wiz-foot"><a class="btn btn-link" href="/admin/operations">← Operações</a><button class="btn" type="submit" name="action" value="next">Próximo →</button></div>
      </form>`;
  } else if (state.step === 2) {
    content = html`<div class="wiz-k">Passo 2 de 3</div><h2 class="section-title">Escolha a loja vitrine</h2>
      <p class="section-sub">Esta será a origem da experiência e do catálogo da operação.</p>
      <form method="post" action="/admin/operations/new">${csrfField(session)}${hidden}<input type="hidden" name="step" value="2">
        <div class="pick-list">${vitrines.length === 0 ? html`<p class="empty">Nenhuma vitrine cadastrada.</p>` : ''}
          ${vitrines.map((s) => html`<label class="pick"><input type="radio" name="vitrine_input" value="${s.id}" ${s.id === state.vitrine ? 'checked' : ''} required><span><strong>${s.name}</strong><div class="mono muted">${s.shopDomain}</div></span><span class="chip">Vitrine</span></label>`)}
        </div>
        <p class="muted center">Não encontrou? <a href="/admin/stores/new">Conecte uma nova loja em "Lojas" →</a></p>
        <div class="wiz-foot"><button class="btn btn-link" type="submit" name="action" value="back">← Voltar</button><button class="btn" type="submit" name="action" value="next">Próximo →</button></div>
      </form>`;
  } else {
    content = html`<div class="wiz-k">Passo 3 de 3</div><h2 class="section-title">Selecione os checkouts</h2>
      <p class="section-sub">Escolha um ou mais destinos para concluir a estrutura inicial. O primeiro marcado fica como destino ativo; os outros ficam disponíveis para você trocar quando quiser.</p>
      <form method="post" action="/admin/operations/new">${csrfField(session)}<input type="hidden" name="name" value="${state.name}"><input type="hidden" name="vitrine" value="${state.vitrine}"><input type="hidden" name="step" value="3">
        <div class="pick-list">${checkouts.length === 0 ? html`<p class="empty">Nenhuma loja checkout cadastrada.</p>` : ''}
          ${checkouts.map((s) => html`<label class="pick"><input type="checkbox" name="checkout_${s.id}" value="1" ${state.checkouts.includes(s.id) ? 'checked' : ''}><span><strong>${s.name}</strong><div class="mono muted">${s.shopDomain}</div></span><span class="chip">Checkout</span></label>`)}
        </div>
        <div class="wiz-foot"><button class="btn btn-link" type="submit" name="action" value="back">← Voltar</button><button class="btn" type="submit" name="action" value="create">${icon('bolt')}<span>Criar Operação</span></button></div>
      </form>`;
  }
  const body = html`<div class="wizard">
    <aside class="wizard-side">
      <h2 class="wizard-title">Conecte sua vitrine aos checkouts.</h2>
      <p class="muted">Configure a estrutura da operação em três passos objetivos. Você poderá ajustar produtos e rotas depois.</p>
      <ol class="wizard-steps">${stepItem(1, 'Nome da Operação', 'store')}${stepItem(2, 'Selecionar Vitrine', 'bag')}${stepItem(3, 'Selecionar Checkouts', 'store')}</ol>
      ${selectedVitrine === null ? '' : html`<p class="muted">Vitrine: <strong>${selectedVitrine.name}</strong></p>`}
    </aside>
    <section class="card wizard-main">
      ${state.error === null ? '' : html`<div class="flash flash-error" role="alert">${state.error}</div>`}
      ${content}
    </section>
  </div>`;
  return c.html(
    page({ title: 'Nova operação', description: 'Operações › Nova operação', active: 'operations', session, flash: takeFlash(c), host: new URL(deps.config.publicBaseUrl).host, body }),
    status,
  );
}

// ---------------------------------------------------------------------------
// Central da operação: vitrine, checkouts ligados, divergências e ações
// ---------------------------------------------------------------------------

function operationDetail(deps: AdminDeps, c: Context<AdminEnv>, vitrine: Store): Response | Promise<Response> {
  const { repos } = deps;
  const session = c.get('session');
  const csrf = csrfField(session);
  const stores = repos.stores.list();
  const storesById = new Map(stores.map((s) => [s.id, s]));
  const card = repos.board.card(vitrine.id);
  const title = card !== null && card.title !== '' ? card.title : vitrine.name;
  const links = repos.links.list({ vitrineStoreId: vitrine.id });
  const active = links.find((l) => l.kind === 'default' && l.enabled) ?? null;
  const activeStore = active === null ? null : storesById.get(active.checkoutStoreId) ?? null;
  const operationOn = links.some((l) => l.enabled);
  // Um cartão por loja checkout ligada (rota padrão ou por país).
  const byCheckout = new Map<string, Link[]>();
  for (const l of links) byCheckout.set(l.checkoutStoreId, [...(byCheckout.get(l.checkoutStoreId) ?? []), l]);
  const checkoutEntries = [...byCheckout.entries()].map(([checkoutId, ls]) => ({
    store: storesById.get(checkoutId) ?? null,
    links: ls,
    counts: repos.mappings.counts(vitrine.id, checkoutId),
    isActive: ls.some((l) => l.enabled && l.kind === 'default'),
    hasCountry: ls.some((l) => l.enabled && l.kind === 'country'),
  }));
  const divergent = checkoutEntries.filter((e) => e.counts.divergent > 0);
  const available = stores.filter((s) => s.role === 'checkout' && !byCheckout.has(s.id));

  const body = html`
    <div class="op-bar">
      <a class="icon-button" href="/admin/operations" aria-label="Voltar">←</a>
      <strong class="op-name">${title}</strong>
      <form method="post" action="/admin/operations/${vitrine.id}/toggle" class="inline-form">${csrf}
        <button class="switch ${operationOn ? 'is-on' : ''}" type="submit" role="switch" aria-checked="${operationOn ? 'true' : 'false'}" title="${operationOn ? 'Operação ativa: clique para pausar' : 'Operação pausada: clique para ativar'}"><span></span></button></form>
      ${deps.themeInstaller === undefined ? '' : html`<form method="post" action="/admin/stores/${vitrine.id}/install-theme" class="inline-form">${csrf}<button class="btn btn-secondary" type="submit" data-confirm="Gravar o script no theme.liquid do tema publicado da vitrine?">&lt;/&gt; Instalar código</button></form>`}
      ${activeStore === null
        ? badge('warn', operationOn ? 'Sem destino ativo' : 'Pausada')
        : html`<span class="badge badge-ok">Ativo → ${activeStore.name}${activeStore.publicDomain === null ? '' : html` (${activeStore.publicDomain})`}</span>`}
    </div>
    <div class="section-head">
      <div><div class="wiz-k">— Arquitetura da operação</div><h2 class="section-title">Vitrine e checkouts</h2><p class="section-sub">Revise divergências, troque o destino ativo e acompanhe a operação.</p></div>
      <div class="page-actions"><span class="pill"><strong>${checkoutEntries.length}</strong> checkout${checkoutEntries.length === 1 ? '' : 's'}</span>${operationOn && activeStore !== null ? badge('ok', 'Tráfego ativo') : badge('muted', 'Sem tráfego')}</div>
    </div>
    ${divergent.length === 0
      ? ''
      : html`<div class="alert-error"><span class="alert-icon">!</span><div><strong>Checkout com ${divergent.reduce((n, e) => n + e.counts.divergent, 0)} produto${divergent.reduce((n, e) => n + e.counts.divergent, 0) === 1 ? ' divergente' : 's divergentes'}</strong>
          <div>Há divergências de preço ou cadastro no checkout. Revise e resolva antes que afete vendas.</div>
          <div class="alert-chips">${divergent.map((e) => html`<a class="chip chip-error" href="/admin/links/${e.links[0]?.id ?? ''}/mappings?divergent=1">${icon('store')} ${e.store?.name ?? '—'} <span class="count-pill">${e.counts.divergent}</span></a>`)}</div></div></div>`}
    <div class="grid-2">
      <section>
        <div class="col-label">${icon('bag')} Loja vitrine</div>
        <article class="tile store-tile">
          <div class="store-id"><span class="store-icon">${icon('bag')}</span><div><div class="tile-title"><a href="/admin/stores/${vitrine.id}">${vitrine.name}</a></div><div class="mono muted">${vitrine.shopDomain}</div>${vitrine.publicDomain === null ? '' : html`<div class="public">${vitrine.publicDomain}</div>`}</div></div>
          <div class="tile-sep"></div>
          <div>${vitrine.status === 'connected' ? html`<span class="dot-ok">● Conectada</span>` : badge('warn', vitrine.status)} · ${vitrine.variantCount} variantes</div>
        </article>
      </section>
      <section>
        <div class="col-label">${icon('store')} Lojas checkout</div>
        <div class="column">
          ${checkoutEntries.length === 0 ? html`<div class="tile empty-state">Nenhum checkout ligado a esta vitrine.</div>` : ''}
          ${checkoutEntries.map((e) => {
            const main = e.links.find((l) => l.kind === 'default') ?? e.links[0]!;
            return html`<article class="tile store-tile ${e.isActive ? 'is-active' : ''}">
              <div class="tile-head">
                <div class="store-id"><span class="store-icon teal">${icon('store')}</span><div>
                  <div class="tile-title"><a href="/admin/links/${main.id}/mappings">${e.store?.name ?? main.checkoutStoreId}</a>
                    ${e.counts.divergent > 0 ? html` <span class="badge badge-error">⚠ ${e.counts.divergent}</span>` : ''}
                    ${e.isActive ? badge('ok', 'Ativa') : e.hasCountry ? badge('ok', 'Por país') : badge('muted', 'Disponível')}</div>
                  <div class="mono muted">${e.store?.shopDomain ?? ''}</div>
                  ${e.store?.publicDomain ? html`<div class="public">${e.store.publicDomain}</div>` : ''}
                  <div class="muted">${e.counts.active} produtos mapeados · ${e.counts.suggested + e.counts.conflict} para revisar · ${e.counts.unmapped} sem par</div>
                </div></div>
                <details class="menu"><summary class="icon-button" aria-label="Opções">${icon('dots')}</summary><div class="menu-body">
                  <a class="btn btn-secondary btn-small" href="/admin/links/${main.id}/mappings">Sincronizar produtos</a>
                  ${e.isActive ? '' : html`<form method="post" action="/admin/operations/${vitrine.id}/activate/${main.id}">${csrf}<button class="btn btn-small" type="submit">Tornar destino ativo</button></form>`}
                  <a class="btn btn-secondary btn-small" href="/admin/links/${main.id}">Ajustes (preço, limites)</a>
                  <form method="post" action="/admin/operations/${vitrine.id}/remove/${main.id}" data-confirm="Remover este checkout da operação? Os mapeamentos ficam guardados.">${csrf}<button class="btn btn-danger btn-small" type="submit">Remover da operação</button></form>
                </div></details>
              </div>
            </article>`;
          })}
          <details class="section add-checkout"><summary>+ Adicionar Checkout (${available.length})</summary><div class="section-body">
            ${available.length === 0
              ? html`<p class="muted">Todas as lojas checkout cadastradas já estão nesta operação. <a href="/admin/stores/new">Cadastrar outra</a>.</p>`
              : html`<form method="post" action="/admin/operations/${vitrine.id}/add-checkout" class="form-row">${csrf}
                  <label class="field"><span>Loja checkout</span><select name="checkout">${available.map((s) => html`<option value="${s.id}">${s.name} (${s.shopDomain})</option>`)}</select></label>
                  <button class="btn" type="submit">Adicionar e sincronizar</button></form>`}
          </div></details>
        </div>
      </section>
    </div>`;
  return c.html(
    page({ title: 'Central da operação', description: `Operações › ${title}`, active: 'operations', session, flash: takeFlash(c), host: new URL(deps.config.publicBaseUrl).host, body }),
  );
}

export function createOperationsRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const { repos } = deps;

  app.get('/', (c) => operationsPage(deps, c));

  app.get('/new', (c) =>
    wizardPage(deps, c, { step: wizardStep(c.req.query('step')), name: c.req.query('name') ?? '', vitrine: c.req.query('vitrine') ?? '', checkouts: [], error: null }),
  );

  app.post('/new', async (c) => {
    const form = await readForm(c);
    const text = (key: string): string => (form[key] ?? '').trim();
    // Checkouts marcados chegam como checkout_<id>=1; os já escolhidos vêm no campo oculto.
    const checked = Object.keys(form).filter((k) => k.startsWith('checkout_') && form[k] === '1').map((k) => k.slice('checkout_'.length));
    const carried = text('checkouts').split(',').filter((x) => x !== '');
    const step = wizardStep(text('step'));
    const action = text('action');
    const state: WizardState = { step, name: text('name'), vitrine: text('vitrine'), checkouts: step === 3 ? checked : carried, error: null };
    if (step === 1) {
      state.name = text('name_input');
      if (action === 'next') {
        if (state.name === '') return wizardPage(deps, c, { ...state, error: 'Dê um nome à operação.' }, 400);
        return wizardPage(deps, c, { ...state, step: 2 });
      }
      return wizardPage(deps, c, state);
    }
    if (step === 2) {
      if (action === 'back') return wizardPage(deps, c, { ...state, step: 1 });
      state.vitrine = text('vitrine_input');
      const store = repos.stores.get(state.vitrine);
      if (store === null || store.role !== 'vitrine') return wizardPage(deps, c, { ...state, error: 'Escolha a loja vitrine.' }, 400);
      return wizardPage(deps, c, { ...state, step: 3 });
    }
    if (action === 'back') return wizardPage(deps, c, { ...state, step: 2 });
    // Passo 3: criar.
    const vitrine = repos.stores.get(state.vitrine);
    if (vitrine === null || vitrine.role !== 'vitrine') return wizardPage(deps, c, { ...state, step: 2, error: 'Escolha a loja vitrine.' }, 400);
    const chosen = state.checkouts.map((id) => repos.stores.get(id)).filter((s): s is Store => s !== null && s.role === 'checkout');
    if (chosen.length === 0) return wizardPage(deps, c, { ...state, error: 'Marque pelo menos uma loja checkout.' }, 400);
    const existing = repos.links.list({ vitrineStoreId: vitrine.id });
    const hasActiveDefault = existing.some((l) => l.kind === 'default' && l.enabled);
    const created: string[] = [];
    const errors: string[] = [];
    for (const [i, checkout] of chosen.entries()) {
      const already = existing.find((l) => l.checkoutStoreId === checkout.id && l.kind === 'default');
      if (already !== undefined) continue;
      const enabled = i === 0 && !hasActiveDefault;
      try {
        const link = repos.links.create({ vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, kind: 'default', enabled });
        audit(deps, 'link.create', 'link', link.id, { vitrineStoreId: vitrine.id, checkoutStoreId: checkout.id, enabled, via: 'operation_wizard' });
        created.push(checkout.name);
      } catch (err) {
        errors.push(`${checkout.name}: ${err instanceof Error ? err.message : 'falha'}`);
      }
      try {
        deps.matcher.rematchPair(vitrine.id, checkout.id);
      } catch (err) {
        errors.push(`mapeamento ${checkout.name}: ${err instanceof Error ? err.message : 'falha'}`);
      }
    }
    repos.board.setTitle(vitrine.id, state.name);
    if (repos.board.card(vitrine.id)?.columnId === undefined || repos.board.card(vitrine.id)?.columnId === null) {
      const first = repos.board.columns()[0];
      if (first !== undefined) repos.board.moveCard(vitrine.id, first.id, 0);
    }
    audit(deps, 'operation.create', 'store', vitrine.id, { name: state.name, checkouts: chosen.map((s) => s.id), created: created.length });
    setFlash(c, {
      kind: errors.length === 0 ? 'ok' : 'error',
      text:
        errors.length === 0
          ? `Operação "${state.name}" criada: ${vitrine.name} → ${chosen.map((s) => s.name).join(', ')}. Produtos sincronizados.`
          : `Operação criada com avisos: ${errors.join('; ')}`,
    });
    return redirectTo(c, '/admin/operations');
  });

  app.get('/:id', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null || store.role !== 'vitrine') return redirectTo(c, '/admin/operations');
    return operationDetail(deps, c, store);
  });

  // Liga/desliga a operação: ativa ou desativa todas as rotas da vitrine (sem mudar destinos).
  app.post('/:id/toggle', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return redirectTo(c, '/admin/operations');
    const links = repos.links.list({ vitrineStoreId: store.id });
    const turnOn = !links.some((l) => l.enabled);
    const errors: string[] = [];
    for (const l of links) {
      if (turnOn && l.kind === 'default' && links.some((o) => o.id !== l.id && o.kind === 'default' && o.enabled)) continue;
      try {
        repos.links.update(l.id, { enabled: turnOn });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'falha');
      }
    }
    audit(deps, 'operation.toggle', 'store', store.id, { enabled: turnOn });
    setFlash(c, { kind: errors.length === 0 ? 'ok' : 'error', text: errors.length === 0 ? (turnOn ? 'Operação ativada.' : 'Operação pausada: o botão de finalizar compra da vitrine passa a mostrar aviso até reativar.') : errors.join('; ') });
    return redirectTo(c, `/admin/operations/${store.id}`);
  });

  // Troca o destino ativo: só a rota escolhida fica como padrão ativa.
  app.post('/:id/activate/:linkId', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    const target = repos.links.get(c.req.param('linkId'));
    if (store === null || target === null || target.vitrineStoreId !== store.id) return redirectTo(c, '/admin/operations');
    try {
      for (const l of repos.links.list({ vitrineStoreId: store.id })) {
        if (l.kind === 'default' && l.enabled && l.id !== target.id) repos.links.update(l.id, { enabled: false });
      }
      repos.links.update(target.id, { enabled: true, kind: 'default', countries: [] });
      audit(deps, 'operation.activate', 'link', target.id, { vitrineStoreId: store.id, checkoutStoreId: target.checkoutStoreId });
      setFlash(c, { kind: 'ok', text: 'Destino ativo alterado.' });
    } catch (err) {
      setFlash(c, { kind: 'error', text: err instanceof Error ? err.message : 'Não foi possível ativar.' });
    }
    return redirectTo(c, `/admin/operations/${store.id}`);
  });

  app.post('/:id/remove/:linkId', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    const target = repos.links.get(c.req.param('linkId'));
    if (store === null || target === null || target.vitrineStoreId !== store.id) return redirectTo(c, '/admin/operations');
    for (const l of repos.links.list({ vitrineStoreId: store.id, checkoutStoreId: target.checkoutStoreId })) repos.links.delete(l.id);
    audit(deps, 'operation.remove_checkout', 'store', store.id, { checkoutStoreId: target.checkoutStoreId });
    setFlash(c, { kind: 'ok', text: 'Checkout removido da operação.' });
    return redirectTo(c, `/admin/operations/${store.id}`);
  });

  app.post('/:id/add-checkout', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return redirectTo(c, '/admin/operations');
    const form = await readForm(c);
    const checkout = repos.stores.get(form['checkout'] ?? '');
    if (checkout === null || checkout.role !== 'checkout') {
      setFlash(c, { kind: 'error', text: 'Escolha uma loja checkout.' });
      return redirectTo(c, `/admin/operations/${store.id}`);
    }
    const hasActive = repos.links.list({ vitrineStoreId: store.id }).some((l) => l.kind === 'default' && l.enabled);
    try {
      const link = repos.links.create({ vitrineStoreId: store.id, checkoutStoreId: checkout.id, kind: 'default', enabled: !hasActive });
      audit(deps, 'link.create', 'link', link.id, { vitrineStoreId: store.id, checkoutStoreId: checkout.id, enabled: !hasActive, via: 'operation' });
      deps.matcher.rematchPair(store.id, checkout.id);
      setFlash(c, { kind: 'ok', text: `${checkout.name} adicionada à operação e produtos sincronizados.` });
    } catch (err) {
      setFlash(c, { kind: 'error', text: err instanceof Error ? err.message : 'Não foi possível adicionar.' });
    }
    return redirectTo(c, `/admin/operations/${store.id}`);
  });

  app.post('/move', async (c) => {
    const form = await readForm(c);
    const store = repos.stores.get(form['store'] ?? '');
    if (store === null || store.role !== 'vitrine') return redirectTo(c, '/admin/operations');
    const column = (form['column'] ?? '') === '' ? null : (form['column'] ?? null);
    const position = Number.parseInt(form['position'] ?? '0', 10);
    try {
      repos.board.moveCard(store.id, column, Number.isFinite(position) ? position : 0);
      audit(deps, 'board.move', 'store', store.id, { column });
    } catch (err) {
      setFlash(c, { kind: 'error', text: err instanceof Error ? err.message : 'Não foi possível mover o cartão.' });
    }
    // Chamada pelo script de arrastar (fetch) ou por formulário comum: as duas aceitam 303.
    return redirectTo(c, '/admin/operations');
  });

  app.post('/note', async (c) => {
    const form = await readForm(c);
    const store = repos.stores.get(form['store'] ?? '');
    if (store === null) return redirectTo(c, '/admin/operations');
    repos.board.setNote(store.id, form['note'] ?? '');
    audit(deps, 'board.note', 'store', store.id, {});
    setFlash(c, { kind: 'ok', text: `Observação de ${store.name} salva.` });
    return redirectTo(c, '/admin/operations');
  });

  app.post('/columns', async (c) => {
    const form = await readForm(c);
    try {
      const column = repos.board.addColumn(form['name'] ?? '');
      audit(deps, 'board.column_add', 'board_column', column.id, { name: column.name });
    } catch (err) {
      setFlash(c, { kind: 'error', text: err instanceof Error ? err.message : 'Nome de coluna inválido.' });
    }
    return redirectTo(c, '/admin/operations');
  });

  app.post('/columns/:id/rename', async (c) => {
    const form = await readForm(c);
    try {
      repos.board.renameColumn(c.req.param('id'), form['name'] ?? '');
      audit(deps, 'board.column_rename', 'board_column', c.req.param('id'), { name: form['name'] ?? '' });
    } catch (err) {
      setFlash(c, { kind: 'error', text: err instanceof Error ? err.message : 'Não foi possível renomear.' });
    }
    return redirectTo(c, '/admin/operations');
  });

  app.post('/columns/:id/delete', (c) => {
    repos.board.deleteColumn(c.req.param('id'));
    audit(deps, 'board.column_delete', 'board_column', c.req.param('id'), {});
    setFlash(c, { kind: 'ok', text: 'Coluna removida; os cartões dela voltaram para "Sem etapa".' });
    return redirectTo(c, '/admin/operations');
  });

  return app;
}
