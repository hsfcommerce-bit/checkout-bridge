import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatMoney } from '../../lib/money.ts';
import type { AdminSession } from '../../types.ts';
import type { Flash } from './context.ts';

/**
 * Moldura HTML do painel administrativo e os dois arquivos estáticos dele.
 *
 * Tudo é renderizado no servidor com hono/html: o template `html` escapa cada valor
 * interpolado, então nome de loja, detalhe de erro e qualquer outro texto vindo do banco
 * ou da Shopify nunca vira marcação. A política de segurança de conteúdo do painel proíbe
 * script e estilo embutidos; por isso não existe atributo style nem onclick em lugar
 * nenhum: aparência vem das classes de ADMIN_CSS e comportamento dos atributos data-* lidos
 * por ADMIN_JS. Os ícones são símbolos SVG embutidos uma vez por página (marcação, não
 * script), referenciados por <use>.
 *
 * Classes disponíveis para as páginas: card, card-head, grid, grid-2, kpis/kpi, stats/stat,
 * table-wrap (tabela com rolagem horizontal em telas estreitas), badge badge-{ok|warn|error|muted},
 * chip, btn (btn-secondary, btn-danger, btn-link, btn-small), field (rótulo + campo), form-row,
 * actions, filters, muted, mono, num (coluna numérica), nowrap, snippet (bloco <pre>),
 * empty (lista vazia), pagination, progress, columns/column, tile.
 *
 * Atributos lidos pelo script: data-confirm="pergunta" em link, botão ou formulário pede
 * confirmação antes de seguir; data-copy="#id" copia o texto (ou o valor) do elemento com
 * esse id, e data-copy="texto" copia o próprio texto.
 */

export type Markup = HtmlEscapedString | Promise<HtmlEscapedString>;

export type NavKey = 'dashboard' | 'operations' | 'stores' | 'links' | 'sales' | 'sessions' | 'audit' | 'guide';

type IconKey =
  | 'dashboard' | 'layers' | 'store' | 'route' | 'sales' | 'sessions' | 'audit' | 'guide' | 'logout' | 'plus'
  | 'cash' | 'bag' | 'ticket' | 'edit' | 'trash' | 'search' | 'refresh' | 'globe' | 'box' | 'grip' | 'dots' | 'bolt' | 'swap';

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  icon: IconKey;
}

const NAV_GROUPS: ReadonlyArray<{ title: string; items: ReadonlyArray<NavItem> }> = [
  {
    title: 'Operação',
    items: [
      { key: 'dashboard', href: '/admin', label: 'Dashboard', icon: 'dashboard' },
      { key: 'operations', href: '/admin/operations', label: 'Operações', icon: 'layers' },
      { key: 'stores', href: '/admin/stores', label: 'Lojas', icon: 'store' },
      { key: 'sales', href: '/admin/sales', label: 'Vendas', icon: 'sales' },
      { key: 'guide', href: '/admin/guide', label: 'Tutorial', icon: 'guide' },
    ],
  },
  {
    title: 'Conta',
    items: [
      { key: 'sessions', href: '/admin/sessions', label: 'Sessões', icon: 'sessions' },
      { key: 'audit', href: '/admin/audit', label: 'Auditoria', icon: 'audit' },
    ],
  },
];

/** Caminhos dos ícones (traço de 1.75, caixa 24x24). Só marcação estática, sem dados de usuário. */
const ICON_PATHS: Record<IconKey, string> = {
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h5.5"/>',
  sales: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  sessions: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  audit: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  guide: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"/><path d="M4 19a2 2 0 0 1 2-2h13"/><path d="M9 7h6"/>',
  logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 12h.01M17 12h.01"/>',
  bag: '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M12 6v12"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  refresh: '<path d="M20 12a8 8 0 0 1-14.5 4.6"/><path d="M4 12a8 8 0 0 1 14.5-4.6"/><path d="M20 4v4h-4"/><path d="M4 20v-4h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  swap: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
};

const EMPTY_VALUE = '—';

/** Ícone por nome. Decorativo: a legenda vem do texto ao lado. */
export function icon(name: IconKey): Markup {
  const safe = Object.hasOwn(ICON_PATHS, name) ? name : 'dashboard';
  return html`<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${safe}"></use></svg>`;
}

function iconSprite(): Markup {
  const symbols = (Object.keys(ICON_PATHS) as IconKey[])
    .map(
      (key) =>
        `<symbol id="i-${key}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</symbol>`,
    )
    .join('');
  // Conteúdo fixo deste arquivo; nada vindo de fora entra aqui.
  return raw(`<svg class="sprite" aria-hidden="true" focusable="false">${symbols}</svg>`);
}

/** Campo oculto com o token de CSRF da sessão. Todo formulário POST do painel precisa dele. */
export function csrfField(session: AdminSession): Markup {
  return html`<input type="hidden" name="_csrf" value="${session.csrfToken}">`;
}

export function badge(kind: 'ok' | 'warn' | 'error' | 'muted', text: string): Markup {
  // A classe sai de uma lista fixa; um valor inesperado cai no estilo neutro.
  const safeKind = kind === 'ok' || kind === 'warn' || kind === 'error' ? kind : 'muted';
  return html`<span class="badge badge-${safeKind}">${text}</span>`;
}

/** Indicador numérico de destaque (faturamento, pedidos, checkouts...). */
export function kpi(opts: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'error' | 'muted' }): Markup {
  const tone = opts.tone === 'ok' || opts.tone === 'warn' || opts.tone === 'error' ? ` kpi-${opts.tone}` : '';
  return html`<div class="kpi${tone}">
    <span class="kpi-label">${opts.label}</span>
    <span class="kpi-value">${opts.value}</span>
    ${opts.hint === undefined || opts.hint === '' ? '' : html`<span class="kpi-hint">${opts.hint}</span>`}
  </div>`;
}

