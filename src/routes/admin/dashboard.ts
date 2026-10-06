import type { Context } from 'hono';
import { html } from 'hono/html';
import { systemClock } from '../../lib/clock.ts';
import { formatMoney, fromMicros, toMicros } from '../../lib/money.ts';
import type { MoneyByCurrency, SalesStats, Store, StoreStatus } from '../../types.ts';
import { sessionsTable } from './activity.ts';
import { barChart } from './charts.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { takeFlash } from './context.ts';
import { badge, fmtDate, icon, page, progressBar } from './layout.ts';
import type { Markup } from './layout.ts';
import { PERIODS, parsePeriod, periodRange } from './periods.ts';
import type { PeriodKey } from './periods.ts';

/**
 * Dashboard: visão geral de vendas das lojas checkout (pedidos registrados pelos webhooks),
 * no formato de painel de vendas: período, loja, moeda, indicadores, evolução diária e
 * faturamento por loja.
 *
 * É só relatório. Nenhum controle daqui altera rota ou destino: a configuração das rotas
 * fica na seção Rotas e é sempre uma decisão explícita do lojista (ver src/types.ts).
 */

const STATUS_BADGE: Record<StoreStatus, { kind: 'ok' | 'warn' | 'error' | 'muted'; text: string }> = {
  connected: { kind: 'ok', text: 'Conectada' },
  pending: { kind: 'warn', text: 'Pendente' },
  error: { kind: 'error', text: 'Erro' },
  disabled: { kind: 'muted', text: 'Desativada' },
};

export function storeStatusBadge(store: Store): Markup {
  const spec = STATUS_BADGE[store.status] ?? { kind: 'muted', text: store.status };
  return badge(spec.kind, spec.text);
}

type Metric = 'faturamento' | 'pedidos';

