import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { isBridgeError } from '../../types.ts';
import type {
  Link,
  LinkKind,
  LinkPatch,
  LinkTestResult,
  MappingCounts,
  NewLink,
  ParityPolicy,
  SessionStrategy,
  Store,
} from '../../types.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { audit, errorPage, readForm, redirectTo, setFlash, takeFlash } from './context.ts';
import { badge, csrfField, page, progressBar } from './layout.ts';
import type { Markup } from './layout.ts';
import { createMappingRoutes } from './mappings.ts';

/**
 * Seção "Rotas" do painel: as ligações vitrine -> checkout.
 *
 * Cada rota aponta para exatamente UMA loja checkout, escolhida aqui pelo lojista: a rota
 * default da vitrine ou uma rota para países específicos. Não existe, por decisão de
 * projeto (ver src/types.ts), nenhum controle que escolha ou troque o destino sozinho por
 * volume, horário, cota ou falha; a unicidade (uma default ativa, cada país em uma só rota
 * ativa) é garantida pelo repositório e os conflitos aparecem como mensagem no formulário.
 *
 * A sessão e o token de CSRF já foram conferidos pelo middleware aplicado em index.ts.
 */

const KINDS: readonly LinkKind[] = ['default', 'country'];
const STRATEGIES: readonly SessionStrategy[] = ['storefront_cart', 'permalink'];
const POLICIES: readonly ParityPolicy[] = ['block', 'warn', 'off'];

/** Limite do painel para linhas por carrinho; o repositório aceita até 250. */
const MAX_LINES_LIMIT = 100;

export const STRATEGY_LABEL: Record<SessionStrategy, string> = {
  storefront_cart: 'Carrinho pela API (recomendado)',
  permalink: 'Link direto de carrinho',
};

export const POLICY_LABEL: Record<ParityPolicy, string> = {
  block: 'Bloquear o checkout quando o preço divergir',
  warn: 'Só avisar (registrar a divergência e seguir)',
  off: 'Não conferir preço',
};

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

export interface LinkFormValues {
  vitrineStoreId: string;
  checkoutStoreId: string;
  kind: string;
  countries: string;
  strategy: string;
  parityPolicy: string;
  tolerancePercent: string;
  maxQuantityPerLine: string;
  maxLines: string;
  allowPermalinkFallback: boolean;
  enabled: boolean;
}

type FormResult<T> = { ok: true; value: T } | { ok: false; message: string };

function text(form: Record<string, string>, field: string): string {
  return (form[field] ?? '').trim();
}

/** Caixa de seleção: o navegador só envia o campo quando está marcada. */
function checked(form: Record<string, string>, field: string): boolean {
  return form[field] !== undefined && form[field] !== '';
}

export function formValuesFrom(form: Record<string, string>): LinkFormValues {
  return {
    vitrineStoreId: text(form, 'vitrineStoreId'),
    checkoutStoreId: text(form, 'checkoutStoreId'),
    kind: text(form, 'kind'),
    countries: text(form, 'countries'),
    strategy: text(form, 'strategy'),
    parityPolicy: text(form, 'parityPolicy'),
    tolerancePercent: text(form, 'tolerancePercent'),
    maxQuantityPerLine: text(form, 'maxQuantityPerLine'),
    maxLines: text(form, 'maxLines'),
    allowPermalinkFallback: checked(form, 'allowPermalinkFallback'),
    enabled: checked(form, 'enabled'),
  };
}

/** Pontos-base como porcentagem com até duas casas, no formato brasileiro (vírgula). */
export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',') || '0';
}

function formValuesFromLink(link: Link): LinkFormValues {
  return {
    vitrineStoreId: link.vitrineStoreId,
    checkoutStoreId: link.checkoutStoreId,
    kind: link.kind,
    countries: link.countries.join(', '),
    strategy: link.strategy,
    parityPolicy: link.parityPolicy,
    tolerancePercent: bpsToPercent(link.priceToleranceBps),
    maxQuantityPerLine: String(link.maxQuantityPerLine),
    maxLines: String(link.maxLines),
    allowPermalinkFallback: link.allowPermalinkFallback,
    enabled: link.enabled,
  };
}

