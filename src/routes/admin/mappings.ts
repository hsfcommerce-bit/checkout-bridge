import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { computeDivergences } from '../../catalog/parity.ts';
import { isValidVariantId } from '../../lib/shop.ts';
import type {
  CatalogVariant,
  Divergence,
  DivergenceKind,
  Link,
  MappingStatus,
  MatchMethod,
  VariantMapping,
} from '../../types.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { audit, errorPage, readForm, redirectTo, setFlash, takeFlash } from './context.ts';
import { badge, csrfField, fmtMoney, page, pagination, icon } from './layout.ts';
import type { Markup } from './layout.ts';

/**
 * Casamento de produtos de uma rota (montado em /admin/links/:id/mappings): duas colunas
 * lado a lado, Vitrine e Checkout, com as linhas alinhadas por posição. A linha N da
 * vitrine está casada com a linha N do checkout; arrastar uma linha do checkout sobre
 * outra troca as duas de lugar e "Salvar" grava os pares que mudaram. Linhas com
 * divergência ficam destacadas e o valor divergente sublinhado.
 *
 * Toda decisão manual passa por repos.mappings.setManual com method 'manual' e fica
 * travada, para que o casamento automático não a desfaça; "voltar ao automático" destrava
 * a linha e recalcula o par. As divergências gravadas são sempre recalculadas a partir das
 * linhas ATUAIS do catálogo das duas lojas, com a menor tolerância entre as rotas do par
 * (a mesma do recálculo automático): o painel nunca copia divergências antigas. O destino
 * escolhido precisa existir no catálogo da loja checkout.
 *
 * A sessão e o token de CSRF já foram conferidos pelo middleware aplicado em index.ts.
 */

export const MAPPINGS_PAGE_SIZE = 50;
/** Variantes do checkout sem par mostradas no fim da última página. */
export const MAX_EXTRA_CHECKOUT_ROWS = 500;
/** Pares aceitos em um único "Salvar". */
export const MAX_PAIRS_PER_SAVE = 2000;
const SEARCH_LIMIT = 50;
const MAX_QUERY_CHARS = 200;

const STATUSES: readonly MappingStatus[] = ['active', 'suggested', 'conflict', 'unmapped', 'disabled'];

const STATUS_BADGE: Record<MappingStatus, { kind: 'ok' | 'warn' | 'error' | 'muted'; text: string }> = {
  active: { kind: 'ok', text: 'Ativo' },
  suggested: { kind: 'warn', text: 'Sugerido' },
  conflict: { kind: 'error', text: 'Conflito' },
  unmapped: { kind: 'muted', text: 'Sem destino' },
  disabled: { kind: 'muted', text: 'Desativado' },
};

const METHOD_LABEL: Record<MatchMethod, string> = {
  sku: 'SKU',
  barcode: 'Código de barras',
  handle_options: 'Handle + opções',
  title_options: 'Título + opções',
  manual: 'Manual',
};

const DIVERGENCE_LABEL: Record<DivergenceKind, string> = {
  price: 'Preço',
  compare_at_price: 'Preço comparativo',
  currency: 'Moeda',
  title: 'Título',
  options: 'Opções',
  availability: 'Disponibilidade',
  product_status: 'Status do produto',
};

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

export interface MappingFilters {
  status: MappingStatus | undefined;
  divergentOnly: boolean;
  search: string;
  page: number;
}

function isStatus(value: string): value is MappingStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function parseFilters(query: Record<string, string | undefined>): MappingFilters {
  const status = query['status'] ?? '';
  const rawPage = query['page'] ?? '';
  return {
    status: isStatus(status) ? status : undefined,
    divergentOnly: query['divergent'] === '1',
    search: (query['q'] ?? '').trim().slice(0, MAX_QUERY_CHARS),
    page: /^\d{1,6}$/.test(rawPage) && Number(rawPage) >= 1 ? Number(rawPage) : 1,
  };
}

/** URL da lista com os filtros; `page` fica de fora para a paginação acrescentá-lo. */
export function listUrl(linkId: string, filters: MappingFilters, withPage: boolean): string {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.divergentOnly) params.set('divergent', '1');
  if (filters.search !== '') params.set('q', filters.search);
  if (withPage && filters.page > 1) params.set('page', String(filters.page));
  const qs = params.toString();
  return `/admin/links/${linkId}/mappings${qs === '' ? '' : `?${qs}`}`;
}

/**
 * Pares "vitrine:checkout" enviados pelo botão Salvar (checkout vazio = sem destino).
 * Entradas malformadas são ignoradas, nunca viram decisão.
 */