function isoDate(value: string | undefined): string | null {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

/** Período da URL: um dos atalhos ou "personalizado" com de/ate (datas em UTC). */
function resolveRange(c: Context<AdminEnv>, nowMs: number): { key: PeriodKey | 'custom'; since: string; until: string } {
  const de = isoDate(c.req.query('de'));
  const ate = isoDate(c.req.query('ate'));
  if (c.req.query('periodo') === 'custom' && de !== null && ate !== null && de <= ate) {
    return { key: 'custom', since: `${de}T00:00:00.000Z`, until: `${ate}T23:59:59.999Z` };
  }
  const key = parsePeriod(c.req.query('periodo'));
  return { key, ...periodRange(key, nowMs) };
}

function currencies(stats: SalesStats, stores: Store[]): string[] {
  const set = new Set<string>(Object.keys(stats.revenueByCurrency));
  for (const s of stores) if (s.currency !== null) set.add(s.currency);
  if (set.size === 0) set.add('BRL');
  return [...set].sort();
}

function mainCurrency(revenue: MoneyByCurrency, wanted: string | null, fallback: string): string {
  if (wanted !== null) return wanted;
  let best: string | null = null;
  let bestValue = -1n;
  for (const [currency, amount] of Object.entries(revenue)) {
    const v = toMicros(amount);
    if (v > bestValue) {
      best = currency;
      bestValue = v;
    }
  }
  return best ?? fallback;
}

function money(amount: string | undefined, currency: string): string {
  return formatMoney(amount ?? '0', currency);
}

function avgTicket(stats: SalesStats, currency: string): string {
  const total = stats.revenueByCurrency[currency];
  if (total === undefined || stats.orders === 0) return '—';
  return formatMoney(fromMicros(toMicros(total) / BigInt(stats.orders)), currency);
}

function dayLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

function hhmm(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const s = q.toString();
  return s === '' ? '/admin' : `/admin?${s}`;
}

export function dashboardPage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  const { repos } = deps;
  const clock = deps.clock ?? systemClock;
  const now = clock.now();

  const stores = repos.stores.list();
  const storesById = new Map(stores.map((store) => [store.id, store]));
  const checkouts = stores.filter((s) => s.role === 'checkout');

  const range = resolveRange(c, now.getTime());
  const lojaParam = c.req.query('loja');
  const storeFilter = typeof lojaParam === 'string' && storesById.has(lojaParam) ? lojaParam : null;
  const metric: Metric = c.req.query('metrica') === 'pedidos' ? 'pedidos' : 'faturamento';

  const sales = repos.orders.stats({ since: range.since, until: range.until, ...(storeFilter === null ? {} : { storeId: storeFilter }) });
  const sessions = repos.sessions.stats(range.since);
  const available = currencies(sales, checkouts);
  const moedaParam = c.req.query('moeda');
  const currency = mainCurrency(sales.revenueByCurrency, typeof moedaParam === 'string' && available.includes(moedaParam) ? moedaParam : null, available[0] ?? 'BRL');

  const base = { periodo: range.key, loja: storeFilter, moeda: currency, metrica: metric, de: c.req.query('de'), ate: c.req.query('ate') };
  const chartPoints = sales.daily.map((d) => ({
    label: dayLabel(d.day),
    value: metric === 'pedidos' ? String(d.orders) : (d.revenueByCurrency[currency] ?? '0'),
  }));
  const recentFailures = repos.sessions.list({ status: 'failed', limit: 8, offset: 0 });
  const attempts = sessions.created + sessions.failed;
  const failureRate = attempts === 0 ? '—' : `${((sessions.failed / attempts) * 100).toFixed(1).replace('.', ',')}%`;

  const periodChips = html`<nav class="seg" aria-label="Período">
    ${PERIODS.map((p) =>
      p.key === range.key
        ? html`<a href="${query({ ...base, periodo: p.key, de: null, ate: null })}" aria-current="true">${p.label}</a>`
        : html`<a href="${query({ ...base, periodo: p.key, de: null, ate: null })}">${p.label}</a>`,
    )}
    <details class="custom-period">
      <summary class="${range.key === 'custom' ? 'is-active' : ''}">Personalizado</summary>
      <form method="get" action="/admin" class="custom-period-form">
        <input type="hidden" name="periodo" value="custom">
        ${storeFilter === null ? '' : html`<input type="hidden" name="loja" value="${storeFilter}">`}
        <input type="hidden" name="moeda" value="${currency}">
        <label>De <input type="date" name="de" value="${c.req.query('de') ?? ''}" required></label>
        <label>Até <input type="date" name="ate" value="${c.req.query('ate') ?? ''}" required></label>
        <button class="btn btn-small" type="submit">Aplicar</button>
      </form>
    </details>
  </nav>`;

  const toolbar = html`<div class="toolbar">
    ${periodChips}
    <form method="get" action="/admin" class="toolbar-form">
      <input type="hidden" name="periodo" value="${range.key}">
      ${range.key === 'custom' ? html`<input type="hidden" name="de" value="${c.req.query('de') ?? ''}"><input type="hidden" name="ate" value="${c.req.query('ate') ?? ''}">` : ''}
      <select name="loja" aria-label="Loja checkout">
        <option value="">Todas as lojas</option>
        ${checkouts.map((s) => html`<option value="${s.id}" ${s.id === storeFilter ? 'selected' : ''}>${s.name}</option>`)}
      </select>
      <select name="moeda" aria-label="Moeda">
        ${available.map((cur) => html`<option value="${cur}" ${cur === currency ? 'selected' : ''}>${cur}</option>`)}
      </select>
      <button class="btn btn-secondary" type="submit">${icon('refresh')}<span>Atualizar</span></button>
    </form>
  </div>`;

  const kpis = html`<div class="kpis kpis-3">
    <div class="kpi"><span class="kpi-icon">${icon('cash')}</span><span class="kpi-label">Faturamento</span>
      <span class="kpi-value">${money(sales.revenueByCurrency[currency], currency)}</span><span class="kpi-hint">Reembolsos descontados</span></div>
    <div class="kpi"><span class="kpi-icon">${icon('bag')}</span><span class="kpi-label">Pedidos</span>
      <span class="kpi-value">${sales.orders}</span><span class="kpi-hint">${sales.cancelled > 0 ? `Pedidos no período · ${sales.cancelled} cancelados` : 'Pedidos no período'}</span></div>
    <div class="kpi"><span class="kpi-icon">${icon('ticket')}</span><span class="kpi-label">Ticket médio</span>
      <span class="kpi-value">${avgTicket(sales, currency)}</span><span class="kpi-hint">Por pedido no período</span></div>
  </div>`;

  const topTotal = Object.values(sales.byCheckoutStore[0]?.revenueByCurrency ?? {}).reduce((a, b) => a + toMicros(b), 0n);
  const byStore =
    sales.byCheckoutStore.length === 0
      ? html`<div class="empty-state">Nenhuma venda paga neste período.</div>`
      : html`<ol class="rank">
          ${sales.byCheckoutStore.map((row, i) => {
            const store = storesById.get(row.storeId);
            const sum = Object.values(row.revenueByCurrency).reduce((a, b) => a + toMicros(b), 0n);
            const pct = topTotal > 0n ? Number((sum * 100n) / topTotal) : 0;
            return html`<li>
              <span class="rank-n">${String(i + 1).padStart(2, '0')}</span>
              <span><strong>${store?.name ?? row.storeId}</strong><div class="muted mono">${store?.shopDomain ?? ''}</div></span>
              <span class="num"><strong>${money(row.revenueByCurrency[currency], currency)}</strong><div class="muted">${row.orders} ${row.orders === 1 ? 'pedido' : 'pedidos'}</div></span>
              <span class="rank-bar">${progressBar([{ kind: 'ok', value: Math.max(pct, 1), label: 'participação' }, { kind: 'muted', value: Math.max(100 - pct, 0), label: '' }])}</span>
            </li>`;
          })}
        </ol>`;

  const body = html`
    <div class="section-head">
      <div><h2 class="section-title">Visão geral de vendas</h2><p class="section-sub">Pedidos pagos, com reembolsos descontados do faturamento.</p></div>
      <span class="dot-note">Horário UTC</span>
    </div>
    ${toolbar}
    ${sales.leakedOrders > 0
      ? html`<div class="banner-warn">${sales.leakedOrders} ${sales.leakedOrders === 1 ? 'pedido foi criado' : 'pedidos foram criados'} direto na vitrine, fora da ponte. Confira os botões de checkout acelerado do tema. <a href="/admin/sales">Ver pedidos</a></div>`
      : ''}
    ${kpis}
    <div class="grid-2 grid-wide">
      <section class="card">
        <div class="card-head">
          <div><h2>Vendas ao longo do tempo</h2><div class="muted">Evolução diária no período selecionado</div></div>
          <nav class="seg" aria-label="Métrica">
            <a href="${query({ ...base, metrica: 'faturamento' })}" ${metric === 'faturamento' ? 'aria-current="true"' : ''}>Faturamento</a>
            <a href="${query({ ...base, metrica: 'pedidos' })}" ${metric === 'pedidos' ? 'aria-current="true"' : ''}>Pedidos</a>
          </nav>
        </div>
        <div class="chart-total">${metric === 'pedidos' ? String(sales.orders) : money(sales.revenueByCurrency[currency], currency)}</div>
        ${barChart({ title: metric === 'pedidos' ? 'Pedidos por dia' : 'Faturamento por dia', points: chartPoints, currency: metric === 'pedidos' ? null : currency })}
        <details class="daily-values"><summary>Ver valores por dia</summary>
          <div class="table-wrap"><table><thead><tr><th>Dia</th><th class="num">Pedidos</th><th class="num">Faturamento</th></tr></thead>
          <tbody>${sales.daily.map((d) => html`<tr><td>${dayLabel(d.day)}</td><td class="num">${d.orders}</td><td class="num">${money(d.revenueByCurrency[currency], currency)}</td></tr>`)}</tbody></table></div>
        </details>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Faturamento por loja</h2><div class="muted">Suas lojas de checkout</div></div><span class="card-icon">${icon('store')}</span></div>
        ${byStore}
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><div><h2>Checkouts pela ponte</h2><div class="muted">Redirecionamentos da vitrine no período</div></div><span class="card-icon">${icon('swap')}</span></div>
        <div class="stats">
          <div class="stat"><span class="stat-value">${sessions.created}</span><span class="stat-label">checkouts criados</span></div>
          <div class="stat"><span class="stat-value">${sessions.failed}</span><span class="stat-label">falhas</span></div>
          <div class="stat"><span class="stat-value">${failureRate}</span><span class="stat-label">taxa de falha</span></div>
        </div>
        ${Object.keys(sessions.byError).length === 0
          ? html`<p class="empty">Nenhuma falha no período.</p>`
          : html`<dl class="pairs">${Object.entries(sessions.byError).sort((a, b) => b[1] - a[1]).map(([code, n]) => html`<dt><span class="mono">${code}</span></dt><dd>${n}</dd>`)}</dl>`}
        <p><a class="btn btn-link btn-small" href="/admin/sessions?status=failed">Ver sessões com falha</a></p>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Saúde das lojas</h2><div class="muted">Conexão e última sincronização</div></div><span class="card-icon teal">${icon('bolt')}</span></div>
        ${stores.length === 0
          ? html`<div class="empty-state">Nenhuma loja cadastrada. <a href="/admin/stores/new">Adicionar loja</a></div>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Loja</th><th>Papel</th><th>Status</th><th class="num">Variantes</th><th>Sincronização</th></tr></thead>
              <tbody>${stores.map((store) => html`<tr>
                <td><a href="/admin/stores/${store.id}">${store.name}</a><div class="mono muted">${store.shopDomain}</div></td>
                <td>${store.role === 'vitrine' ? 'Vitrine' : 'Checkout'}</td>
                <td>${storeStatusBadge(store)}</td>
                <td class="num">${store.variantCount}</td>
                <td class="nowrap">${fmtDate(store.lastSyncAt)} ${store.lastSyncOk === false ? badge('error', 'Falhou') : ''}</td>
              </tr>`)}</tbody></table></div>`}
      </section>
    </div>
    <section class="card">
      <div class="card-head"><div><h2>Últimas falhas de checkout</h2><div class="muted">Sessões que não chegaram ao checkout, com o motivo</div></div><a class="btn btn-link btn-small" href="/admin/sessions?status=failed">Ver todas</a></div>
      ${sessionsTable(recentFailures, storesById)}
    </section>
    <div class="footer-note"><span>Valores em ${currency}.</span><span>Atualizado às ${hhmm(now)} UTC</span></div>`;

  return c.html(
    page({
      title: 'Dashboard',
      description: 'Vendas das suas lojas checkout, em um só lugar.',
      active: 'dashboard',
      session: c.get('session'),
      flash: takeFlash(c),
      host: new URL(deps.config.publicBaseUrl).host,
      body,
    }),
  );
}
