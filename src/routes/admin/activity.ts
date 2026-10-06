import type { Context } from 'hono';
import { html } from 'hono/html';
import { truncate } from '../../lib/http.ts';
import type { CheckoutSession, OrderListOptions, SessionListOptions, SessionStatus, SessionStrategy, Store } from '../../types.ts';
import { formatMoney, toMicros } from '../../lib/money.ts';
import { systemClock } from '../../lib/clock.ts';
import { PERIODS, parsePeriod, periodRange } from './periods.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { takeFlash } from './context.ts';
import { badge, fmtDate, fmtMoney, kpi, page, pagination } from './layout.ts';
import type { Markup } from './layout.ts';

/**
 * Páginas de atividade: sessões de checkout e trilha de auditoria. Somente leitura.
 *
 * As sessões aparecem sem a URL do checkout (quem tem a URL pode abrir o carrinho do
 * comprador), sem o id do carrinho e sem o hash do IP: nada disso ajuda no diagnóstico
 * feito aqui e tudo isso é dado que não deve circular em tela.
 */

const PAGE_SIZE = 50;
/** Teto da paginação: evita OFFSET absurdo vindo de um parâmetro digitado à mão. */
const MAX_PAGE = 2000;
const MAX_DETAIL_CHARS = 300;

const SESSION_STATUSES: readonly SessionStatus[] = ['created', 'failed', 'pending'];

const STATUS_LABEL: Record<SessionStatus, string> = {
  created: 'Criada',
  failed: 'Falhou',
  pending: 'Em andamento',
};

/** Nomes legíveis dos códigos de erro. Código desconhecido é mostrado como veio. */
const ERROR_LABEL: Record<string, string> = {
  invalid_request: 'Requisição inválida',
  unauthorized: 'Não autorizado',
  forbidden: 'Não permitido',
  not_found: 'Não encontrado',
  conflict: 'Conflito',
  store_not_found: 'Loja não reconhecida',
  store_disabled: 'Loja desativada',
  no_route: 'Sem rota configurada',
  unmapped_variant: 'Variante sem correspondência',
  variant_unavailable: 'Variante indisponível',
  quantity_exceeded: 'Quantidade acima do limite',
  selling_plan_unsupported: 'Item de assinatura',
  checkout_validation: 'Recusado por validação da loja',
  price_divergence: 'Preço divergente',
  rate_limited: 'Limite de requisições',
  upstream_unavailable: 'Shopify indisponível',
  upstream_rejected: 'Recusado pela Shopify',
  internal: 'Erro interno',
};

export function errorCodeLabel(code: string): string {
  return Object.hasOwn(ERROR_LABEL, code) ? (ERROR_LABEL[code] ?? code) : code;
}

export function strategyLabel(strategy: SessionStrategy | null): string {
  if (strategy === 'storefront_cart') return 'Carrinho (Storefront API)';
  if (strategy === 'permalink') return 'Permalink';
  return '—';
}

export function sessionStatusBadge(status: SessionStatus): Markup {
  if (status === 'created') return badge('ok', STATUS_LABEL.created);
  if (status === 'failed') return badge('error', STATUS_LABEL.failed);
  return badge('muted', STATUS_LABEL.pending);
}

/** Nome da loja para exibição; loja que já foi removida aparece pelo id. */
export function storeName(stores: Map<string, Store>, id: string): Markup {
  const store = stores.get(id);
  if (store !== undefined) return html`${store.name}`;
  return html`<span class="mono muted">${id}</span> <span class="muted">(removida)</span>`;
}

