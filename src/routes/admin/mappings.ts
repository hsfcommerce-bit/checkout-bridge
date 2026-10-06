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
 * Mapeamentos de uma rota (montado em /admin/links/:id/mappings): lista paginada com
 * filtros e as decisões manuais linha a linha.
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

// ---------------------------------------------------------------------------
// Marcação
// ---------------------------------------------------------------------------

function sel(selected: boolean): string {
  return selected ? 'selected' : '';
}

function variantCell(variant: CatalogVariant | undefined, fallbackId: string | null, diverging: ReadonlySet<DivergenceKind> = new Set()): Markup {
  if (variant === undefined) {
    if (fallbackId === null) return html`<span class="muted">—</span>`;
    return html`<span class="mono">${fallbackId}</span> <span class="muted">(não está no catálogo)</span>`;
  }
  // Valor divergente entre vitrine e checkout fica sublinhado em vermelho, com o motivo no title.
  const mark = (kind: DivergenceKind, content: Markup): Markup =>
    diverging.has(kind) ? html`<span class="diverge" title="${DIVERGENCE_LABEL[kind] ?? kind}">${content}</span>` : content;
  return html`<div><strong>${mark('title', html`${variant.productTitle}`)}</strong></div>
    <div>${mark('options', html`${variant.variantTitle}`)}</div>
    <div class="muted">SKU ${variant.sku ?? '—'} · <span class="mono">${variant.variantId}</span></div>
    <div class="nowrap">${mark(diverging.has('currency') ? 'currency' : 'price', html`${fmtMoney(variant.price, variant.currency)}`)}</div>`;
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

export function mappingRow(ctx: RowContext, mapping: VariantMapping, vitrineVariant: CatalogVariant | undefined): Markup {
  const status = STATUS_BADGE[mapping.status] ?? { kind: 'muted', text: mapping.status };
  const checkoutVariant = mapping.checkoutVariantId === null ? undefined : ctx.checkoutVariants.get(mapping.checkoutVariantId);
  const divergingKinds = new Set<DivergenceKind>(mapping.divergences.map((d) => d.kind));
  return html`<tr>
    <td>${variantCell(vitrineVariant, mapping.vitrineVariantId, divergingKinds)}</td>
    <td>${variantCell(checkoutVariant, mapping.checkoutVariantId, divergingKinds)}
      ${mapping.status === 'conflict' && mapping.candidates.length > 0 ? candidatesList(ctx, mapping) : ''}</td>
    <td>${mapping.method === null ? html`<span class="muted">—</span>` : METHOD_LABEL[mapping.method]}</td>
    <td>${badge(status.kind, status.text)}${mapping.locked ? html` ${badge('muted', 'Travado')}` : ''}</td>
    <td>${divergenceBadges(mapping.divergences)}</td>
    <td>${rowActions(ctx, mapping)}</td>
  </tr>`;
}

function filtersForm(linkId: string, filters: MappingFilters): Markup {
  return html`<form class="filters" method="get" action="/admin/links/${linkId}/mappings">
    <label class="field"><span>Status</span>
      <select name="status">
        <option value="" ${sel(filters.status === undefined)}>Todos</option>
        ${STATUSES.map((s) => html`<option value="${s}" ${sel(filters.status === s)}>${STATUS_BADGE[s].text}</option>`)}
      </select>
    </label>
    <label class="field"><span>Buscar</span>
      <input type="search" name="q" value="${filters.search}" placeholder="Produto, variante ou SKU da vitrine" maxlength="${MAX_QUERY_CHARS}">
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
    const counts = repos.mappings.counts(link.vitrineStoreId, link.checkoutStoreId);
    const vitrineCount = repos.catalog.count(link.vitrineStoreId);
    const checkoutCount = repos.catalog.count(link.checkoutStoreId);
    const body = html`<div class="op-bar">
        <a class="icon-button" href="/admin/operations/${link.vitrineStoreId}" aria-label="Voltar">←</a>
        <strong class="op-name">${storeName(link.vitrineStoreId)} <span class="muted">→</span> ${storeName(link.checkoutStoreId)}</strong>
        <span class="pill">Vitrine <strong>${vitrineCount}</strong> variantes</span>
        <span class="pill">Checkout <strong>${checkoutCount}</strong> variantes</span>
        ${counts.divergent > 0 ? html`<a class="chip chip-error" href="${listUrl(link.id, { ...filters, divergentOnly: true, page: 1 }, false)}">⚠ ${counts.divergent} com divergência</a>` : badge('ok', 'Sem divergências')}
        <span class="op-actions">
          <a class="btn btn-secondary" href="/admin/links/${link.id}/mappings/export.csv">${icon('box')}<span>CSV</span></a>
          <form method="post" action="/admin/links/${link.id}/mappings/sync" class="inline-form">${ctx.csrf}<button class="btn btn-secondary" type="submit">${icon('refresh')}<span>Atualizar</span></button></form>
          <form method="post" action="/admin/links/${link.id}/rematch" class="inline-form">${ctx.csrf}<input type="hidden" name="return" value="${ctx.returnTo}"><button class="btn" type="submit">${icon('swap')}<span>Mapear por SKU</span></button></form>
        </span>
      </div>
      ${filtersForm(link.id, filters)}
      <section class="card">
        ${rows.length === 0
          ? html`<p class="empty">Nenhum mapeamento com esses filtros.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Vitrine</th><th>Checkout</th><th>Método</th><th>Status</th><th>Divergências</th><th>Ações</th></tr></thead>
              <tbody>${rows.map((m) => mappingRow(ctx, m, vitrineVariants.get(m.vitrineVariantId)))}</tbody>
            </table></div>`}
        ${pagination({ page: filters.page, pageSize: MAPPINGS_PAGE_SIZE, total, baseUrl: listUrl(link.id, filters, false) })}
      </section>`;
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
    return c.body(`\uFEFF${[header.join(','), ...lines].join('\r\n')}`, 200, {
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
                <thead><tr><th>Produto</th><th>Variante</th><th>SKU</th><th>Preço</th><th>ID</th><th></th></tr></thead>
                <tbody>${results.map(
                  (v) => html`<tr>
                    <td>${v.productTitle}</td><td>${v.variantTitle}</td><td>${v.sku ?? '—'}</td>
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