/**
 * Barra segmentada. Cada parte vira uma fatia proporcional; a largura entra como classe de
 * porcentagem inteira (w-0 .. w-100) porque a CSP não permite atributo style.
 */
export function progressBar(parts: Array<{ kind: 'ok' | 'warn' | 'error' | 'muted'; value: number; label: string }>): Markup {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  if (total === 0) return html`<div class="progress progress-empty" aria-hidden="true"></div>`;
  return html`<div class="progress" role="img" aria-label="${parts.map((p) => `${p.label}: ${p.value}`).join(', ')}">
    ${parts
      .filter((p) => p.value > 0)
      .map((p) => {
        const pct = Math.max(1, Math.round((p.value / total) * 100));
        const kind = p.kind === 'ok' || p.kind === 'warn' || p.kind === 'error' ? p.kind : 'muted';
        return html`<span class="progress-${kind} w-${pct}" title="${p.label}: ${p.value}"></span>`;
      })}
  </div>`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Data e hora no formato brasileiro, sempre em UTC e com o fuso escrito. O servidor não
 * sabe o fuso de quem está olhando, e uma hora sem fuso num painel de diagnóstico leva a
 * conclusões erradas ao cruzar com os horários da Shopify.
 */
export function fmtDate(iso: string | null): string {
  if (iso === null || iso === undefined || iso === '') return EMPTY_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  const day = `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
  return `${day} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

export function fmtMoney(amount: string | null, currency: string | null): string {
  if (amount === null || amount === undefined || amount === '') return EMPTY_VALUE;
  // Sem moeda não dá para formatar como dinheiro; mostra o número como veio.
  if (currency === null || currency === undefined || currency === '') return amount;
  return formatMoney(amount, currency);
}

/**
 * Navegação entre páginas de uma lista. `baseUrl` já traz os outros parâmetros da consulta
 * (filtros); aqui só entra o parâmetro page.
 *
 * `totalIsMinimum` serve às listas cujo repositório não informa o total (sessões e
 * auditoria): quem chama passa "pelo menos N" e a barra mostra só a página atual e os
 * botões, sem inventar um "de Y" que não conhece.
 */
export function pagination(opts: {
  page: number;
  pageSize: number;
  total: number;
  baseUrl: string;
  totalIsMinimum?: boolean;
}): Markup {
  const pageSize = Number.isFinite(opts.pageSize) && opts.pageSize >= 1 ? Math.floor(opts.pageSize) : 1;
  const total = Number.isFinite(opts.total) && opts.total > 0 ? Math.floor(opts.total) : 0;
  const page = Number.isFinite(opts.page) && opts.page >= 1 ? Math.floor(opts.page) : 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1 && page <= 1) return html``;

  const separator = opts.baseUrl.includes('?') ? '&' : '?';
  const href = (target: number): string => `${opts.baseUrl}${separator}page=${target}`;
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;
  const position = opts.totalIsMinimum === true ? `Página ${page}` : `Página ${page} de ${totalPages}`;
  const count = opts.totalIsMinimum === true ? '' : total === 1 ? '1 registro' : `${total} registros`;

  return html`<nav class="pagination" aria-label="Paginação">
    ${hasPrevious
      ? html`<a class="btn btn-secondary btn-small" rel="prev" href="${href(page - 1)}">Anterior</a>`
      : html`<span class="btn btn-secondary btn-small is-disabled" aria-disabled="true">Anterior</span>`}
    <span class="muted">${position}${count === '' ? '' : ` · ${count}`}</span>
    ${hasNext
      ? html`<a class="btn btn-secondary btn-small" rel="next" href="${href(page + 1)}">Próxima</a>`
      : html`<span class="btn btn-secondary btn-small is-disabled" aria-disabled="true">Próxima</span>`}
  </nav>`;
}

function flashBanner(flash: Flash | null | undefined): Markup | '' {
  if (flash === null || flash === undefined || flash.text === '') return '';
  const kind = flash.kind === 'ok' ? 'ok' : 'error';
  // role=alert só no erro: sucesso é informativo e não deve interromper o leitor de tela.
  return html`<div class="flash flash-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${flash.text}</div>`;
}

function sidebar(session: AdminSession, active: NavKey | null, host: string): Markup {
  return html`<aside class="sidebar">
    <a class="brand" href="/admin"><span class="brand-mark" aria-hidden="true">CB</span><span class="brand-name">Checkout Bridge</span></a>
    <nav class="nav" aria-label="Seções do painel">
      ${NAV_GROUPS.map(
        (group) => html`<div class="nav-group">
          <div class="nav-title">${group.title}</div>
          ${group.items.map((item) =>
            item.key === active || (active === 'links' && item.key === 'operations')
              ? html`<a href="${item.href}" aria-current="page">${icon(item.icon)}<span>${item.label}</span></a>`
              : html`<a href="${item.href}">${icon(item.icon)}<span>${item.label}</span></a>`,
          )}
        </div>`,
      )}
    </nav>
    <div class="sidebar-foot">
      <div class="user-block">
        <span class="avatar" aria-hidden="true">AD</span>
        <div class="user-text"><div class="user-name">Administrador</div><div class="user-sub">${host}</div></div>
        <form class="logout" method="post" action="/admin/logout" title="Sair">
          ${csrfField(session)}
          <button class="icon-button" type="submit" aria-label="Sair">${icon('logout')}</button>
        </form>
      </div>
    </div>
  </aside>`;
}

/**
 * Documento HTML completo. Com `session` nula (tela de login, erro sem sessão) não há menu
 * e o conteúdo fica centralizado. `description` e `actions` entram no cabeçalho da página.
 */
export function page(opts: {
  title: string;
  active: NavKey | null;
  session: AdminSession | null;
  flash?: Flash | null;
  body: unknown;
  description?: string;
  actions?: unknown;
  /** Host público do serviço, mostrado no bloco do usuário. */
  host?: string;
}): Markup {
  const { session } = opts;
  const head = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${opts.title} · Checkout Bridge</title>
<link rel="stylesheet" href="/admin/assets/app.css">
<script src="/admin/assets/app.js" defer></script>
</head>`;

  if (session === null) {
    return html`${head}
<body class="body-plain">
${iconSprite()}
<main class="plain">
  <div class="plain-brand"><span class="brand-mark" aria-hidden="true">CB</span><span class="brand-name">Checkout Bridge</span></div>
  ${flashBanner(opts.flash)}
  <h1>${opts.title}</h1>
  ${opts.body}
</main>
</body>
</html>`;
  }

  return html`${head}
<body>
${iconSprite()}
<div class="shell">
  <input type="checkbox" id="menu-toggle" class="menu-toggle" aria-hidden="true">
  <header class="mobile-bar">
    <a class="brand" href="/admin"><span class="brand-mark" aria-hidden="true">CB</span><span class="brand-name">Checkout Bridge</span></a>
    <label for="menu-toggle" class="menu-button">Menu</label>
  </header>
  ${sidebar(session, opts.active, opts.host ?? '')}
  <div class="content">
    <header class="topbar">
      <div class="topbar-title">
        <h1>${opts.title}</h1>
        ${opts.description === undefined || opts.description === '' ? '' : html`<p class="page-description">${opts.description}</p>`}
      </div>
      ${opts.actions === undefined || opts.actions === null || opts.actions === '' ? '' : html`<div class="page-actions">${opts.actions}</div>`}
    </header>
    <main>
      ${flashBanner(opts.flash)}
      ${opts.body}
    </main>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Arquivos estáticos (servidos em /admin/assets/app.css e /admin/assets/app.js)
// ---------------------------------------------------------------------------

const WIDTH_CLASSES = Array.from({ length: 101 }, (_, i) => `.w-${i}{flex-basis:${i}%}`).join('');

export const ADMIN_CSS = `:root {
  color-scheme: light dark;
  --bg: #f7f7f7; --surface: #ffffff; --surface-2: #fafafa; --text: #0a0a0a; --muted: #6b7280; --border: #e8e8e8;
  --accent: #f05a1a; --accent-strong: #d84b0f; --accent-soft: #fdebe3; --accent-text: #ffffff; --row: #f3f5f7;
  --ok: #15803d; --ok-bg: #e4f6ea; --warn: #92400e; --warn-bg: #fdf0d5;
  --error: #b91c1c; --error-bg: #fde8e7; --neutral-bg: #eceff3;
  --side-bg: #0a0a0a; --side-bg-2: #050505; --side-text: #d4d4d4; --side-muted: #7a7a7a; --side-active: #1c1c1c; --side-border: #1f1f1f;
  --shadow: 0 4px 20px -16px rgba(59, 33, 15, .19);
  --radius: 18px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --surface: #171b21; --surface-2: #1c2128; --text: #e6e9ee; --muted: #9aa3ae; --border: #2a3039;
    --accent: #f26a2e; --accent-strong: #ff7f45; --accent-soft: #3a2117; --accent-text: #ffffff; --row: #1f252c;
    --ok: #4ade80; --ok-bg: #11301d; --warn: #fbbf24; --warn-bg: #3a2a0a;
    --error: #f87171; --error-bg: #3f1816; --neutral-bg: #262c34;
    --side-bg: #101010; --side-bg-2: #0a0a0a; --side-text: #d4d4d4; --side-muted: #737373; --side-active: #222222; --side-border: #222222;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
h1 { font-size: 1.45rem; line-height: 1.2; margin: 0; letter-spacing: -.01em; text-wrap: balance; }
h2 { font-size: 1rem; margin: 0 0 .75rem; }
h3 { font-size: .92rem; margin: 0 0 .5rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 .75rem; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.icon { width: 18px; height: 18px; flex: 0 0 auto; vertical-align: -3px; }

/* Casca: barra lateral fixa + conteúdo */
.shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
.content { min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1rem;
  padding: .85rem 1.5rem; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 3; }
.topbar h1 { font-size: 1.15rem; }
.topbar .page-description { font-size: .82rem; margin: .1rem 0 0; }
.icon-button { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; padding: 0; }
.icon-button:hover { background: var(--row); }
.icon-button.danger { color: var(--error); }
.icon-button.danger:hover { background: var(--error-bg); border-color: color-mix(in srgb, var(--error) 40%, transparent); }
.user-block { display: flex; align-items: center; gap: .6rem; padding: .35rem .3rem; }
.user-block .icon-button { background: transparent; border-color: var(--side-border); color: var(--side-text); width: 32px; height: 32px; }
.user-block .icon-button:hover { background: var(--side-active); }
.avatar { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--accent); color: #fff; font-weight: 700; font-size: .8rem; flex: 0 0 auto; }
.user-text { min-width: 0; flex: 1 1 auto; }
.user-name { color: #fff; font-weight: 650; font-size: .9rem; }
.user-sub { color: var(--side-muted); font-size: .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: .3rem; padding: .25rem .6rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: .78rem; color: var(--muted); }
.pill strong { color: var(--text); }
.section-title { font-size: 1.45rem; font-weight: 700; letter-spacing: -.02em; margin: 0; }
.section-sub { color: var(--muted); margin: .2rem 0 0; }
.section-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: .5rem 1rem; margin: .25rem 0 1rem; }
.dot-note { font-size: .78rem; color: var(--muted); }
.dot-note::before { content: ""; display: inline-block; width: .45rem; height: .45rem; border-radius: 50%; background: var(--accent); margin-right: .35rem; vertical-align: 1px; }
.kpi .kpi-icon { position: absolute; right: .9rem; top: .9rem; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); }
.kpi { position: relative; padding: 1rem 1.1rem; gap: .35rem; }
.kpi-value { font-size: 1.9rem; }
.kpi-label { font-size: .9rem; color: var(--muted); font-weight: 500; }
.hero { position: relative; overflow: hidden; border-radius: 22px; padding: 1.6rem 1.8rem; color: #fff; margin: 0 0 1.25rem;
  background: radial-gradient(120% 140% at 20% 0%, #4a2a12 0%, #1a1410 45%, #0a0a0a 100%); display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 1.5rem; align-items: center; }
.hero h2 { font-size: 1.7rem; line-height: 1.15; margin: .6rem 0 .5rem; letter-spacing: -.02em; }
.hero p { color: #cfc7bf; max-width: 46ch; }
.hero-chip { display: inline-flex; align-items: center; gap: .35rem; padding: .25rem .7rem; border-radius: 999px; background: rgba(240, 90, 26, .18); color: #ffb08a; font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; border: 1px solid rgba(240, 90, 26, .35); }
.hero-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
.hero .btn-secondary { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.14); }
.hero-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; background: rgba(255,255,255,.04); overflow: hidden; }
.hero-stat { padding: .9rem 1rem; border-right: 1px solid rgba(255,255,255,.08); min-width: 0; }
.hero-stat:last-child { border-right: 0; }
.hero-stat .icon { color: var(--accent); width: 20px; height: 20px; }
.hero-stat-label { font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; color: #a39b93; margin: .4rem 0 .15rem; }
.hero-stat-value { font-size: 1.35rem; font-weight: 700; }
.kanban { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); gap: 1rem; overflow-x: auto; padding-bottom: .5rem; align-items: start; }
.kanban-col { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); min-height: 220px; display: flex; flex-direction: column; }
.kanban-col.is-over { outline: 2px dashed var(--accent); outline-offset: -4px; }
.kanban-head { display: flex; align-items: center; gap: .5rem; padding: .8rem .9rem; border-bottom: 1px solid var(--border); }
.kanban-head .grip { color: var(--muted); }
.kanban-head h3 { margin: 0; flex: 1 1 auto; font-size: .95rem; text-transform: none; letter-spacing: 0; color: var(--text); }
.kanban-head form { margin: 0; }
.kanban-body { padding: .75rem; display: flex; flex-direction: column; gap: .6rem; flex: 1 1 auto; }
.kanban-empty { border: 1px dashed var(--border); border-radius: 12px; min-height: 96px; display: grid; place-items: center; color: var(--muted); font-size: .85rem; text-align: center; padding: 1rem; }
.kanban-card { border: 1px solid var(--border); border-radius: 14px; padding: .75rem .8rem; background: var(--surface); cursor: grab; }
.kanban-card:active { cursor: grabbing; }
.kanban-card.is-dragging { opacity: .5; }
.kanban-card-head { display: flex; align-items: center; gap: .4rem; }
.kanban-card-head .grip { color: var(--muted); }
.kanban-card-head strong { flex: 1 1 auto; }
.kanban-card .domain { font-size: .8rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.kanban-card .public { font-size: .85rem; color: var(--accent); }
.kanban-card .age { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: .35rem 0; }
.kanban-note { border-top: 1px solid var(--border); padding-top: .5rem; margin-top: .25rem; }
.kanban-note-label { font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.kanban-note textarea { min-height: 2.6rem; font-size: .85rem; border: 0; padding: .25rem 0; background: transparent; max-width: none; resize: vertical; }
.kanban-note textarea:focus { box-shadow: none; outline: none; }
.kanban-note .btn { margin-top: .25rem; }
.kanban-new { border: 1px dashed var(--border); border-radius: var(--radius); display: grid; place-items: center; min-height: 64px; }
.kanban-new form { display: flex; gap: .4rem; padding: .75rem; }
.kanban-new input { max-width: 12rem; }
.card-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); }
.card-icon.teal { background: #e3f3ef; color: #0f766e; }
.store-section { padding: 1.1rem 1.2rem; }
.store-section .section-head { align-items: center; margin: 0 0 1rem; }
.store-section .section-head h2 { margin: 0; font-size: 1.05rem; }
.footer-note { display: flex; justify-content: space-between; color: var(--muted); font-size: .8rem; margin: .5rem 0 0; }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column;
  background: var(--side-bg); color: var(--side-text);
  border-right: 1px solid var(--side-border); padding: 1rem .9rem; }
.brand { display: flex; align-items: center; gap: .6rem; color: inherit; text-decoration: none; padding: .25rem .5rem; }
.brand-mark { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px;
  background: var(--accent); color: var(--accent-text); font-weight: 800; font-size: .78rem; letter-spacing: .02em; }
.brand-name { font-weight: 800; font-size: 1.05rem; color: #fff; letter-spacing: -.01em; }
.brand-name em { font-style: normal; color: var(--accent); }
.nav { display: flex; flex-direction: column; gap: 1.1rem; margin-top: 1.25rem; flex: 1 1 auto; }
.nav-group { display: flex; flex-direction: column; gap: .15rem; }
.nav-title { font-size: .7rem; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--side-muted); padding: 0 .6rem .35rem; }
.nav a, .nav-link { display: flex; align-items: center; gap: .6rem; padding: .5rem .6rem; border-radius: 8px;
  color: var(--side-text); text-decoration: none; font-weight: 500; border: 0; background: transparent; font: inherit; width: 100%; cursor: pointer; text-align: left; }
.nav a:hover, .nav-link:hover { background: var(--side-active); color: #fff; }
.nav a[aria-current="page"] { background: var(--side-active); color: #fff; }
.nav a[aria-current="page"] .icon { color: var(--accent); }
.nav .icon { color: var(--side-muted); }
.nav a:hover .icon { color: var(--accent); }
.sidebar-foot { border-top: 1px solid var(--side-border); padding-top: .75rem; }
.logout { margin: 0; }
main { padding: 1.5rem 1.75rem 3rem; width: 100%; max-width: 1400px; }
.page-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem 1rem; margin: 0 0 1.25rem; }
.page-description { color: var(--muted); margin: .25rem 0 0; max-width: 60ch; }
.page-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.mobile-bar { display: none; }
.menu-toggle { display: none; }

/* Tela sem sessão (login, erro) */
.body-plain { display: grid; place-items: center; min-height: 100vh; padding: 1rem; }
main.plain { max-width: 26rem; width: 100%; padding: 0; }
main.plain h1 { font-size: 1.25rem; margin: 0 0 1rem; text-align: center; }
.plain-brand { display: flex; align-items: center; justify-content: center; gap: .6rem; margin: 0 0 1.25rem; }
.plain-brand .brand-name { color: var(--text); font-size: 1.1rem; }

/* Cartões e grades */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.2rem 1.3rem; margin: 0 0 1rem; box-shadow: var(--shadow); }
.card > :last-child { margin-bottom: 0; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin: 0 0 .75rem; }
.card-head h2 { margin: 0; }
.narrow { max-width: 26rem; margin-left: auto; margin-right: auto; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); margin: 0 0 1rem; }
.grid-2 { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 1rem; }
.grid > .card, .grid-2 > .card, .columns .card { margin: 0; }
.columns { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin: 0 0 1rem; }
.column { display: flex; flex-direction: column; gap: .75rem; }
.column-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: 0 .25rem; }
.column-head h2 { margin: 0; }
.count-pill { display: inline-grid; place-items: center; min-width: 1.6rem; height: 1.6rem; padding: 0 .45rem; border-radius: 999px;
  background: var(--neutral-bg); color: var(--muted); font-size: .78rem; font-weight: 700; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: .9rem 1rem; box-shadow: var(--shadow); }
.tile-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; margin: 0 0 .4rem; }
.tile-title { font-weight: 650; font-size: .98rem; }
.tile-title a { color: inherit; text-decoration: none; }
.tile-title a:hover { text-decoration: underline; }
.tile-meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .75rem; font-size: .88rem; margin: .4rem 0 .6rem; }
.tile-meta dt { color: var(--muted); }
.tile-meta dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.tile-foot { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }

/* Indicadores */
.kpis { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin: 0 0 1rem; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: .85rem 1rem;
  display: flex; flex-direction: column; gap: .15rem; box-shadow: var(--shadow); min-width: 0; }
.kpi-label { color: var(--muted); font-size: .8rem; font-weight: 600; }
.kpi-value { font-size: 1.5rem; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -.01em; overflow-wrap: anywhere; }
.kpi-hint { color: var(--muted); font-size: .78rem; }
.kpi-ok .kpi-value { color: var(--ok); } .kpi-warn .kpi-value { color: var(--warn); } .kpi-error .kpi-value { color: var(--error); }
.stats { display: flex; flex-wrap: wrap; gap: .5rem 2rem; margin: 0 0 .75rem; }
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.5rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-label { color: var(--muted); font-size: .82rem; }
.progress { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--neutral-bg); margin: .35rem 0; }
.progress-empty { opacity: .6; }
.progress > span { display: block; height: 100%; flex: 0 0 auto; min-width: 2px; }
.progress-ok { background: var(--ok); } .progress-warn { background: #d97706; } .progress-error { background: var(--error); } .progress-muted { background: #9aa3ae; }
${WIDTH_CLASSES}
.legend { display: flex; flex-wrap: wrap; gap: .25rem .9rem; font-size: .8rem; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: .6rem; height: .6rem; border-radius: 2px; margin-right: .3rem; vertical-align: -1px; }
.legend .l-ok::before { background: var(--ok); } .legend .l-warn::before { background: #d97706; } .legend .l-error::before { background: var(--error); } .legend .l-muted::before { background: #9aa3ae; }
.rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .55rem; }
.rank li { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr) auto; gap: .25rem .6rem; align-items: center; }
.rank li > span:nth-child(2) { min-width: 0; overflow-wrap: anywhere; }
.rank .num strong { font-size: .95rem; }
.rank .rank-n { display: inline-grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 7px; background: var(--accent-soft); color: var(--accent); }
.hero-stat-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rank .rank-n { color: var(--muted); font-weight: 700; font-size: .8rem; }
.rank .rank-bar { grid-column: 2 / span 2; }

/* Tabelas */
.table-wrap { overflow-x: auto; margin: 0 0 .75rem; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; background: var(--surface-2); }
tbody tr:hover { background: var(--row); }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.muted { color: var(--muted); }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .84rem; }
.break { overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: .75rem 0; }
.empty-state { text-align: center; padding: 1.5rem 1rem; color: var(--muted); }
.empty-state .icon { width: 28px; height: 28px; color: var(--muted); margin-bottom: .4rem; }
.offscreen { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }
.diverge { text-decoration: underline wavy var(--error); text-decoration-thickness: 1.5px; text-underline-offset: 3px; cursor: help; }

/* Etiquetas, mensagens, botões */
.badge { display: inline-block; padding: .08rem .55rem; border-radius: 999px; font-size: .75rem; font-weight: 650; white-space: nowrap; }
.badge-ok { color: var(--ok); background: var(--ok-bg); }
.badge-warn { color: var(--warn); background: var(--warn-bg); }
.badge-error { color: var(--error); background: var(--error-bg); }
.badge-muted { color: var(--muted); background: var(--neutral-bg); }
.chip { display: inline-block; padding: .1rem .5rem; border-radius: 6px; font-size: .78rem; background: var(--neutral-bg); color: var(--text); white-space: nowrap; }
.flash { padding: .65rem .9rem; border-radius: 10px; margin: 0 0 1rem; border: 1px solid transparent; }
.flash-ok { color: var(--ok); background: var(--ok-bg); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.flash-error { color: var(--error); background: var(--error-bg); border-color: color-mix(in srgb, var(--error) 35%, transparent); }
.banner-warn { padding: .75rem 1rem; border-radius: 10px; margin: 0 0 1rem; background: var(--warn-bg); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); }
.btn { display: inline-flex; align-items: center; gap: .4rem; padding: .48rem .9rem; border-radius: 8px; border: 1px solid var(--accent);
  background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; line-height: 1.2; }
.btn:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
.btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
.btn-secondary:hover { background: var(--row); border-color: var(--border); }
.btn-danger { background: transparent; color: var(--error); border-color: color-mix(in srgb, var(--error) 50%, transparent); }
.btn-danger:hover { background: var(--error-bg); border-color: var(--error); }
.btn-link { background: transparent; color: var(--accent); border-color: transparent; padding: .3rem .4rem; }
.btn-link:hover { background: var(--accent-soft); border-color: transparent; }
.btn-small { padding: .25rem .6rem; font-size: .82rem; }
.btn.is-disabled { opacity: .45; cursor: default; pointer-events: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Formulários e filtros */
.field { display: flex; flex-direction: column; gap: .3rem; margin: 0 0 .9rem; }
.field > span, label { font-weight: 600; font-size: .88rem; }
.field small { color: var(--muted); font-weight: 400; }
input[type="text"], input[type="password"], input[type="number"], input[type="search"], input[type="url"], input[type="date"],
select, textarea { font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; padding: .5rem .65rem; width: 100%; max-width: 34rem; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
textarea { min-height: 6rem; }
.form-row, .filters, .actions { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: flex-end; }
.filters { margin: 0 0 1rem; padding: .75rem .9rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.filters .field { margin: 0; }
.filters select { width: auto; min-width: 11rem; }
.actions { align-items: center; margin: 0 0 .75rem; }
.actions form { margin: 0; }
.seg { display: inline-flex; gap: .15rem; border: 1px solid var(--border); border-radius: 12px; padding: .25rem; background: var(--surface); }
.seg a { padding: .35rem .8rem; color: var(--muted); text-decoration: none; font-size: .85rem; font-weight: 600; border-radius: 9px; }
.seg a:hover { color: var(--text); }
.seg a[aria-current="true"] { background: var(--accent-soft); color: var(--accent-strong); }
.snippet, pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
  padding: .75rem .9rem; overflow-x: auto; white-space: pre; margin: 0 0 .75rem; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin: .75rem 0 0; }
dl.pairs { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; margin: 0 0 .75rem; }
dl.pairs dt { color: var(--muted); }
dl.pairs dd { margin: 0; font-variant-numeric: tabular-nums; }
details.section { border: 1px solid var(--border); border-radius: 10px; margin: 0 0 .75rem; background: var(--surface); }
details.section > summary { cursor: pointer; padding: .7rem .9rem; font-weight: 650; list-style: none; }
details.section > summary::-webkit-details-marker { display: none; }
details.section > summary::before { content: "▸"; display: inline-block; margin-right: .5rem; color: var(--muted); transition: transform .15s; }
details.section[open] > summary::before { transform: rotate(90deg); }
details.section > .section-body { padding: 0 .9rem .9rem; }

/* Painel de vendas */
.toolbar { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; justify-content: space-between; margin: 0 0 1rem; }
.toolbar-form { display: flex; gap: .5rem; align-items: center; margin: 0; }
.toolbar-form select { width: auto; min-width: 12rem; }
.grid-wide { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
.chart { width: 100%; height: auto; display: block; }
.chart-grid { stroke: var(--border); stroke-width: 1; }
.chart-axis { fill: var(--muted); font-size: 11px; font-family: inherit; }
.chart-bar { fill: var(--accent); opacity: .9; }
.chart-bar:hover { opacity: 1; }
.chart-empty { color: var(--muted); padding: 2rem 0; text-align: center; }
.route-list { display: flex; flex-direction: column; gap: .75rem; }
.route-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .6rem 0; border-bottom: 1px solid var(--border); }
.route-row:last-child { border-bottom: 0; padding-bottom: 0; }
@media (max-width: 900px) { .grid-wide { grid-template-columns: 1fr; } .route-row { grid-template-columns: 1fr; } }

.store-id { display: flex; gap: .6rem; align-items: center; min-width: 0; }
.store-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
.tile-badges { display: flex; flex-wrap: wrap; gap: .3rem; justify-content: flex-end; }
.store-tile .tile-meta { background: var(--surface-2); border-radius: 8px; padding: .5rem .7rem; }

.prose { max-width: 80ch; line-height: 1.6; }
.prose h1 { font-size: 1.4rem; margin: 0 0 1rem; }
.prose h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
.prose h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; text-transform: none; letter-spacing: 0; color: var(--text); }
.prose h4 { font-size: .95rem; margin: 1rem 0 .3rem; }
.prose ul, .prose ol { padding-left: 1.4rem; margin: 0 0 .9rem; }
.prose li { margin: .2rem 0; }
.prose pre { white-space: pre-wrap; }
.guide-tabs { margin: 0 0 1rem; }
.link-grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.link-tile .tile-title { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.arrow { color: var(--muted); }

.kpis-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.chart-total { font-size: 1.7rem; font-weight: 700; letter-spacing: -.02em; margin: .25rem 0 .75rem; font-variant-numeric: tabular-nums; }
.daily-values { margin-top: .75rem; }
.daily-values > summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
.custom-period { position: relative; }
.custom-period > summary { list-style: none; padding: .35rem .8rem; border-radius: 9px; color: var(--muted); font-weight: 600; font-size: .85rem; cursor: pointer; }
.custom-period > summary::-webkit-details-marker { display: none; }
.custom-period > summary.is-active, .custom-period[open] > summary { background: var(--accent-soft); color: var(--accent-strong); }
.custom-period-form { position: absolute; z-index: 5; top: calc(100% + .4rem); left: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: .75rem; box-shadow: var(--shadow); display: flex; gap: .5rem; align-items: end; white-space: nowrap; }
.custom-period-form label { display: flex; flex-direction: column; gap: .2rem; font-size: .78rem; }
.custom-period-form input { width: auto; }
.menu { position: relative; }
.menu > summary { list-style: none; }
.menu > summary::-webkit-details-marker { display: none; }
.menu-body { position: absolute; right: 0; top: calc(100% + .3rem); z-index: 5; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: .6rem; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: .5rem; min-width: 220px; }
.menu-body form { display: flex; gap: .4rem; margin: 0; }
.kanban-move { display: none; }
@media (max-width: 1250px) { .hero-stats { grid-template-columns: repeat(2, 1fr); } .hero-stat:nth-child(2) { border-right: 0; } .hero-stat:nth-child(-n+2) { border-bottom: 1px solid rgba(255,255,255,.08); } }
@media (max-width: 900px) { .kpis-3 { grid-template-columns: 1fr; } .hero { grid-template-columns: 1fr; } }

.tile-foot-split { justify-content: space-between; }
.tile-foot-left { display: flex; gap: .4rem; align-items: center; }
.tile-foot form { margin: 0; }
.tile-meta-sales { grid-template-columns: max-content 1fr max-content 1fr; }
.tile-meta-sales dt { display: flex; align-items: center; gap: .3rem; }
.tile-meta-sales .icon { width: 14px; height: 14px; color: var(--accent); }
@media (max-width: 700px) { .tile-meta-sales { grid-template-columns: max-content 1fr; } }

/* Adicionar loja */
.add-store { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 1.25rem; align-items: start; }
.add-store .card { margin: 0; }
.add-store-help h2 { display: flex; align-items: center; gap: .4rem; }
.type-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; padding: .35rem; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); }
.type-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.type-toggle label { text-align: center; padding: .6rem; border-radius: 10px; font-weight: 600; cursor: pointer; color: var(--muted); background: var(--surface); border: 1px solid var(--border); }
.type-toggle input:checked + label { background: var(--accent); color: #fff; border-color: var(--accent); }
.type-toggle input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }
.input-suffix { display: flex; align-items: stretch; max-width: 34rem; }
.input-suffix input { flex: 1 1 auto; max-width: none; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.input-suffix .suffix { display: flex; align-items: center; padding: 0 .7rem; border: 1px solid var(--border); border-left: 0; border-radius: 0 8px 8px 0; background: var(--surface-2); color: var(--muted); white-space: nowrap; }
.input-suffix .suffix-btn { border-radius: 0 8px 8px 0; border-left: 0; height: auto; }
.btn-block { display: flex; justify-content: center; width: 100%; padding: .7rem; font-size: 1rem; margin-top: .5rem; }
.steps { list-style: none; counter-reset: step; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1rem; }
.steps > li { position: relative; padding-left: 2.2rem; }
.steps > li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 0; width: 1.6rem; height: 1.6rem; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: .8rem; display: grid; place-items: center; }
.steps > li > strong { display: block; margin-bottom: .2rem; }
.substeps { margin: .35rem 0 0; padding-left: 1.2rem; }
.substeps li { margin: .15rem 0; }
.code-box { display: inline-flex; align-items: center; gap: .4rem; max-width: 100%; margin: .3rem 0; }
.code-box code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: .3rem .55rem; color: var(--accent-strong); overflow-wrap: anywhere; }
.code-box .icon-button { width: 30px; height: 30px; }
.add-store:has(#role-checkout:checked) .steps-vitrine, .add-store:has(#role-checkout:checked) .only-vitrine { display: none; }
.add-store:has(#role-vitrine:checked) .steps-checkout, .add-store:has(#role-vitrine:checked) .only-checkout { display: none; }
@media (max-width: 1000px) { .add-store { grid-template-columns: 1fr; } }

/* Assistente de nova operação */
.wizard { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 1.5rem; align-items: start; }
.wizard-title { font-size: 2rem; line-height: 1.1; letter-spacing: -.03em; margin: 0 0 .75rem; }
.wizard-steps { list-style: none; margin: 1.25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
.wizard-steps li { display: flex; align-items: center; gap: .8rem; padding: .8rem .9rem; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.wizard-steps li.is-current { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.wizard-steps .step-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: var(--surface-2); color: var(--muted); font-weight: 700; }
.wizard-steps li.is-current .step-icon, .wizard-steps li.is-done .step-icon { background: var(--accent); color: #fff; }
.step-k { font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.step-l { font-weight: 650; }
.wizard-main { margin: 0; }
.wiz-k { font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: .4rem; }
.wiz-input { width: 100%; max-width: none; font-size: 1.05rem; padding: .8rem 1rem; border-radius: 12px; margin-top: 1rem; }
.wiz-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.pick-list { display: flex; flex-direction: column; gap: .5rem; margin-top: 1rem; }
.pick { display: grid; grid-template-columns: auto 1fr auto; gap: .8rem; align-items: center; padding: .8rem 1rem; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); cursor: pointer; font-weight: 400; }
.pick:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.pick input { width: 18px; height: 18px; accent-color: var(--accent); }
.center { text-align: center; }
@media (max-width: 900px) { .wizard { grid-template-columns: 1fr; } }

/* Central da operação */
.op-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; padding: .25rem 0 1rem; margin: 0 0 1rem; border-bottom: 1px solid var(--border); }
.op-name { font-size: 1.3rem; font-weight: 700; }
.inline-form { margin: 0; }
.switch { width: 48px; height: 26px; border-radius: 999px; border: 0; background: #cfd4da; position: relative; cursor: pointer; padding: 0; }
.switch span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.switch.is-on { background: #16a34a; }
.switch.is-on span { left: 25px; }
.alert-error { display: flex; gap: .9rem; align-items: flex-start; padding: 1rem 1.1rem; border-radius: 14px; background: var(--error-bg); border: 1px solid color-mix(in srgb, var(--error) 35%, transparent); color: var(--error); margin: 0 0 1.25rem; }
.alert-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: color-mix(in srgb, var(--error) 15%, transparent); font-weight: 800; flex: 0 0 auto; }
.alert-chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
.chip-error { display: inline-flex; align-items: center; gap: .3rem; color: var(--error); background: transparent; border: 1px solid color-mix(in srgb, var(--error) 40%, transparent); text-decoration: none; padding: .25rem .6rem; border-radius: 999px; }
.chip-error .icon { width: 14px; height: 14px; }
.col-label { display: flex; align-items: center; gap: .4rem; font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 700; margin: 0 0 .6rem; }
.store-tile.is-active { border-color: #86efac; box-shadow: 0 0 0 3px #dcfce7; }
.store-icon.teal { background: #e3f3ef; color: #0f766e; }
.tile-sep { border-top: 1px solid var(--border); margin: .75rem 0; }
.dot-ok { color: #16a34a; font-weight: 600; }
.public { color: var(--accent); font-size: .9rem; }
.add-checkout > summary { color: var(--muted); }

.op-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
/* Responsivo */
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .mobile-bar { display: flex; align-items: center; justify-content: space-between; padding: .5rem .75rem;
    background: var(--side-bg); color: var(--side-text); position: sticky; top: 0; z-index: 2; }
  .menu-button { padding: .35rem .7rem; border: 1px solid var(--side-border); border-radius: 8px; color: #fff; cursor: pointer; font-weight: 600; }
  .sidebar { display: none; position: static; height: auto; }
  .menu-toggle:checked ~ .sidebar { display: flex; }
  main { padding: 1rem .9rem 2.5rem; }
  .grid-2 { grid-template-columns: 1fr; }
  input[type="text"], input[type="password"], input[type="number"], input[type="search"], input[type="url"], input[type="date"],
  select, textarea { max-width: none; }
}
@media (prefers-reduced-motion: no-preference) { .btn { transition: background .12s, border-color .12s; } }
`;

export const ADMIN_JS = `(function () {
  'use strict';

  // Campo de segredo: botão que alterna entre ocultar e mostrar o valor.
  document.addEventListener('click', function (event) {
    var toggle = event.target instanceof Element ? event.target.closest('[data-toggle-secret]') : null;
    if (!toggle) return;
    var input = document.querySelector(toggle.getAttribute('data-toggle-secret') || '');
    if (input && 'type' in input) input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Quadro de operações: arrastar cartão entre colunas. Ao soltar, preenche e envia o
  // formulário oculto do cartão (POST normal, com CSRF); sem script, o quadro continua
  // funcionando pelos formulários visíveis.
  var dragging = null;
  document.addEventListener('dragstart', function (event) {
    var card = event.target instanceof Element ? event.target.closest('.kanban-card') : null;
    if (!card) return;
    dragging = card;
    card.classList.add('is-dragging');
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; try { event.dataTransfer.setData('text/plain', card.getAttribute('data-store') || ''); } catch (e) {} }
  });
  document.addEventListener('dragend', function () {
    if (dragging) dragging.classList.remove('is-dragging');
    dragging = null;
    Array.prototype.forEach.call(document.querySelectorAll('.kanban-col.is-over'), function (col) { col.classList.remove('is-over'); });
  });
  document.addEventListener('dragover', function (event) {
    var col = event.target instanceof Element ? event.target.closest('.kanban-col') : null;
    if (!col || !dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    col.classList.add('is-over');
  });
  document.addEventListener('dragleave', function (event) {
    var col = event.target instanceof Element ? event.target.closest('.kanban-col') : null;
    if (col && !col.contains(event.relatedTarget)) col.classList.remove('is-over');
  });
  document.addEventListener('drop', function (event) {
    var col = event.target instanceof Element ? event.target.closest('.kanban-col') : null;
    if (!col || !dragging) return;
    event.preventDefault();
    var form = dragging.querySelector('form.kanban-move');
    if (!form) return;
    var cards = col.querySelectorAll('.kanban-card');
    form.querySelector('input[name="column"]').value = col.getAttribute('data-column') || '';
    form.querySelector('input[name="position"]').value = String(cards.length);
    form.submit();
  });

  // data-confirm em link ou botão: pergunta no clique; cancelar impede a navegação ou o envio.
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    var copier = target.closest('[data-copy]');
    if (copier) {
      event.preventDefault();
      copy(copier);
      return;
    }

    var asker = target.closest('[data-confirm]');
    if (!asker || asker.tagName === 'FORM') return;
    if (!window.confirm(asker.getAttribute('data-confirm') || 'Confirmar?')) event.preventDefault();
  });

  // data-confirm no próprio formulário: pergunta no envio (cobre também o Enter no campo).
  document.addEventListener('submit', function (event) {
    var form = event.target instanceof Element ? event.target : null;
    if (!form || !form.hasAttribute('data-confirm')) return;
    if (!window.confirm(form.getAttribute('data-confirm') || 'Confirmar?')) event.preventDefault();
  });

  function textToCopy(el) {
    var spec = el.getAttribute('data-copy') || '';
    if (spec.charAt(0) !== '#') return spec;
    var source = document.getElementById(spec.slice(1));
    if (!source) return '';
    return 'value' in source && typeof source.value === 'string' ? source.value : source.textContent || '';
  }

  function copy(el) {
    var text = textToCopy(el);
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(el, true); }, function () { done(el, legacyCopy(text)); });
    } else {
      done(el, legacyCopy(text));
    }
  }

  // Sem a API de área de transferência (página em http ou navegador antigo).
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function done(el, ok) {
    if (el.hasAttribute('data-copy-busy')) return;
    var original = el.textContent;
    el.setAttribute('data-copy-busy', '');
    el.textContent = ok ? 'Copiado' : 'Não foi possível copiar';
    window.setTimeout(function () {
      el.textContent = original;
      el.removeAttribute('data-copy-busy');
    }, 1600);
  }
})();
`;