/** Número da página vindo da query string: inteiro entre 1 e MAX_PAGE; fora disso, 1. */
function parsePage(value: string | undefined): number {
  if (value === undefined || !/^[0-9]{1,6}$/.test(value)) return 1;
  const parsed = Number(value);
  return parsed >= 1 ? Math.min(parsed, MAX_PAGE) : 1;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

function sessionRow(session: CheckoutSession, stores: Map<string, Store>): Markup {
  const items = session.lines.reduce((sum, line) => sum + line.quantity, 0);
  return html`<tr>
    <td class="mono nowrap">${session.id}</td>
    <td class="nowrap">${fmtDate(session.createdAt)}</td>
    <td>${storeName(stores, session.vitrineStoreId)}</td>
    <td>${storeName(stores, session.checkoutStoreId)}</td>
    <td>${session.country ?? '—'}</td>
    <td class="num">${items}</td>
    <td>${strategyLabel(session.strategy)}</td>
    <td>${sessionStatusBadge(session.status)}</td>
    <td>${session.errorCode === null
      ? '—'
      : html`${errorCodeLabel(session.errorCode)} <span class="mono muted">${session.errorCode}</span>`}</td>
    <td class="num">${fmtMoney(session.subtotal, session.currency)}</td>
  </tr>`;
}

/** Tabela de sessões, usada aqui e na lista de falhas recentes do painel inicial. */
export function sessionsTable(sessions: CheckoutSession[], stores: Map<string, Store>): Markup {
  if (sessions.length === 0) return html`<p class="empty">Nenhuma sessão encontrada.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>
      <th>Sessão</th><th>Criada em</th><th>Vitrine</th><th>Checkout</th><th>País</th>
      <th class="num">Itens</th><th>Estratégia</th><th>Status</th><th>Erro</th><th class="num">Subtotal</th>
    </tr></thead>
    <tbody>${sessions.map((session) => sessionRow(session, stores))}</tbody>
  </table></div>`;
}

export function sessionsPage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  const stores = deps.repos.stores.list();
  const storesById = new Map(stores.map((store) => [store.id, store]));

  // Filtros desconhecidos são ignorados em vez de virar erro: a URL pode ter sido guardada
  // antes de uma loja ser removida.
  const selectedStore = storesById.get(c.req.query('store') ?? '') ?? null;
  const statusParam = c.req.query('status');
  const status = SESSION_STATUSES.find((candidate) => candidate === statusParam);
  const pageNumber = parsePage(c.req.query('page'));

  // Uma linha além da página: é assim que se sabe se existe próxima página, já que o
  // repositório não informa o total.
  const opts: SessionListOptions = { limit: PAGE_SIZE + 1, offset: (pageNumber - 1) * PAGE_SIZE };
  if (status !== undefined) opts.status = status;
  if (selectedStore !== null) {
    if (selectedStore.role === 'vitrine') opts.vitrineStoreId = selectedStore.id;
    else opts.checkoutStoreId = selectedStore.id;
  }
  const rows = deps.repos.sessions.list(opts);

  const body = html`<form class="filters" method="get" action="/admin/sessions">
      <label class="field"><span>Loja</span>
        <select name="store">
          <option value="">Todas</option>
          ${stores.map(
            (store) =>
              html`<option value="${store.id}" ${store.id === selectedStore?.id ? 'selected' : ''}>
                ${store.name} (${store.role === 'vitrine' ? 'vitrine' : 'checkout'})
              </option>`,
          )}
        </select>
      </label>
      <label class="field"><span>Status</span>
        <select name="status">
          <option value="">Todos</option>
          ${SESSION_STATUSES.map(
            (candidate) =>
              html`<option value="${candidate}" ${candidate === status ? 'selected' : ''}>${STATUS_LABEL[candidate]}</option>`,
          )}
        </select>
      </label>
      <button class="btn" type="submit">Filtrar</button>
      <a class="btn btn-link" href="/admin/sessions">Limpar</a>
    </form>
    <div class="card">
      ${sessionsTable(rows.slice(0, PAGE_SIZE), storesById)}
      ${pagination({
        page: pageNumber,
        pageSize: PAGE_SIZE,
        total: (pageNumber - 1) * PAGE_SIZE + rows.length,
        baseUrl: withQuery('/admin/sessions', { store: selectedStore?.id, status }),
        totalIsMinimum: true,
      })}
    </div>`;

  return c.html(
    page({ title: 'Sessões de checkout', active: 'sessions', session: c.get('session'), flash: takeFlash(c), body }),
  );
}