/** "0,5" ou "0.5" por cento -> 50 pontos-base. Aceita de 0 a 100%. */
export function percentToBps(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (normalized === '') return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(normalized)) return null;
  const bps = Math.round(Number(normalized) * 100);
  return bps >= 0 && bps <= 10000 ? bps : null;
}

function parseInt10(input: string, min: number, max: number): number | null {
  if (!/^\d{1,6}$/.test(input)) return null;
  const n = Number(input);
  return n >= min && n <= max ? n : null;
}

/** Códigos separados por vírgula, espaço ou quebra de linha; a validação fica com o repositório. */
export function parseCountries(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

/** Campos comuns à criação e à edição, já convertidos. */
function parseCommon(v: LinkFormValues): FormResult<Omit<NewLink, 'vitrineStoreId' | 'checkoutStoreId'>> {
  if (!(KINDS as readonly string[]).includes(v.kind)) return { ok: false, message: 'Escolha o tipo da rota: padrão ou por país.' };
  if (!(STRATEGIES as readonly string[]).includes(v.strategy)) return { ok: false, message: 'Estratégia de checkout inválida.' };
  if (!(POLICIES as readonly string[]).includes(v.parityPolicy)) return { ok: false, message: 'Política de paridade de preço inválida.' };
  const bps = percentToBps(v.tolerancePercent);
  if (bps === null) return { ok: false, message: 'Tolerância de preço inválida: informe uma porcentagem entre 0 e 100 (ex.: 0,5).' };
  const maxQuantityPerLine = parseInt10(v.maxQuantityPerLine, 1, 10000);
  if (maxQuantityPerLine === null) return { ok: false, message: 'Quantidade máxima por variante inválida: informe um inteiro de 1 a 10000.' };
  const maxLines = parseInt10(v.maxLines, 1, MAX_LINES_LIMIT);
  if (maxLines === null) return { ok: false, message: `Máximo de linhas inválido: informe um inteiro de 1 a ${MAX_LINES_LIMIT}.` };
  const kind = v.kind as LinkKind;
  const countries = kind === 'country' ? parseCountries(v.countries) : [];
  if (kind === 'country' && countries.length === 0) {
    return { ok: false, message: 'Rota por país exige pelo menos um código de país (ISO alpha-2, ex.: BR, PT).' };
  }
  return {
    ok: true,
    value: {
      kind,
      countries,
      strategy: v.strategy as SessionStrategy,
      parityPolicy: v.parityPolicy as ParityPolicy,
      priceToleranceBps: bps,
      maxQuantityPerLine,
      maxLines,
      allowPermalinkFallback: v.allowPermalinkFallback,
      enabled: v.enabled,
    },
  };
}

export function parseNewLink(form: Record<string, string>): FormResult<NewLink> {
  const v = formValuesFrom(form);
  if (v.vitrineStoreId === '') return { ok: false, message: 'Escolha a vitrine.' };
  if (v.checkoutStoreId === '') return { ok: false, message: 'Escolha a loja de checkout de destino.' };
  const common = parseCommon(v);
  if (!common.ok) return common;
  return { ok: true, value: { vitrineStoreId: v.vitrineStoreId, checkoutStoreId: v.checkoutStoreId, ...common.value } };
}

export function parseLinkPatch(form: Record<string, string>): FormResult<LinkPatch> {
  return parseCommon(formValuesFrom(form));
}

/** Mensagem e status HTTP para um erro vindo do repositório; outros erros sobem. */
function describeError(err: unknown): { message: string; status: 400 | 409 } {
  if (isBridgeError(err) && err.code === 'invalid_request') return { message: err.message, status: 400 };
  if (isBridgeError(err) && err.code === 'conflict') {
    const country = typeof err.details['country'] === 'string' ? ` (${err.details['country']})` : '';
    return { message: `${err.message}${country}. Desative ou edite a outra rota antes de salvar esta.`, status: 409 };
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Marcação
// ---------------------------------------------------------------------------

function errorBox(message: string | null): Markup | '' {
  if (message === null || message === '') return '';
  return html`<div class="flash flash-error" role="alert">${message}</div>`;
}

function sel(selected: boolean): string {
  return selected ? 'selected' : '';
}

function chk(on: boolean): string {
  return on ? 'checked' : '';
}

/** Nome da loja pelo id; uma rota cuja loja sumiu mostra o id para não esconder o problema. */
function storeLabel(stores: Map<string, Store>, id: string): string {
  return stores.get(id)?.name ?? id;
}

function kindLabel(link: Link): string {
  return link.kind === 'default' ? 'Padrão' : `Países: ${link.countries.join(', ')}`;
}

/** Contagens do mapeamento como selos; só os valores diferentes de zero aparecem. */
export function countsBadges(counts: MappingCounts): Markup {
  const items: Array<[number, 'ok' | 'warn' | 'error' | 'muted', string]> = [
    [counts.active, 'ok', 'ativos'],
    [counts.suggested, 'warn', 'sugeridos'],
    [counts.conflict, 'error', 'em conflito'],
    [counts.unmapped, 'muted', 'sem destino'],
    [counts.disabled, 'muted', 'desativados'],
    [counts.divergent, 'warn', 'divergentes'],
  ];
  const shown = items.filter(([n]) => n > 0);
  if (shown.length === 0) return html`<span class="muted">nenhum</span>`;
  return html`${shown.map(([n, kind, label]) => html`${badge(kind, `${n} ${label}`)} `)}`;
}

function countsSentence(counts: MappingCounts): string {
  return `${counts.active} ativos, ${counts.suggested} sugeridos, ${counts.conflict} em conflito, ${counts.unmapped} sem destino, ${counts.divergent} divergentes.`;
}

function linkCards(links: Link[], stores: Map<string, Store>, countsFor: (link: Link) => MappingCounts): Markup {
  if (links.length === 0) return html`<p class="empty">Nenhuma rota para esta vitrine.</p>`;
  return html`<div class="link-grid">${links.map((link) => {
    const c = countsFor(link);
    const pending = c.suggested + c.conflict;
    return html`<article class="tile link-tile">
      <div class="tile-head">
        <div class="tile-title"><span class="arrow">→</span><a href="/admin/links/${link.id}">${storeLabel(stores, link.checkoutStoreId)}</a></div>
        ${link.enabled ? badge('ok', 'Ativa') : badge('muted', 'Desativada')}
      </div>
      <dl class="tile-meta">
        <dt>Aplica-se a</dt><dd>${kindLabel(link)}</dd>
        <dt>Estratégia</dt><dd>${STRATEGY_LABEL[link.strategy]}</dd>
        <dt>Paridade de preço</dt><dd>${POLICY_LABEL[link.parityPolicy]}${link.parityPolicy === 'off' ? '' : html` <span class="muted">(${bpsToPercent(link.priceToleranceBps)}%)</span>`}</dd>
      </dl>
      ${progressBar([
        { kind: 'ok', value: c.active, label: 'ativos' },
        { kind: 'warn', value: pending, label: 'aguardando revisão' },
        { kind: 'error', value: c.unmapped, label: 'sem correspondência' },
      ])}
      <div class="legend"><span class="l-ok">${c.active} ativos</span><span class="l-warn">${c.suggested} sugeridos</span><span class="l-warn">${c.conflict} em conflito</span><span class="l-error">${c.unmapped} sem par</span>${c.divergent > 0 ? html`<span class="l-error">${c.divergent} divergentes</span>` : ''}</div>
      <div class="tile-foot">
        <a class="btn btn-secondary btn-small" href="/admin/links/${link.id}/mappings">Mapeamentos</a>
        <a class="btn btn-secondary btn-small" href="/admin/links/${link.id}">Abrir</a>
      </div>
    </article>`;
  })}</div>`;
}

function linksTable(links: Link[], stores: Map<string, Store>, countsFor: (link: Link) => MappingCounts): Markup {
  if (links.length === 0) return html`<p class="empty">Nenhuma rota para esta vitrine.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Destino (checkout)</th><th>Tipo</th><th>Estratégia</th><th>Paridade</th><th>Ativa</th><th>Mapeamentos</th></tr></thead>
    <tbody>
      ${links.map(
        (link) => html`<tr>
          <td><a href="/admin/links/${link.id}">${storeLabel(stores, link.checkoutStoreId)}</a></td>
          <td>${kindLabel(link)}</td>
          <td>${STRATEGY_LABEL[link.strategy]}</td>
          <td>${POLICY_LABEL[link.parityPolicy]}${link.parityPolicy === 'off' ? '' : html` <span class="muted">(${bpsToPercent(link.priceToleranceBps)}%)</span>`}</td>
          <td>${link.enabled ? badge('ok', 'Sim') : badge('muted', 'Não')}</td>
          <td>${countsBadges(countsFor(link))}</td>
        </tr>`,
      )}
    </tbody>
  </table></div>`;
}

/**
 * Formulário de rota. Na edição a vitrine e o checkout são só leitura: trocar o destino é
 * criar outra rota, de propósito, para que a trilha de auditoria mostre a decisão.
 */
function linkForm(opts: {
  mode: 'new' | 'edit';
  action: string;
  values: LinkFormValues;
  csrf: Markup;
  error: string | null;
  vitrines: Store[];
  checkouts: Store[];
  stores: Map<string, Store>;
  link?: Link;
}): Markup {
  const { values: v } = opts;
  const isNew = opts.mode === 'new';
  return html`<form method="post" action="${opts.action}">
    ${opts.csrf}
    ${errorBox(opts.error)}
    ${isNew
      ? html`<label class="field"><span>Vitrine</span>
          <select name="vitrineStoreId" required>
            <option value="" ${sel(v.vitrineStoreId === '')}>Escolha…</option>
            ${opts.vitrines.map((s) => html`<option value="${s.id}" ${sel(v.vitrineStoreId === s.id)}>${s.name} (${s.shopDomain})</option>`)}
          </select>
        </label>
        <label class="field"><span>Loja de checkout (destino)</span>
          <select name="checkoutStoreId" required>
            <option value="" ${sel(v.checkoutStoreId === '')}>Escolha…</option>
            ${opts.checkouts.map((s) => html`<option value="${s.id}" ${sel(v.checkoutStoreId === s.id)}>${s.name} (${s.shopDomain})</option>`)}
          </select>
          <small>Toda rota aponta para uma única loja de checkout, escolhida aqui. O destino nunca muda sozinho.</small>
        </label>`
      : html`<dl class="pairs">
          <dt>Vitrine</dt><dd>${storeLabel(opts.stores, v.vitrineStoreId)}</dd>
          <dt>Destino</dt><dd>${storeLabel(opts.stores, v.checkoutStoreId)}</dd>
        </dl>`}
    <input type="hidden" name="kind" value="default">
    <label class="field"><span>Estratégia</span>
      <select name="strategy">
        ${STRATEGIES.map((s) => html`<option value="${s}" ${sel((v.strategy === '' ? 'storefront_cart' : v.strategy) === s)}>${STRATEGY_LABEL[s]}</option>`)}
      </select>
    </label>
    <label class="field"><span>Paridade de preço</span>
      <select name="parityPolicy">
        ${POLICIES.map((p) => html`<option value="${p}" ${sel((v.parityPolicy === '' ? 'block' : v.parityPolicy) === p)}>${POLICY_LABEL[p]}</option>`)}
      </select>
    </label>
    <label class="field"><span>Tolerância de preço (%)</span>
      <input type="text" name="tolerancePercent" value="${v.tolerancePercent}" inputmode="decimal" placeholder="0" autocomplete="off">
      <small>Diferença relativa aceita entre o preço da vitrine e o do checkout. 0 exige preço idêntico.</small>
    </label>
    <div class="form-row">
      <label class="field"><span>Quantidade máxima por variante</span>
        <input type="number" name="maxQuantityPerLine" value="${v.maxQuantityPerLine}" min="1" max="10000" required>
        <small>Vale para cada linha e para a soma das linhas da mesma variante da loja checkout, com ou sem personalização.</small>
      </label>
      <label class="field"><span>Máximo de linhas no carrinho</span>
        <input type="number" name="maxLines" value="${v.maxLines}" min="1" max="${MAX_LINES_LIMIT}" required>
      </label>
    </div>
    <label class="field"><span><input type="checkbox" name="allowPermalinkFallback" value="1" ${chk(v.allowPermalinkFallback)}> Permitir link direto de carrinho na mesma loja se a Storefront API falhar</span></label>
    <label class="field"><span><input type="checkbox" name="enabled" value="1" ${chk(v.enabled)}> Rota ativa</span></label>
    <div class="actions">
      <button class="btn" type="submit">${isNew ? 'Criar rota' : 'Salvar alterações'}</button>
      <a class="btn btn-link" href="${isNew ? '/admin/links' : `/admin/links/${opts.link?.id ?? ''}`}">Cancelar</a>
    </div>
  </form>`;
}

function testResultCard(result: LinkTestResult): Markup {
  return html`<section class="card">
    <h2>Resultado do teste da rota ${result.ok ? badge('ok', 'Sucesso') : badge('error', 'Falhou')}</h2>
    <p>Estratégia: ${STRATEGY_LABEL[result.strategy]}. Variantes testadas: ${result.tested}.${result.detail === null ? '' : html` <span class="muted">${result.detail}</span>`}</p>
    ${result.problems.length === 0
      ? html`<p class="muted">Nenhum problema encontrado na amostra.</p>`
      : html`<ul>${result.problems.map(
          (p) => html`<li><span class="mono">${p.vitrineVariantId}</span> → <span class="mono">${p.checkoutVariantId ?? '—'}</span>: ${p.problem}</li>`,
        )}</ul>`}
  </section>`;
}

function detailBody(
  c: Context<AdminEnv>,
  link: Link,
  opts: { stores: Map<string, Store>; counts: MappingCounts; test: LinkTestResult | null; values: LinkFormValues; error: string | null },
): Markup {
  const csrf = csrfField(c.get('session'));
  const base = `/admin/links/${link.id}`;
  const actionForm = (path: string, label: string, cls: string, confirm?: string): Markup =>
    html`<form method="post" action="${base}/${path}" ${confirm === undefined ? '' : html`data-confirm="${confirm}"`}>
      ${csrf}<button class="btn ${cls}" type="submit">${label}</button>
    </form>`;
  return html`<section class="card">
      <dl class="pairs">
        <dt>Vitrine</dt><dd><a href="/admin/stores/${link.vitrineStoreId}">${storeLabel(opts.stores, link.vitrineStoreId)}</a></dd>
        <dt>Destino (checkout)</dt><dd><a href="/admin/stores/${link.checkoutStoreId}">${storeLabel(opts.stores, link.checkoutStoreId)}</a></dd>
        <dt>Tipo</dt><dd>${kindLabel(link)}</dd>
        <dt>Estratégia</dt><dd>${STRATEGY_LABEL[link.strategy]}</dd>
        <dt>Paridade de preço</dt><dd>${POLICY_LABEL[link.parityPolicy]} (tolerância ${bpsToPercent(link.priceToleranceBps)}%)</dd>
        <dt>Limites</dt><dd>${link.maxQuantityPerLine} por variante, ${link.maxLines} linhas</dd>
        <dt>Link direto se a API falhar</dt><dd>${link.allowPermalinkFallback ? 'Sim' : 'Não'}</dd>
        <dt>Ativa</dt><dd>${link.enabled ? badge('ok', 'Sim') : badge('muted', 'Não')}</dd>
        <dt>Mapeamentos</dt><dd>${countsBadges(opts.counts)} <a href="${base}/mappings">Ver mapeamentos</a></dd>
      </dl>
      <div class="actions">
        ${actionForm('rematch', 'Recalcular mapeamento', 'btn-secondary')}
        ${actionForm('test', 'Testar rota', 'btn-secondary')}
        ${link.enabled
          ? actionForm('disable', 'Desativar', 'btn-secondary', 'Desativar esta rota? Os compradores que ela atende ficam sem checkout.')
          : actionForm('enable', 'Ativar', 'btn-secondary')}
        ${actionForm('delete', 'Excluir rota', 'btn-danger')}
      </div>
    </section>
    ${opts.test === null ? '' : testResultCard(opts.test)}
    <section class="card">
      <h2>Editar rota</h2>
      ${linkForm({ mode: 'edit', action: base, values: opts.values, csrf, error: opts.error, vitrines: [], checkouts: [], stores: opts.stores, link })}
    </section>`;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function createLinkAdminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const { repos } = deps;

  /** Resultado do último teste de cada rota, só em memória (diagnóstico do momento). */
  const lastTests = new Map<string, LinkTestResult>();

  function storesById(): Map<string, Store> {
    return new Map(repos.stores.list().map((s) => [s.id, s]));
  }

  function notFound(c: Context<AdminEnv>): Response | Promise<Response> {
    return errorPage(c, 404, 'Rota não encontrada', 'Essa rota não existe ou já foi removida.', c.get('session'));
  }

  /** Recalcula o par depois de uma mudança; falha vira aviso, a rota em si já foi salva. */
  function rematch(link: Link): string {
    try {
      const summary = deps.matcher.rematchPair(link.vitrineStoreId, link.checkoutStoreId);
      return `Mapeamento recalculado: ${countsSentence(summary.counts)}`;
    } catch (err) {
      deps.logger.warn({ err, linkId: link.id }, 'falha ao recalcular mapeamento da rota');
      return 'Não foi possível recalcular o mapeamento agora; use "Recalcular mapeamento" mais tarde.';
    }
  }

  function renderDetail(c: Context<AdminEnv>, link: Link, opts: { values?: LinkFormValues; error?: string; status?: 200 | 400 | 409 } = {}) {
    const stores = storesById();
    const body = detailBody(c, link, {
      stores,
      counts: repos.mappings.counts(link.vitrineStoreId, link.checkoutStoreId),
      test: lastTests.get(link.id) ?? null,
      values: opts.values ?? formValuesFromLink(link),
      error: opts.error ?? null,
    });
    const title = `Rota: ${storeLabel(stores, link.vitrineStoreId)} → ${storeLabel(stores, link.checkoutStoreId)}`;
    return c.html(page({ title, active: 'links', session: c.get('session'), flash: takeFlash(c), body }), opts.status ?? 200);
  }

  function renderNew(c: Context<AdminEnv>, values: LinkFormValues, error: string | null, status: 200 | 400 | 409) {
    const stores = repos.stores.list();
    const body = html`<section class="card">
      ${linkForm({
        mode: 'new',
        action: '/admin/links',
        values,
        csrf: csrfField(c.get('session')),
        error,
        vitrines: stores.filter((s) => s.role === 'vitrine'),
        checkouts: stores.filter((s) => s.role === 'checkout'),
        stores: new Map(stores.map((s) => [s.id, s])),
      })}
    </section>`;
    return c.html(page({ title: 'Nova rota', active: 'links', session: c.get('session'), flash: takeFlash(c), body }), status);
  }

  app.get('/', (c) => {
    const stores = repos.stores.list();
    const byId = new Map(stores.map((s) => [s.id, s]));
    const links = repos.links.list();
    const countsCache = new Map<string, MappingCounts>();
    const countsFor = (link: Link): MappingCounts => {
      const key = `${link.vitrineStoreId}|${link.checkoutStoreId}`;
      let counts = countsCache.get(key);
      if (counts === undefined) {
        counts = repos.mappings.counts(link.vitrineStoreId, link.checkoutStoreId);
        countsCache.set(key, counts);
      }
      return counts;
    };
    const vitrines = stores.filter((s) => s.role === 'vitrine');
    void linksTable;
    const body = html`${vitrines.length === 0 ? html`<p class="empty">Cadastre uma vitrine antes de criar rotas.</p>` : ''}
      ${vitrines.map(
        (vitrine) => html`<section class="card">
          <div class="card-head"><h2>${vitrine.name} <span class="mono muted">${vitrine.shopDomain}</span></h2>
            <a class="btn btn-link btn-small" href="/admin/links/new?vitrine=${vitrine.id}">Nova rota desta vitrine</a></div>
          ${linkCards(links.filter((l) => l.vitrineStoreId === vitrine.id), byId, countsFor)}
        </section>`,
      )}`;
    return c.html(
      page({
        title: 'Rotas',
        description: 'Cada vitrine aponta para uma loja checkout: uma rota padrão e, se quiser, rotas por país. O destino é sempre o que você define aqui.',
        actions: html`<a class="btn" href="/admin/links/new">Nova rota</a>`,
        active: 'links',
        session: c.get('session'),
        flash: takeFlash(c),
        body,
      }),
    );
  });

  app.get('/new', (c) =>
    renderNew(
      c,
      {
        vitrineStoreId: c.req.query('vitrine') ?? '',
        checkoutStoreId: '',
        kind: 'default',
        countries: '',
        strategy: 'storefront_cart',
        parityPolicy: 'block',
        tolerancePercent: '0',
        maxQuantityPerLine: '50',
        maxLines: String(MAX_LINES_LIMIT),
        allowPermalinkFallback: true,
        enabled: true,
      },
      null,
      200,
    ),
  );

  app.post('/', async (c) => {
    const form = await readForm(c);
    const parsed = parseNewLink(form);
    if (!parsed.ok) return renderNew(c, formValuesFrom(form), parsed.message, 400);
    let link: Link;
    try {
      link = repos.links.create(parsed.value);
    } catch (err) {
      const { message, status } = describeError(err);
      return renderNew(c, formValuesFrom(form), message, status);
    }
    audit(deps, 'link.create', 'link', link.id, {
      vitrineStoreId: link.vitrineStoreId,
      checkoutStoreId: link.checkoutStoreId,
      kind: link.kind,
      countries: link.countries,
      strategy: link.strategy,
      enabled: link.enabled,
    });
    setFlash(c, { kind: 'ok', text: `Rota criada. ${rematch(link)}` });
    return redirectTo(c, `/admin/links/${link.id}`);
  });

  app.get('/:id', (c) => {
    const link = repos.links.get(c.req.param('id'));
    if (link === null) return notFound(c);
    return renderDetail(c, link);
  });

  app.post('/:id', async (c) => {
    const link = repos.links.get(c.req.param('id'));
    if (link === null) return notFound(c);
    const form = await readForm(c);
    const parsed = parseLinkPatch(form);
    if (!parsed.ok) return renderDetail(c, link, { values: formValuesFrom(form), error: parsed.message, status: 400 });
    let updated: Link;
    try {
      updated = repos.links.update(link.id, parsed.value);
    } catch (err) {
      const { message, status } = describeError(err);
      return renderDetail(c, link, { values: formValuesFrom(form), error: message, status });
    }
    audit(deps, 'link.update', 'link', link.id, { patch: parsed.value });
    // As divergências dependem da tolerância: mudou, recalcula para a lista não ficar velha.
    const note = updated.priceToleranceBps !== link.priceToleranceBps ? ` ${rematch(updated)}` : '';
    setFlash(c, { kind: 'ok', text: `Rota salva.${note}` });
    return redirectTo(c, `/admin/links/${link.id}`);
  });

  app.post('/:id/rematch', (c) => {
    const link = repos.links.get(c.req.param('id'));
    if (link === null) return notFound(c);
    const summary = deps.matcher.rematchPair(link.vitrineStoreId, link.checkoutStoreId);
    audit(deps, 'link.rematch', 'link', link.id, { counts: summary.counts });
    setFlash(c, { kind: 'ok', text: `Mapeamento recalculado: ${countsSentence(summary.counts)}` });
    return redirectTo(c, `/admin/links/${link.id}`);
  });

  app.post('/:id/test', async (c) => {
    const link = repos.links.get(c.req.param('id'));
    if (link === null) return notFound(c);
    const result = await deps.checkout.testLink(link.id);
    lastTests.set(link.id, result);
    audit(deps, 'link.test', 'link', link.id, { ok: result.ok, tested: result.tested, problems: result.problems.length });
    setFlash(c, {
      kind: result.ok ? 'ok' : 'error',
      text: result.ok ? 'Teste da rota concluído sem problemas.' : 'O teste da rota encontrou problemas. Veja o resultado abaixo.',
    });
    return redirectTo(c, `/admin/links/${link.id}`);
  });

  for (const [path, enabled] of [['enable', true], ['disable', false]] as const) {
    app.post(`/:id/${path}`, (c) => {
      const link = repos.links.get(c.req.param('id'));
      if (link === null) return notFound(c);
      try {
        repos.links.update(link.id, { enabled });
      } catch (err) {
        const { message, status } = describeError(err);
        return renderDetail(c, link, { error: message, status });
      }
      audit(deps, enabled ? 'link.enable' : 'link.disable', 'link', link.id, {});
      setFlash(c, { kind: 'ok', text: enabled ? 'Rota ativada.' : 'Rota desativada.' });
      return redirectTo(c, `/admin/links/${link.id}`);
    });
  }

  /** Segundo passo da exclusão, no servidor: o data-confirm do botão depende do script do painel. */
  function renderDeleteConfirm(c: Context<AdminEnv>, link: Link) {
    const stores = storesById();
    const body = html`<section class="card">
      <h2>Excluir rota</h2>
      <p>
        Excluir a rota <strong>${storeLabel(stores, link.vitrineStoreId)} → ${storeLabel(stores, link.checkoutStoreId)}</strong> (${kindLabel(link)})?
        ${link.enabled ? 'Ela está ativa: os compradores que ela atende ficam sem checkout até outra rota cobri-los.' : 'Ela está desativada.'}
        Os mapeamentos do par continuam guardados.
      </p>
      <form method="post" action="/admin/links/${link.id}/delete" class="actions">
        ${csrfField(c.get('session'))}
        <input type="hidden" name="confirm" value="sim">
        <button class="btn btn-danger" type="submit">Excluir rota</button>
        <a class="btn btn-secondary" href="/admin/links/${link.id}">Cancelar</a>
      </form>
    </section>`;
    return c.html(page({ title: 'Excluir rota', active: 'links', session: c.get('session'), flash: takeFlash(c), body }));
  }

  app.post('/:id/delete', async (c) => {
    const link = repos.links.get(c.req.param('id'));
    if (link === null) return notFound(c);
    // Sem o campo de confirmação (botão da página da rota, com ou sem o script do painel)
    // a resposta é a página de confirmação, e nada é apagado.
    const form = await readForm(c);
    if (form['confirm'] !== 'sim') return renderDeleteConfirm(c, link);
    repos.links.delete(link.id);
    lastTests.delete(link.id);
    audit(deps, 'link.delete', 'link', link.id, {
      vitrineStoreId: link.vitrineStoreId,
      checkoutStoreId: link.checkoutStoreId,
      kind: link.kind,
      countries: link.countries,
    });
    setFlash(c, { kind: 'ok', text: 'Rota excluída.' });
    return redirectTo(c, '/admin/links');
  });

  app.route('/:id/mappings', createMappingRoutes(deps));

  return app;
}