export function parsePairs(raw: string): Array<{ vitrineVariantId: string; checkoutVariantId: string | null }> {
  const out: Array<{ vitrineVariantId: string; checkoutVariantId: string | null }> = [];
  const seen = new Set<string>();
  for (const item of raw.split(',').slice(0, MAX_PAIRS_PER_SAVE)) {
    const sep = item.indexOf(':');
    if (sep <= 0) continue;
    const vitrineVariantId = item.slice(0, sep).trim();
    const checkoutVariantId = item.slice(sep + 1).trim();
    if (!isValidVariantId(vitrineVariantId) || seen.has(vitrineVariantId)) continue;
    if (checkoutVariantId !== '' && !isValidVariantId(checkoutVariantId)) continue;
    seen.add(vitrineVariantId);
    out.push({ vitrineVariantId, checkoutVariantId: checkoutVariantId === '' ? null : checkoutVariantId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marcação
// ---------------------------------------------------------------------------

function sel(selected: boolean): string {
  return selected ? 'selected' : '';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function thumb(variant: CatalogVariant | undefined): Markup {
  if (variant?.imageUrl) return html`<img class="pair-thumb" src="${variant.imageUrl}" alt="" loading="lazy" width="40" height="40">`;
  return html`<span class="pair-thumb">${icon('box')}</span>`;
}

/** Texto da variante com os valores divergentes sublinhados; o motivo vai no title. */
function variantText(variant: CatalogVariant, diverging: ReadonlySet<DivergenceKind>): Markup {
  const mark = (kind: DivergenceKind, content: Markup): Markup =>
    diverging.has(kind) ? html`<span class="diverge" title="${DIVERGENCE_LABEL[kind] ?? kind}">${content}</span>` : content;
  return html`<div class="pair-text">
    <strong>${mark('title', html`${variant.productTitle}`)}</strong>
    <div class="pair-sub">${mark('options', html`${variant.variantTitle}`)}</div>
    <div class="pair-id">SKU ${variant.sku ?? '—'} · <span class="mono">${variant.variantId}</span></div>
  </div>`;
}

function priceCell(variant: CatalogVariant, other: CatalogVariant | undefined, diverging: ReadonlySet<DivergenceKind>): Markup {
  const priceDiverges = diverging.has('price') || diverging.has('currency');
  const own = fmtMoney(variant.price, variant.currency);
  return html`<div class="pair-price">${priceDiverges ? html`<span class="diverge" title="${diverging.has('currency') ? DIVERGENCE_LABEL.currency : DIVERGENCE_LABEL.price}">${own}</span>` : own}
    ${priceDiverges && other !== undefined ? html`<div class="pair-other">(${fmtMoney(other.price, other.currency)})</div>` : ''}</div>`;
}

function missingCell(id: string): Markup {
  return html`<div class="pair-text"><strong class="mono">${id}</strong><div class="pair-sub">não está no catálogo</div></div>`;
}

/** Preço e moeda impedem o checkout (política 'block'); por isso ganham o selo de erro. */
function divergenceBadges(divergences: Divergence[]): Markup {
  if (divergences.length === 0) return html`<span class="muted">—</span>`;
  return html`${divergences.map((d) => {
    const blocking = d.kind === 'price' || d.kind === 'currency';
    return html`<div>${badge(blocking ? 'error' : 'warn', DIVERGENCE_LABEL[d.kind] ?? d.kind)} <span class="muted">${d.vitrine} → ${d.checkout}</span></div>`;
  })}`;
}

interface RowContext {
  link: Link;
  csrf: Markup;
  returnTo: string;
  checkoutVariants: Map<string, CatalogVariant>;
}

function actionForm(ctx: RowContext, mapping: VariantMapping, action: string, label: string, extra: Markup | '', cls = 'btn-secondary'): Markup {
  return html`<form method="post" action="/admin/links/${ctx.link.id}/mappings/${action}">
    ${ctx.csrf}
    <input type="hidden" name="vitrineVariantId" value="${mapping.vitrineVariantId}">
    <input type="hidden" name="return" value="${ctx.returnTo}">
    ${extra}
    <button class="btn ${cls} btn-small" type="submit">${label}</button>
  </form>`;
}

function candidatesList(ctx: RowContext, mapping: VariantMapping): Markup {
  return html`<p class="muted">Candidatos:</p>
    ${mapping.candidates.map((id) => {
      const variant = ctx.checkoutVariants.get(id);
      return html`<div>${variant === undefined
          ? html`<span class="mono">${id}</span> <span class="muted">(não está no catálogo)</span>`
          : html`<strong>${variant.productTitle}</strong> ${variant.variantTitle} <span class="muted">SKU ${variant.sku ?? '—'} · ${fmtMoney(variant.price, variant.currency)} · <span class="mono">${id}</span></span>`}
        ${actionForm(ctx, mapping, 'choose', 'Escolher', html`<input type="hidden" name="checkoutVariantId" value="${id}">`)}</div>`;
    })}`;
}

function rowActions(ctx: RowContext, mapping: VariantMapping): Markup {
  const searchHref = `/admin/links/${ctx.link.id}/mappings/search?for=${encodeURIComponent(mapping.vitrineVariantId)}`;
  return html`<div class="actions">
    ${mapping.status === 'suggested' && mapping.checkoutVariantId !== null ? actionForm(ctx, mapping, 'approve', 'Aprovar', '', 'btn') : ''}
    ${actionForm(
      ctx,
      mapping,
      'manual',
      'Definir',
      html`<input type="text" name="checkoutVariantId" class="mono" inputmode="numeric" placeholder="ID da variante no checkout" aria-label="ID da variante no checkout" autocomplete="off">`,
    )}
    <a class="btn btn-link btn-small" href="${searchHref}">Buscar no checkout</a>
    ${mapping.status === 'disabled' ? '' : actionForm(ctx, mapping, 'disable', 'Desativar', '')}
    ${mapping.locked ? actionForm(ctx, mapping, 'reset', 'Voltar ao automático', '') : ''}
  </div>`;
}

/** Menu "⋯" da linha: status, método, divergências e as decisões manuais. */
function rowMenu(ctx: RowContext, mapping: VariantMapping): Markup {
  const status = STATUS_BADGE[mapping.status] ?? { kind: 'muted', text: mapping.status };
  return html`<details class="pair-menu">
    <summary class="icon-button" aria-label="Ações da linha">${icon('dots')}</summary>
    <div class="pair-menu-body">
      <div class="pair-menu-row">${badge(status.kind, status.text)}${mapping.locked ? html` ${badge('muted', 'Travado')}` : ''}
        <span class="muted">· ${mapping.method === null ? '—' : METHOD_LABEL[mapping.method]}</span></div>
      <div class="pair-menu-row">${divergenceBadges(mapping.divergences)}</div>
      ${mapping.status === 'conflict' && mapping.candidates.length > 0 ? candidatesList(ctx, mapping) : ''}
      ${rowActions(ctx, mapping)}
    </div>
  </details>`;
}

/** Uma linha de cada coluna: vitrine e o destino atual dela (ou um placeholder). */
export interface PairRow {
  index: number;
  mapping: VariantMapping | null;
  vitrine: CatalogVariant | undefined;
  checkout: CatalogVariant | undefined;
  checkoutId: string | null;
}

function emptyRow(index: number, side: 'vitrine' | 'checkout'): Markup {
  return side === 'vitrine'
    ? html`<li class="pair-row pair-empty"><span class="pair-idx">${pad(index)}</span><span>Sem variante</span></li>`
    : html`<li class="pair-row pair-empty" draggable="true" data-checkout=""><span class="pair-grip" title="Arraste para trocar de lugar">${icon('grip')}</span><span class="pair-idx">${pad(index)}</span><span>Sem variante</span></li>`;
}

export function vitrineRow(ctx: RowContext, row: PairRow): Markup {
  const { mapping } = row;
  if (mapping === null) return emptyRow(row.index, 'vitrine');
  const diverging = new Set<DivergenceKind>(mapping.divergences.map((d) => d.kind));
  const cls = `pair-row${diverging.size > 0 ? ' is-diverge' : ''}`;
  return html`<li class="${cls}" data-vitrine="${mapping.vitrineVariantId}" data-original="${mapping.checkoutVariantId ?? ''}">
    <span class="pair-idx">${pad(row.index)}</span>
    ${thumb(row.vitrine)}
    ${row.vitrine === undefined ? missingCell(mapping.vitrineVariantId) : variantText(row.vitrine, diverging)}
    ${row.vitrine === undefined ? '' : priceCell(row.vitrine, row.checkout, diverging)}
    ${rowMenu(ctx, mapping)}
  </li>`;
}

export function checkoutRow(row: PairRow): Markup {
  if (row.checkoutId === null) return emptyRow(row.index, 'checkout');
  const diverging = new Set<DivergenceKind>((row.mapping?.divergences ?? []).map((d) => d.kind));
  const cls = `pair-row${diverging.size > 0 ? ' is-diverge' : ''}`;
  return html`<li class="${cls}" draggable="true" data-checkout="${row.checkoutId}">
    <span class="pair-grip" title="Arraste para trocar de lugar">${icon('grip')}</span>
    <span class="pair-idx">${pad(row.index)}</span>
    ${thumb(row.checkout)}
    ${row.checkout === undefined ? missingCell(row.checkoutId) : variantText(row.checkout, diverging)}
    ${row.checkout === undefined ? '' : priceCell(row.checkout, row.vitrine, diverging)}
  </li>`;
}

function filtersForm(linkId: string, filters: MappingFilters): Markup {
  return html`<form class="filters pair-filters" method="get" action="/admin/links/${linkId}/mappings">
    <label class="field"><span>Status</span>
      <select name="status">
        <option value="" ${sel(filters.status === undefined)}>Todos</option>
        ${STATUSES.map((s) => html`<option value="${s}" ${sel(filters.status === s)}>${STATUS_BADGE[s].text}</option>`)}
      </select>
    </label>
    <label class="field"><span>Buscar na vitrine</span>
      <input type="search" name="q" value="${filters.search}" placeholder="Produto, variante ou SKU" maxlength="${MAX_QUERY_CHARS}">
    </label>
    <label class="field"><span><input type="checkbox" name="divergent" value="1" ${filters.divergentOnly ? 'checked' : ''}> Só divergentes</span></label>
    <button class="btn btn-secondary" type="submit">Filtrar</button>
    <a class="btn btn-link" href="/admin/links/${linkId}/mappings">Limpar</a>
  </form>`;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

/** Falha de uma ação de linha: a mensagem vai como flash e a lista é exibida de novo. */
type ActionResult = { ok: true; text: string } | { ok: false; text: string };

export function createMappingRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const { repos } = deps;

  function notFound(c: Context<AdminEnv>): Response | Promise<Response> {
    return errorPage(c, 404, 'Rota não encontrada', 'Essa rota não existe ou já foi removida.', c.get('session'));
  }

  /** O :id vem do caminho em que links.ts monta este sub-app; aqui ele não é declarado. */
  function linkIdOf(c: Context<AdminEnv>): string {
    return c.req.param('id') ?? '';
  }

  function storeName(id: string): string {
    return repos.stores.get(id)?.name ?? id;
  }

  function title(link: Link): string {
    return `Mapeamentos: ${storeName(link.vitrineStoreId)} → ${storeName(link.checkoutStoreId)}`;
  }

  /**
   * Variantes do checkout que nenhum mapeamento do par referencia. Só entram no fim da
   * última página sem filtros, para que o usuário as veja e possa arrastá-las para um par.
   */
  function extraCheckoutVariants(link: Link): { rows: CatalogVariant[]; more: number } {
    const referenced = new Set<string>();
    for (const m of repos.mappings.listAll(link.vitrineStoreId, link.checkoutStoreId)) {
      if (m.checkoutVariantId !== null) referenced.add(m.checkoutVariantId);
      for (const id of m.candidates) referenced.add(id);
    }
    const all = repos.catalog.listAll(link.checkoutStoreId).filter((v) => !referenced.has(v.variantId));
    return { rows: all.slice(0, MAX_EXTRA_CHECKOUT_ROWS), more: Math.max(0, all.length - MAX_EXTRA_CHECKOUT_ROWS) };
  }

  app.get('/', (c) => {
    const link = repos.links.get(linkIdOf(c));
    if (link === null) return notFound(c);
    const filters = parseFilters(c.req.query());
    const { rows, total } = repos.mappings.list(link.vitrineStoreId, link.checkoutStoreId, {
      status: filters.status,
      divergentOnly: filters.divergentOnly,
      search: filters.search === '' ? undefined : filters.search,
      limit: MAPPINGS_PAGE_SIZE,
      offset: (filters.page - 1) * MAPPINGS_PAGE_SIZE,
    });
    const vitrineVariants = repos.catalog.getVariants(link.vitrineStoreId, rows.map((m) => m.vitrineVariantId));
    const checkoutIds = rows.flatMap((m) => [...(m.checkoutVariantId === null ? [] : [m.checkoutVariantId]), ...m.candidates]);
    const ctx: RowContext = {
      link,
      csrf: csrfField(c.get('session')),
      returnTo: listUrl(link.id, filters, true),
      checkoutVariants: repos.catalog.getVariants(link.checkoutStoreId, checkoutIds),
    };
    const unfiltered = filters.status === undefined && !filters.divergentOnly && filters.search === '';
    const lastPage = filters.page * MAPPINGS_PAGE_SIZE >= total;
    const extras = unfiltered && lastPage ? extraCheckoutVariants(link) : { rows: [], more: 0 };
    const pairs: PairRow[] = [
      ...rows.map((m, i): PairRow => ({
        index: i + 1,
        mapping: m,
        vitrine: vitrineVariants.get(m.vitrineVariantId),
        checkout: m.checkoutVariantId === null ? undefined : ctx.checkoutVariants.get(m.checkoutVariantId),
        checkoutId: m.checkoutVariantId,
      })),
      ...extras.rows.map((v, i): PairRow => ({ index: rows.length + i + 1, mapping: null, vitrine: undefined, checkout: v, checkoutId: v.variantId })),
    ];
    const counts = repos.mappings.counts(link.vitrineStoreId, link.checkoutStoreId);
    const vitrineCount = repos.catalog.count(link.vitrineStoreId);
    const checkoutCount = repos.catalog.count(link.checkoutStoreId);
    const pairsValue = pairs.filter((p) => p.mapping !== null).map((p) => `${p.mapping?.vitrineVariantId}:${p.checkoutId ?? ''}`).join(',');
    const tabBase: MappingFilters = { ...filters, page: 1 };
    const body = html`<div class="op-bar">
        <a class="icon-button" href="/admin/operations/${link.vitrineStoreId}" aria-label="Voltar">←</a>
        <strong class="op-name">${storeName(link.vitrineStoreId)} <span class="muted">→</span> ${storeName(link.checkoutStoreId)}</strong>
        <span class="op-actions">
          <a class="btn btn-secondary" href="/admin/links/${link.id}/mappings/export.csv">${icon('box')}<span>CSV</span></a>
          <form method="post" action="/admin/links/${link.id}/mappings/sync" class="inline-form">${ctx.csrf}<button class="btn btn-secondary" type="submit" title="Relê o catálogo das duas lojas na Shopify e recalcula os pares">${icon('refresh')}<span>Atualizar</span></button></form>
          <form method="post" action="/admin/links/${link.id}/rematch" class="inline-form">${ctx.csrf}<input type="hidden" name="return" value="${ctx.returnTo}"><button class="btn btn-secondary" type="submit" title="Casa automaticamente por SKU, código de barras, handle e título">${icon('bolt')}<span>Auto-Mapear</span></button></form>
          ${deps.themeInstaller === undefined ? '' : html`<form method="post" action="/admin/stores/${link.vitrineStoreId}/install-theme" class="inline-form">${ctx.csrf}<input type="hidden" name="return" value="${ctx.returnTo}"><button class="btn btn-secondary" type="submit" data-confirm="Gravar o script de redirecionamento no theme.liquid do tema publicado da vitrine?">${icon('swap')}<span>Push Shopify</span></button></form>`}
          <button class="btn" type="submit" form="pair-form" id="pair-save" data-label="Salvar (${total})">Salvar (${total})</button>
        </span>
      </div>
      <form id="pair-form" method="post" action="/admin/links/${link.id}/mappings/save" class="inline-form">
        ${ctx.csrf}
        <input type="hidden" name="return" value="${ctx.returnTo}">
        <input type="hidden" name="pairs" id="pairs-input" value="${pairsValue}">
      </form>
      <div class="seg pair-tabs">
        <a href="${listUrl(link.id, { ...tabBase, divergentOnly: false }, false)}" aria-current="${filters.divergentOnly ? 'false' : 'true'}">Mapeamento</a>
        <a href="${listUrl(link.id, { ...tabBase, divergentOnly: true }, false)}" aria-current="${filters.divergentOnly ? 'true' : 'false'}">Divergências${counts.divergent > 0 ? html` <span class="count-pill">${counts.divergent}</span>` : ''}</a>
      </div>
      ${filtersForm(link.id, filters)}
      ${rows.length === 0
        ? html`<section class="card"><p class="empty">Nenhum mapeamento com esses filtros.</p></section>`
        : html`<div class="pair-grid">
            <section class="card pair-col">
              <div class="pair-head"><span class="pair-dot"></span> Vitrine <span class="pill"><strong>${vitrineCount}</strong> variantes</span>
                ${counts.divergent > 0
                  ? html`<a class="chip chip-error" href="${listUrl(link.id, { ...filters, divergentOnly: true, page: 1 }, false)}">⚠ ${counts.divergent} com divergência</a>`
                  : badge('ok', 'Todos os produtos OK')}</div>
              <input class="pair-filter" type="search" placeholder="Buscar produtos nesta página…" aria-label="Filtrar linhas desta página" data-pair-filter="1">
              <ol class="pair-list" id="list-vitrine">${pairs.map((p) => vitrineRow(ctx, p))}</ol>
            </section>
            <section class="card pair-col">
              <div class="pair-head"><span class="pair-dot checkout"></span> Checkout <span class="pill"><strong>${checkoutCount}</strong> variantes</span>
                <span class="muted pair-hint">Arraste uma linha sobre outra para trocar o par</span></div>
              <input class="pair-filter" type="search" placeholder="Buscar produtos nesta página…" aria-label="Filtrar linhas desta página" data-pair-filter="1">
              <ol class="pair-list" id="list-checkout">${pairs.map((p) => checkoutRow(p))}</ol>
              ${extras.more > 0 ? html`<p class="muted pair-extra">E mais ${extras.more} variantes do checkout sem par. Use a busca em "Buscar no checkout" para encontrá-las.</p>` : ''}
            </section>
          </div>`}
      ${pagination({ page: filters.page, pageSize: MAPPINGS_PAGE_SIZE, total, baseUrl: listUrl(link.id, filters, false) })}`;
    return c.html(page({ title: title(link), active: 'links', session: c.get('session'), flash: takeFlash(c), body }));
  });

  // Exportação simples (sem dados pessoais): uma linha por mapeamento do par.
  app.get('/export.csv', (c) => {
    const link = repos.links.get(linkIdOf(c));
    if (link === null) return notFound(c);
    const rows = repos.mappings.listAll(link.vitrineStoreId, link.checkoutStoreId);
    const vit = repos.catalog.getVariants(link.vitrineStoreId, rows.map((m) => m.vitrineVariantId));
    const chk = repos.catalog.getVariants(link.checkoutStoreId, rows.flatMap((m) => (m.checkoutVariantId === null ? [] : [m.checkoutVariantId])));
    const cell = (v: unknown): string => {
      const text = v === null || v === undefined ? '' : String(v);
      // Fórmulas (=, +, -, @) ficam neutralizadas para planilhas não as executarem.
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ['vitrine_variant_id', 'vitrine_produto', 'vitrine_variante', 'vitrine_sku', 'vitrine_preco', 'checkout_variant_id', 'checkout_produto', 'checkout_variante', 'checkout_sku', 'checkout_preco', 'status', 'metodo', 'divergencias'];
    const lines = rows.map((m) => {
      const a = vit.get(m.vitrineVariantId);
      const b = m.checkoutVariantId === null ? undefined : chk.get(m.checkoutVariantId);
      return [m.vitrineVariantId, a?.productTitle, a?.variantTitle, a?.sku, a?.price, m.checkoutVariantId, b?.productTitle, b?.variantTitle, b?.sku, b?.price, m.status, m.method, m.divergences.map((d) => d.kind).join('|')].map(cell).join(',');
    });
    return c.body(`﻿${[header.join(','), ...lines].join('\r\n')}`, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mapeamentos-${link.id}.csv"`,
    });
  });

  app.post('/sync', async (c) => {
    const link = repos.links.get(linkIdOf(c));
    if (link === null) return notFound(c);
    const results = await Promise.all([deps.sync.syncStore(link.vitrineStoreId), deps.sync.syncStore(link.checkoutStoreId)]);
    let summary: string;
    try {
      const counts = deps.matcher.rematchPair(link.vitrineStoreId, link.checkoutStoreId).counts;
      summary = `${counts.active} mapeados, ${counts.suggested + counts.conflict} para revisar, ${counts.unmapped} sem par`;
    } catch (err) {
      summary = `recálculo falhou: ${err instanceof Error ? err.message : 'erro'}`;
    }
    audit(deps, 'mapping.sync', 'link', link.id, { ok: results.every((r) => r.ok) });
    setFlash(c, {
      kind: results.every((r) => r.ok) ? 'ok' : 'error',
      text: results.every((r) => r.ok) ? `Catálogos atualizados (${results[0]?.variants ?? 0} + ${results[1]?.variants ?? 0} variantes). ${summary}.` : `Falha ao sincronizar: ${results.map((r) => r.detail ?? '').filter(Boolean).join('; ')}`,
    });
    return redirectTo(c, `/admin/links/${link.id}/mappings`);
  });

  app.get('/search', (c) => {
    const link = repos.links.get(linkIdOf(c));
    if (link === null) return notFound(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_CHARS);
    const forId = c.req.query('for') ?? '';
    const target = isValidVariantId(forId) ? forId : null;
    const results = q === '' ? [] : repos.catalog.search(link.checkoutStoreId, { query: q, limit: SEARCH_LIMIT, offset: 0 });
    const csrf = csrfField(c.get('session'));
    const useForm = (variant: CatalogVariant): Markup | '' =>
      target === null
        ? ''
        : html`<form method="post" action="/admin/links/${link.id}/mappings/manual">
            ${csrf}
            <input type="hidden" name="vitrineVariantId" value="${target}">
            <input type="hidden" name="checkoutVariantId" value="${variant.variantId}">
            <button class="btn btn-small" type="submit">Usar esta</button>
          </form>`;
    const body = html`<p><a href="/admin/links/${link.id}/mappings">← Voltar aos mapeamentos</a></p>
      ${target === null ? '' : html`<p>Escolhendo o destino da variante <span class="mono">${target}</span> da vitrine.</p>`}
      <form class="filters" method="get" action="/admin/links/${link.id}/mappings/search">
        ${target === null ? '' : html`<input type="hidden" name="for" value="${target}">`}
        <label class="field"><span>Buscar no catálogo do checkout</span>
          <input type="search" name="q" value="${q}" placeholder="Produto, variante, SKU ou código de barras" maxlength="${MAX_QUERY_CHARS}" autofocus>
        </label>
        <button class="btn btn-secondary" type="submit">Buscar</button>
      </form>
      <section class="card">
        ${q === ''
          ? html`<p class="empty">Digite um termo para buscar.</p>`
          : results.length === 0
            ? html`<p class="empty">Nenhuma variante encontrada no catálogo do checkout.</p>`
            : html`<div class="table-wrap"><table>
                <thead><tr><th></th><th>Produto</th><th>Variante</th><th>SKU</th><th>Preço</th><th>ID</th><th></th></tr></thead>
                <tbody>${results.map(
                  (v) => html`<tr>
                    <td>${thumb(v)}</td><td>${v.productTitle}</td><td>${v.variantTitle}</td><td>${v.sku ?? '—'}</td>
                    <td class="nowrap">${fmtMoney(v.price, v.currency)}</td><td class="mono">${v.variantId}</td><td>${useForm(v)}</td>
                  </tr>`,
                )}</tbody>
              </table></div>
              ${results.length >= SEARCH_LIMIT ? html`<p class="muted">Mostrando os primeiros ${SEARCH_LIMIT} resultados; refine a busca.</p>` : ''}`}
      </section>`;
    return c.html(page({ title: 'Buscar variante no checkout', active: 'links', session: c.get('session'), flash: takeFlash(c), body }));
  });

  /**
   * Mesma tolerância que o recálculo automático usa (src/catalog/match.ts): a menor entre
   * todas as rotas do par, ativas ou não. As divergências são gravadas por par, não por
   * rota; com a tolerância só da rota aberta no painel a marca "Preço" apareceria e
   * sumiria entre a decisão manual e o próximo recálculo, sem mudança no catálogo.
   */
  function pairTolerance(link: Link): number {
    let smallest: number | null = null;
    for (const other of repos.links.list({ vitrineStoreId: link.vitrineStoreId, checkoutStoreId: link.checkoutStoreId })) {
      const bps = Number.isFinite(other.priceToleranceBps) && other.priceToleranceBps > 0 ? other.priceToleranceBps : 0;
      smallest = smallest === null ? bps : Math.min(smallest, bps);
    }
    return smallest ?? 0;
  }

  /** Divergências atuais entre a variante da vitrine e o destino, com a tolerância do par. */
  function currentDivergences(link: Link, vitrine: CatalogVariant, checkoutVariantId: string | null): Divergence[] {
    if (checkoutVariantId === null) return [];
    const checkout = repos.catalog.getVariant(link.checkoutStoreId, checkoutVariantId);
    if (checkout === null) return [];
    return computeDivergences(vitrine, checkout, { priceToleranceBps: pairTolerance(link) });
  }

  function writeManual(link: Link, vitrine: CatalogVariant, current: VariantMapping | null, checkoutVariantId: string | null, status: MappingStatus): void {
    repos.mappings.setManual({
      vitrineStoreId: link.vitrineStoreId,
      checkoutStoreId: link.checkoutStoreId,
      vitrineVariantId: vitrine.variantId,
      checkoutVariantId,
      status,
      method: 'manual',
      candidates: current?.candidates ?? [],
      divergences: currentDivergences(link, vitrine, checkoutVariantId),
      locked: true,
      updatedAt: (deps.clock?.now() ?? new Date()).toISOString(),
    });
  }

  /** Confere que o destino informado existe no catálogo da loja checkout. */
  function checkoutExists(link: Link, checkoutVariantId: string): boolean {
    return isValidVariantId(checkoutVariantId) && repos.catalog.getVariant(link.checkoutStoreId, checkoutVariantId) !== null;
  }

  /**
   * "Salvar" da tela lado a lado: grava só os pares que mudaram em relação ao banco. Par com
   * destino vira ativo e travado; par esvaziado vira "sem destino" travado (senão o
   * casamento automático o refaria em seguida). Destinos que não existem no catálogo do
   * checkout são ignorados e contados na mensagem.
   */
  app.post('/save', async (c) => {
    const link = repos.links.get(linkIdOf(c));
    if (link === null) return notFound(c);
    const form = await readForm(c);
    const returnTo = form['return'] ?? `/admin/links/${link.id}/mappings`;
    let changed = 0;
    let ignored = 0;
    for (const pair of parsePairs(form['pairs'] ?? '')) {
      const vitrine = repos.catalog.getVariant(link.vitrineStoreId, pair.vitrineVariantId);
      if (vitrine === null) {
        ignored += 1;
        continue;
      }
      const current = repos.mappings.get(link.vitrineStoreId, link.checkoutStoreId, pair.vitrineVariantId);
      const currentId = current?.checkoutVariantId ?? null;
      if (pair.checkoutVariantId === null) {
        if (currentId === null) continue;
        writeManual(link, vitrine, current, null, 'unmapped');
      } else {
        if (currentId === pair.checkoutVariantId && current?.status === 'active') continue;
        if (!checkoutExists(link, pair.checkoutVariantId)) {
          ignored += 1;
          continue;
        }
        writeManual(link, vitrine, current, pair.checkoutVariantId, 'active');
      }
      changed += 1;
    }
    audit(deps, 'mapping.save', 'link', link.id, { vitrineStoreId: link.vitrineStoreId, checkoutStoreId: link.checkoutStoreId, changed, ignored });
    const suffix = ignored > 0 ? ` ${ignored} par${ignored === 1 ? '' : 'es'} ignorado${ignored === 1 ? '' : 's'} (variante fora do catálogo).` : '';
    setFlash(c, {
      kind: ignored > 0 && changed === 0 ? 'error' : 'ok',
      text: changed === 0 ? `Nada a salvar: nenhum par mudou.${suffix}` : `Mapeamento salvo: ${changed} par${changed === 1 ? '' : 'es'} atualizado${changed === 1 ? '' : 's'}.${suffix}`,
    });
    return redirectTo(c, returnTo);
  });

  type Action = (link: Link, vitrine: CatalogVariant, current: VariantMapping | null, form: Record<string, string>) => ActionResult;

  const actions: Record<string, Action> = {
    approve(link, vitrine, current) {
      if (current === null || current.checkoutVariantId === null) return { ok: false, text: 'Essa linha não tem sugestão para aprovar.' };
      if (!checkoutExists(link, current.checkoutVariantId)) return { ok: false, text: 'A variante sugerida não está mais no catálogo do checkout.' };
      writeManual(link, vitrine, current, current.checkoutVariantId, 'active');
      return { ok: true, text: 'Sugestão aprovada: mapeamento ativo e travado.' };
    },
    choose(link, vitrine, current, form) {
      const chosen = form['checkoutVariantId'] ?? '';
      if (current === null || !current.candidates.includes(chosen)) return { ok: false, text: 'Escolha um dos candidatos listados para a linha.' };
      if (!checkoutExists(link, chosen)) return { ok: false, text: 'O candidato escolhido não está mais no catálogo do checkout.' };
      writeManual(link, vitrine, current, chosen, 'active');
      return { ok: true, text: 'Candidato escolhido: mapeamento ativo e travado.' };
    },
    manual(link, vitrine, current, form) {
      const chosen = (form['checkoutVariantId'] ?? '').trim();
      if (!isValidVariantId(chosen)) return { ok: false, text: 'Informe o ID numérico da variante no checkout.' };
      if (!checkoutExists(link, chosen)) return { ok: false, text: `A variante ${chosen} não existe no catálogo do checkout. Sincronize a loja ou confira o ID.` };
      writeManual(link, vitrine, current, chosen, 'active');
      return { ok: true, text: `Destino definido manualmente: variante ${chosen}.` };
    },
    disable(link, vitrine, current) {
      writeManual(link, vitrine, current, current?.checkoutVariantId ?? null, 'disabled');
      return { ok: true, text: 'Mapeamento desativado.' };
    },
    reset(link, vitrine, current) {
      if (current === null) return { ok: false, text: 'Essa linha ainda não tem mapeamento.' };
      repos.mappings.unlock(link.vitrineStoreId, link.checkoutStoreId, vitrine.variantId);
      deps.matcher.rematchPair(link.vitrineStoreId, link.checkoutStoreId);
      return { ok: true, text: 'Linha devolvida ao casamento automático e par recalculado.' };
    },
  };

  for (const [name, action] of Object.entries(actions)) {
    app.post(`/${name}`, async (c) => {
      const link = repos.links.get(linkIdOf(c));
      if (link === null) return notFound(c);
      const form = await readForm(c);
      const returnTo = form['return'] ?? `/admin/links/${link.id}/mappings`;
      const vitrineVariantId = (form['vitrineVariantId'] ?? '').trim();
      const vitrine = isValidVariantId(vitrineVariantId) ? repos.catalog.getVariant(link.vitrineStoreId, vitrineVariantId) : null;
      if (vitrine === null) {
        setFlash(c, { kind: 'error', text: 'A variante da vitrine não está no catálogo sincronizado; sincronize a loja antes de decidir por ela.' });
        return redirectTo(c, returnTo);
      }
      const current = repos.mappings.get(link.vitrineStoreId, link.checkoutStoreId, vitrineVariantId);
      const result = action(link, vitrine, current, form);
      if (result.ok) {
        const after = repos.mappings.get(link.vitrineStoreId, link.checkoutStoreId, vitrineVariantId);
        audit(deps, `mapping.${name}`, 'mapping', vitrineVariantId, {
          linkId: link.id,
          vitrineStoreId: link.vitrineStoreId,
          checkoutStoreId: link.checkoutStoreId,
          checkoutVariantId: after?.checkoutVariantId ?? null,
          status: after?.status ?? null,
        });
      }
      setFlash(c, { kind: result.ok ? 'ok' : 'error', text: result.text });
      return redirectTo(c, returnTo);
    });
  }

  return app;
}