/** Filtro de alvo da auditoria vindo da URL: texto curto e sem caracteres de controle. */
function targetParam(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** O detalhe já sai do repositório com as chaves sensíveis censuradas; aqui só é encurtado. */
function detailText(detail: Record<string, unknown>): string {
  if (Object.keys(detail).length === 0) return '';
  let text: string;
  try {
    text = JSON.stringify(detail);
  } catch {
    return '';
  }
  return text.length > MAX_DETAIL_CHARS ? `${truncate(text, MAX_DETAIL_CHARS)}…` : text;
}

export function auditPage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  const pageNumber = parsePage(c.req.query('page'));
  const targetType = targetParam(c.req.query('targetType'));
  const targetId = targetParam(c.req.query('targetId'));

  const listOpts: { limit: number; offset: number; targetType?: string; targetId?: string } = {
    limit: PAGE_SIZE + 1,
    offset: (pageNumber - 1) * PAGE_SIZE,
  };
  if (targetType !== undefined) listOpts.targetType = targetType;
  if (targetId !== undefined) listOpts.targetId = targetId;
  const rows = deps.repos.audit.list(listOpts);
  const filtered = targetType !== undefined || targetId !== undefined;

  const table =
    rows.length === 0
      ? html`<p class="empty">Nenhum registro de auditoria.</p>`
      : html`<div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Alvo</th><th>Detalhe</th></tr></thead>
          <tbody>
            ${rows.slice(0, PAGE_SIZE).map(
              (entry) =>
                html`<tr>
                  <td class="nowrap">${fmtDate(entry.at)}</td>
                  <td>${entry.actor}</td>
                  <td class="mono">${entry.action}</td>
                  <td>${entry.targetType === null
                    ? '—'
                    : html`${entry.targetType} <span class="mono muted">${entry.targetId ?? ''}</span>`}</td>
                  <td class="mono break">${detailText(entry.detail)}</td>
                </tr>`,
            )}
          </tbody>
        </table></div>`;

  const body = html`${filtered
      ? html`<p class="muted">
          Mostrando só os registros de <span class="mono">${targetType ?? 'qualquer tipo'}</span>
          <span class="mono">${targetId ?? ''}</span>. <a href="/admin/audit">Ver todos</a>
        </p>`
      : ''}
    <div class="card">
      ${table}
      ${pagination({
        page: pageNumber,
        pageSize: PAGE_SIZE,
        total: (pageNumber - 1) * PAGE_SIZE + rows.length,
        baseUrl: withQuery('/admin/audit', { targetType, targetId }),
        totalIsMinimum: true,
      })}
    </div>`;

  return c.html(page({ title: 'Auditoria', active: 'audit', session: c.get('session'), flash: takeFlash(c), body }));
}

// ---------------------------------------------------------------------------
// Vendas: pedidos registrados pelos webhooks (sem dados do comprador)
// ---------------------------------------------------------------------------

const ORDER_STATUS_LABEL: Record<string, string> = {
  paid: 'Pago',
  pending: 'Pendente',
  authorized: 'Autorizado',
  partially_paid: 'Parcialmente pago',
  partially_refunded: 'Parcialmente reembolsado',
  refunded: 'Reembolsado',
  voided: 'Anulado',
};

function orderStatusBadge(status: string, cancelled: boolean): Markup {
  if (cancelled) return badge('muted', 'Cancelado');
  const label = ORDER_STATUS_LABEL[status] ?? (status === '' ? '—' : status);
  const kind = status === 'paid' ? 'ok' : status === 'refunded' || status === 'voided' ? 'error' : status === '' ? 'muted' : 'warn';
  return badge(kind, label);
}

function revenueLine(revenue: Record<string, string>): string {
  const entries = Object.entries(revenue);
  if (entries.length === 0) return formatMoney('0', 'BRL');
  return entries.map(([currency, amount]) => formatMoney(amount, currency)).join(' · ');
}

export function salesPage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  const { repos } = deps;
  const clock = deps.clock ?? systemClock;
  const stores = repos.stores.list();
  const storesById = new Map(stores.map((store) => [store.id, store]));
  const checkouts = stores.filter((s) => s.role === 'checkout');
  const vitrines = stores.filter((s) => s.role === 'vitrine');

  const period = parsePeriod(c.req.query('periodo'));
  const range = periodRange(period, clock.now().getTime());
  const storeParam = c.req.query('loja');
  const vitrineParam = c.req.query('vitrine');
  const storeId = storeParam !== undefined && storesById.has(storeParam) ? storeParam : undefined;
  const vitrineId = vitrineParam !== undefined && storesById.has(vitrineParam) ? vitrineParam : undefined;
  const pageNumber = parsePage(c.req.query('page'));

  const opts: OrderListOptions = { since: range.since, until: range.until, limit: PAGE_SIZE, offset: (pageNumber - 1) * PAGE_SIZE };
  if (storeId !== undefined) opts.storeId = storeId;
  if (vitrineId !== undefined) opts.vitrineStoreId = vitrineId;
  const { rows, total } = repos.orders.list(opts);
  const stats = repos.orders.stats({ since: range.since, until: range.until, ...(storeId === undefined ? {} : { storeId }) });
  const ticket = (() => {
    const [currency, amount] = Object.entries(stats.revenueByCurrency)[0] ?? [];
    if (currency === undefined || amount === undefined || stats.orders === 0) return '—';
    return formatMoney((Number(toMicros(amount) / BigInt(stats.orders)) / 1_000_000).toFixed(2), currency);
  })();
  const baseQuery = { periodo: period, loja: storeId, vitrine: vitrineId };

  const body = html`<div class="toolbar">
      <nav class="seg" aria-label="Período">
        ${PERIODS.map((p) =>
          p.key === period
            ? html`<a href="${withQuery('/admin/sales', { ...baseQuery, periodo: p.key })}" aria-current="true">${p.label}</a>`
            : html`<a href="${withQuery('/admin/sales', { ...baseQuery, periodo: p.key })}">${p.label}</a>`,
        )}
      </nav>
      <form method="get" action="/admin/sales" class="toolbar-form">
        <input type="hidden" name="periodo" value="${period}">
        <select name="loja" aria-label="Loja checkout"><option value="">Todas as lojas checkout</option>
          ${checkouts.map((s) => html`<option value="${s.id}" ${s.id === storeId ? 'selected' : ''}>${s.name}</option>`)}</select>
        <select name="vitrine" aria-label="Vitrine de origem"><option value="">Todas as vitrines</option>
          ${vitrines.map((s) => html`<option value="${s.id}" ${s.id === vitrineId ? 'selected' : ''}>${s.name}</option>`)}</select>
        <button class="btn btn-secondary" type="submit">Filtrar</button>
      </form>
    </div>
    <div class="kpis">
      ${kpi({ label: 'Faturamento', value: revenueLine(stats.revenueByCurrency), hint: 'reembolsos descontados' })}
      ${kpi({ label: 'Pedidos', value: String(stats.orders), hint: stats.cancelled > 0 ? `${stats.cancelled} cancelados` : '' })}
      ${kpi({ label: 'Ticket médio', value: ticket })}
      ${kpi({ label: 'Fora da ponte', value: String(stats.leakedOrders), hint: 'pedidos criados direto na vitrine', tone: stats.leakedOrders > 0 ? 'warn' : 'ok' })}
    </div>
    <div class="card">
      ${rows.length === 0
        ? html`<p class="empty">Nenhum pedido no período. Os pedidos chegam pelos webhooks das lojas (escopo read_orders).</p>`
        : html`<div class="table-wrap"><table>
            <thead><tr><th>Pedido</th><th>Data</th><th>Loja</th><th>Origem (vitrine)</th><th class="num">Itens</th><th class="num">Total</th><th class="num">Reembolsado</th><th>Status</th><th>Sessão</th></tr></thead>
            <tbody>${rows.map((o) => {
              const store = storesById.get(o.storeId);
              const leaked = store?.role === 'vitrine';
              return html`<tr>
                <td><strong>${o.orderName}</strong>${leaked ? html` ${badge('warn', 'fora da ponte')}` : ''}</td>
                <td class="nowrap">${fmtDate(o.createdAt)}</td>
                <td>${storeName(storesById, o.storeId)}</td>
                <td>${o.vitrineStoreId === null ? html`<span class="muted">—</span>` : storeName(storesById, o.vitrineStoreId)}</td>
                <td class="num">${o.lineCount}</td>
                <td class="num">${fmtMoney(o.total, o.currency)}</td>
                <td class="num">${o.totalRefunded === '0.00' ? html`<span class="muted">—</span>` : fmtMoney(o.totalRefunded, o.currency)}</td>
                <td>${orderStatusBadge(o.financialStatus, o.cancelledAt !== null)}</td>
                <td class="mono">${o.bridgeSessionId ?? '—'}</td>
              </tr>`;
            })}</tbody>
          </table></div>`}
      ${pagination({ page: pageNumber, pageSize: PAGE_SIZE, total, baseUrl: withQuery('/admin/sales', baseQuery) })}
    </div>`;

  return c.html(
    page({
      title: 'Vendas',
      description: `Pedidos das lojas checkout no período de ${fmtDate(range.since)} a ${fmtDate(range.until)}. Nenhum dado do comprador é guardado.`,
      active: 'sales',
      session: c.get('session'),
      flash: takeFlash(c),
      body,
    }),
  );
}
