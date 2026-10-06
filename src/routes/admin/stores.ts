import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { REQUIRED_SCOPES } from '../../catalog/scopes.ts';
import { DEFAULT_PROXY_PATH } from '../../db/store-repo.ts';
import { normalizeShopDomain } from '../../lib/shop.ts';
import { systemClock } from '../../lib/clock.ts';
import { isBridgeError } from '../../types.ts';
import type {
  ConnectionReport,
  ConnectionStepName,
  NewStore,
  Store,
  StorePatch,
  StoreRole,
  StoreStatus,
  StorefrontAuthMode,
  SyncResult,
  AdminSession,
} from '../../types.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { audit, errorPage, readForm, redirectTo, setFlash, takeFlash } from './context.ts';
import { badge, csrfField, fmtDate, page, icon, fmtMoney } from './layout.ts';
import type { Markup } from './layout.ts';

/**
 * Seção "Lojas" do painel: cadastro, edição, conexão e instruções de instalação de cada
 * loja (vitrine ou checkout).
 *
 * Segredos (client secret, token de Storefront) entram pelo formulário e vão direto ao
 * repositório, que os cifra. Nenhuma página os devolve: o campo de edição aparece sempre
 * vazio e "vazio" significa "manter o que está guardado". Depois de um erro de validação o
 * formulário volta preenchido com tudo, menos os segredos, que a pessoa digita de novo.
 *
 * A sessão e o token de CSRF já foram conferidos pelo middleware aplicado em index.ts.
 */

/** Caminho do recebimento de webhooks, relativo à URL pública (ver src/routes/webhooks.ts). */
const WEBHOOK_CALLBACK_PATH = '/webhooks/shopify';

const ROLES: readonly StoreRole[] = ['vitrine', 'checkout'];
const AUTH_MODES: readonly StorefrontAuthMode[] = ['tokenless', 'private_token', 'public_token'];

const ROLE_LABEL: Record<StoreRole, string> = { vitrine: 'Vitrine', checkout: 'Checkout' };

const AUTH_MODE_LABEL: Record<StorefrontAuthMode, string> = {
  tokenless: 'Sem token (acesso público da Storefront API)',
  private_token: 'Token privado (Shopify-Storefront-Private-Token)',
  public_token: 'Token público (X-Shopify-Storefront-Access-Token)',
};

const AUTH_MODE_HELP: Record<StorefrontAuthMode, string> = {
  tokenless:
    'Sem token: a Storefront API aceita criar carrinhos sem credencial, com limite de complexidade menor; é o modo mais simples e não lê a quantidade em estoque.',
  private_token:
    'Token privado: credencial de servidor, nunca vai ao navegador; é o modo recomendado pela Shopify para chamadas feitas por um serviço como este.',
  public_token:
    'Token público: feito para navegadores e apps; a capacidade é contada por IP do comprador, então chamadas vindas de um único servidor concentram tudo num IP.',
};

const STATUS_BADGE: Record<StoreStatus, { kind: 'ok' | 'warn' | 'error' | 'muted'; text: string }> = {
  connected: { kind: 'ok', text: 'Conectada' },
  pending: { kind: 'warn', text: 'Pendente' },
  error: { kind: 'error', text: 'Erro' },
  disabled: { kind: 'muted', text: 'Desativada' },
};

const STEP_LABEL: Record<ConnectionStepName, string> = {
  credentials: 'Credenciais',
  scopes: 'Escopos',
  webhooks: 'Webhooks',
  catalog: 'Catálogo',
  mappings: 'Mapeamentos',
};

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

/** Campos do formulário que voltam preenchidos depois de um erro. Segredos ficam de fora. */
export interface StoreFormValues {
  role: string;
  name: string;
  shopDomain: string;
  clientId: string;
  publicDomain: string;
  proxyPath: string;
  storefrontAuthMode: string;
}

type FormResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRole(value: string): value is StoreRole {
  return (ROLES as readonly string[]).includes(value);
}

function isAuthMode(value: string): value is StorefrontAuthMode {
  return (AUTH_MODES as readonly string[]).includes(value);
}

function text(form: Record<string, string>, field: string): string {
  return (form[field] ?? '').trim();
}

export function formValuesFrom(form: Record<string, string>): StoreFormValues {
  return {
    role: text(form, 'role'),
    name: text(form, 'name'),
    shopDomain: text(form, 'shopDomain'),
    clientId: text(form, 'clientId'),
    publicDomain: text(form, 'publicDomain'),
    proxyPath: text(form, 'proxyPath'),
    storefrontAuthMode: text(form, 'storefrontAuthMode'),
  };
}

function formValuesFromStore(store: Store): StoreFormValues {
  return {
    role: store.role,
    name: store.name,
    shopDomain: store.shopDomain,
    clientId: store.clientId,
    publicDomain: store.publicDomain ?? '',
    proxyPath: store.proxyPath ?? '',
    storefrontAuthMode: store.storefrontAuthMode,
  };
}

/**
 * Dados de uma loja nova a partir do formulário. Só o que o repositório não valida por
 * conta própria é conferido aqui (domínio colado de qualquer jeito, modo que exige token);
 * o resto fica com o repositório, cuja mensagem de erro é mostrada ao lado do formulário.
 */
export function parseNewStore(form: Record<string, string>): FormResult<NewStore> {
  const v = formValuesFrom(form);
  if (!isRole(v.role)) return { ok: false, message: 'Escolha o papel da loja: vitrine ou checkout.' };
  const shopDomain = normalizeShopDomain(v.shopDomain);
  if (shopDomain === null) {
    return { ok: false, message: 'Domínio inválido: use o endereço <loja>.myshopify.com da loja.' };
  }
  // Nome em branco: usa o rótulo do domínio; a conexão troca pelo nome real da loja na Shopify.
  if (v.name === '') v.name = shopDomain.replace(/\.myshopify\.com$/, '');
  if (v.clientId === '') return { ok: false, message: 'Informe o client ID do app (Dev Dashboard).' };
  // Segredos não passam por trim: um espaço faria parte do valor que a pessoa colou.
  const clientSecret = form['clientSecret'] ?? '';
  if (clientSecret.trim() === '') return { ok: false, message: 'Informe o client secret do app (Dev Dashboard).' };

  const value: NewStore = {
    role: v.role,
    name: v.name,
    shopDomain,
    clientId: v.clientId,
    clientSecret,
    publicDomain: v.publicDomain === '' ? null : v.publicDomain,
  };
  if (v.role === 'vitrine') {
    value.proxyPath = v.proxyPath === '' ? DEFAULT_PROXY_PATH : v.proxyPath;
    value.storefrontAuthMode = 'tokenless';
  } else {
    const mode = v.storefrontAuthMode === '' ? 'tokenless' : v.storefrontAuthMode;
    if (!isAuthMode(mode)) return { ok: false, message: 'Modo da Storefront API inválido.' };
    const token = form['storefrontToken'] ?? '';
    if (mode !== 'tokenless' && token.trim() === '') {
      return { ok: false, message: 'Esse modo da Storefront API exige um token. Informe o token ou escolha "Sem token".' };
    }
    value.storefrontAuthMode = mode;
    value.storefrontToken = token.trim() === '' ? null : token;
  }
  return { ok: true, value };
}

/**
 * Alterações de uma loja existente. Papel e domínio não mudam (são a identidade da loja).
 * Campo de segredo em branco mantém o valor guardado. `credentialsChanged` avisa que o
 * token da Admin API em cache precisa ser descartado.
 */
export function parseStorePatch(
  form: Record<string, string>,
  current: Store,
): FormResult<{ patch: StorePatch; credentialsChanged: boolean; changed: string[] }> {
  const v = formValuesFrom(form);
  if (v.name === '') return { ok: false, message: 'Informe o nome da loja.' };
  if (v.clientId === '') return { ok: false, message: 'Informe o client ID do app (Dev Dashboard).' };

  const patch: StorePatch = { name: v.name, clientId: v.clientId, publicDomain: v.publicDomain === '' ? null : v.publicDomain };
  const changed: string[] = [];
  if (v.name !== current.name) changed.push('name');
  if (v.clientId !== current.clientId) changed.push('clientId');
  if ((current.publicDomain ?? '') !== v.publicDomain) changed.push('publicDomain');

  const clientSecret = form['clientSecret'] ?? '';
  if (clientSecret.trim() !== '') {
    patch.clientSecret = clientSecret;
    changed.push('clientSecret');
  }

  if (current.role === 'vitrine') {
    patch.proxyPath = v.proxyPath === '' ? DEFAULT_PROXY_PATH : v.proxyPath;
    if (patch.proxyPath !== current.proxyPath) changed.push('proxyPath');
  } else {
    const mode = v.storefrontAuthMode === '' ? current.storefrontAuthMode : v.storefrontAuthMode;
    if (!isAuthMode(mode)) return { ok: false, message: 'Modo da Storefront API inválido.' };
    const token = form['storefrontToken'] ?? '';
    const hasToken = token.trim() !== '' || current.hasStorefrontToken;
    if (mode !== 'tokenless' && !hasToken) {
      return { ok: false, message: 'Esse modo da Storefront API exige um token. Informe o token ou escolha "Sem token".' };
    }
    patch.storefrontAuthMode = mode;
    if (mode !== current.storefrontAuthMode) changed.push('storefrontAuthMode');
    if (token.trim() !== '') {
      patch.storefrontToken = token;
      changed.push('storefrontToken');
    }
  }

  const credentialsChanged = changed.some((f) => f === 'clientId' || f === 'clientSecret' || f === 'storefrontToken');
  return { ok: true, value: { patch, credentialsChanged, changed } };
}

/** Mensagem e status HTTP para um erro vindo do repositório; outros erros sobem. */
function describeError(err: unknown): { message: string; status: 400 | 409 } {
  if (isBridgeError(err) && err.code === 'invalid_request') return { message: err.message, status: 400 };
  if (isBridgeError(err) && err.code === 'conflict') return { message: err.message, status: 409 };
  throw err;
}

// ---------------------------------------------------------------------------
// Marcação
// ---------------------------------------------------------------------------

function statusBadge(store: Store): Markup {
  const spec = STATUS_BADGE[store.status] ?? { kind: 'muted', text: store.status };
  return badge(spec.kind, spec.text);
}

function errorBox(message: string | null): Markup | '' {
  if (message === null || message === '') return '';
  return html`<div class="flash flash-error" role="alert">${message}</div>`;
}

function sel(selected: boolean): string {
  return selected ? 'selected' : '';
}

/** Cartões de loja de um papel, no estilo das duas colunas da tela de lojas. */
function storeCards(stores: Store[], role: StoreRole, extra: (store: Store) => Markup, session: AdminSession): Markup {
  if (stores.length === 0) {
    return html`<div class="tile empty-state">${icon('store')}<div>Nenhuma loja ${role === 'vitrine' ? 'vitrine' : 'checkout'} cadastrada.</div>
      <a class="btn btn-small" href="/admin/stores/new?role=${role}">Adicionar</a></div>`;
  }
  return html`${stores.map(
    (store) => html`<article class="tile store-tile">
      <div class="tile-head">
        <div class="store-id"><span class="store-icon">${icon('store')}</span>
          <div><div class="tile-title"><a href="/admin/stores/${store.id}">${store.name}</a></div><div class="mono muted">${store.shopDomain}</div></div></div>
        <div class="tile-badges">${statusBadge(store)}${store.status === 'connected' && store.lastSyncOk !== false ? badge('ok', '● OK') : store.lastSyncOk === false ? badge('error', 'Sincronização falhou') : ''}</div>
      </div>
      <dl class="tile-meta">
        ${store.publicDomain === null ? '' : html`<dt>Domínio público</dt><dd class="num">${store.publicDomain}</dd>`}
        <dt>Última conexão</dt><dd class="num">${fmtDate(store.lastSyncAt)}</dd>
        <dt>Variantes</dt><dd class="num">${store.variantCount}</dd>
        ${store.statusDetail === null ? '' : html`<dt>Detalhe</dt><dd class="muted">${store.statusDetail}</dd>`}
      </dl>
      ${extra(store)}
      <div class="tile-foot tile-foot-split">
        <div class="tile-foot-left">
          <a class="icon-button" href="/admin/stores/${store.id}" title="Editar" aria-label="Editar ${store.name}">${icon('edit')}</a>
          <a class="btn btn-secondary btn-small" href="/admin/stores/${store.id}#instrucoes">Instruções</a>
        </div>
        <form method="post" action="/admin/stores/${store.id}/delete" data-confirm="Remover a loja ${store.name}? Digite o domínio na página da loja para confirmar.">
          ${csrfField(session)}
          <a class="icon-button danger" href="/admin/stores/${store.id}#remover" title="Remover" aria-label="Remover ${store.name}">${icon('trash')}</a>
        </form>
      </div>
    </article>`,
  )}`;
}

/**
 * Formulário de loja. Em `mode: 'edit'` papel e domínio são só leitura e os campos de
 * segredo ficam vazios de propósito (vazio = manter). Os campos de vitrine e de checkout
 * aparecem sempre, com a indicação de a qual papel se aplicam: sem script na página não há
 * como mostrar e esconder conforme a escolha.
 */
function storeForm(opts: {
  mode: 'new' | 'edit';
  action: string;
  values: StoreFormValues;
  csrf: Markup;
  error: string | null;
  store?: Store;
}): Markup {
  const { values: v, mode } = opts;
  const isNew = mode === 'new';
  const role = isRole(v.role) ? v.role : null;
  const showVitrine = role === null || role === 'vitrine';
  const showCheckout = role === null || role === 'checkout';
  const secretHelp = isNew ? '' : 'Deixe em branco para manter o valor guardado.';
  return html`<form method="post" action="${opts.action}">
    ${opts.csrf}
    ${errorBox(opts.error)}
    ${isNew
      ? html`<label class="field"><span>Papel</span>
          <select name="role" required>
            <option value="" ${sel(role === null)}>Escolha…</option>
            ${ROLES.map((r) => html`<option value="${r}" ${sel(v.role === r)}>${ROLE_LABEL[r]}</option>`)}
          </select>
          <small>Vitrine: loja com tema, onde o comprador navega. Checkout: loja onde o pedido é fechado.</small>
        </label>`
      : html`<input type="hidden" name="role" value="${v.role}">`}
    <label class="field"><span>Nome</span>
      <input type="text" name="name" value="${v.name}" required maxlength="200" autocomplete="off">
    </label>
    ${isNew
      ? html`<label class="field"><span>Domínio myshopify</span>
          <input type="text" name="shopDomain" value="${v.shopDomain}" required placeholder="minha-loja.myshopify.com" autocomplete="off">
          <small>Pode colar o endereço do admin; só o domínio &lt;loja&gt;.myshopify.com é guardado.</small>
        </label>`
      : html`<div class="field"><span>Domínio myshopify</span><span class="mono">${v.shopDomain}</span></div>`}
    <label class="field"><span>Domínio público (opcional)</span>
      <input type="text" name="publicDomain" value="${v.publicDomain}" placeholder="www.minhaloja.com.br" autocomplete="off">
    </label>
    <label class="field"><span>Client ID do app</span>
      <input type="text" name="clientId" value="${v.clientId}" required maxlength="200" autocomplete="off">
    </label>
    <label class="field"><span>Client secret do app</span>
      <input type="password" name="clientSecret" ${isNew ? 'required' : ''} autocomplete="new-password">
      ${secretHelp === '' ? '' : html`<small>${secretHelp}</small>`}
    </label>
    ${showVitrine
      ? html`<label class="field"><span>Caminho do App Proxy <small>(só vitrine)</small></span>
          <input type="text" name="proxyPath" value="${v.proxyPath}" placeholder="${DEFAULT_PROXY_PATH}" autocomplete="off">
          <small>Em branco usa ${DEFAULT_PROXY_PATH}. Precisa ser igual ao configurado no app.</small>
        </label>`
      : ''}
    ${showCheckout
      ? html`<label class="field"><span>Modo da Storefront API <small>(só checkout)</small></span>
          <select name="storefrontAuthMode">
            ${AUTH_MODES.map(
              (m) => html`<option value="${m}" ${sel((v.storefrontAuthMode === '' ? 'tokenless' : v.storefrontAuthMode) === m)}>${AUTH_MODE_LABEL[m]}</option>`,
            )}
          </select>
        </label>
        <label class="field"><span>Token da Storefront API <small>(só checkout)</small></span>
          <input type="password" name="storefrontToken" autocomplete="new-password">
          <small>${opts.store?.hasStorefrontToken === true ? 'Há um token guardado. ' : ''}${isNew ? 'Obrigatório nos modos com token.' : secretHelp}</small>
        </label>`
      : ''}
    <div class="actions">
      <button class="btn" type="submit">${isNew ? 'Cadastrar e conectar' : 'Salvar alterações'}</button>
      <a class="btn btn-link" href="${isNew ? '/admin/stores' : `/admin/stores/${opts.store?.id ?? ''}`}">Cancelar</a>
    </div>
  </form>`;
}

function copyBox(id: string, text: string): Markup {
  return html`<div class="code-box"><code id="${id}">${text}</code><button type="button" class="icon-button" data-copy="#${id}" aria-label="Copiar">${icon('swap')}</button></div>`;
}

/** Passo a passo de configuração na Shopify, por papel (mostrado ao lado do formulário). */
function setupSteps(deps: AdminDeps, role: StoreRole, proxyPath: string): Markup {
  const base = deps.config.publicBaseUrl;
  const scopes = [...REQUIRED_SCOPES[role], ...(role === 'vitrine' ? ['read_themes', 'write_themes'] : [])].join(', ');
  const { prefix, subpath } = splitProxyPath(proxyPath);
  return html`<ol class="steps">
    <li><strong>Criar app no Dev Dashboard da Shopify</strong>
      <div class="muted">No admin da loja: Configurações → Apps e canais de vendas → Desenvolver apps → "Build apps in Dev Dashboard". Crie um app novo:</div>
      <ol class="substeps">
        <li>Clique em <strong>Create app</strong>.</li>
        <li>Nome do app: <code>Checkout Bridge</code></li>
        <li>URL do app: ${copyBox(`app-url-${role}`, base)}</li>
        <li>Desative <strong>"Incorporar app no admin"</strong>.</li>
      </ol>
    </li>
    <li><strong>Configurar permissões (escopos)</strong>
      <div class="muted">Na versão do app, em Access scopes, conceda:</div>
      ${copyBox(`scopes-${role}`, scopes)}
      <div class="muted">${role === 'vitrine'
        ? 'Produtos e estoque: sincronizar o catálogo. Pedidos: detectar compra fora da ponte. Temas: instalar o script de redirecionamento automaticamente. App Proxy: o botão de finalizar compra fala com este serviço.'
        : 'Produtos e estoque: sincronizar o catálogo e conferir disponibilidade. Pedidos: contabilizar vendas, reembolsos e cancelamentos no painel.'}</div>
      ${role === 'vitrine'
        ? html`<div class="muted">Na seção <strong>App proxy</strong> da versão, informe:</div>
          <dl class="pairs"><dt>Subpath prefix</dt><dd><code>${prefix}</code></dd><dt>Subpath</dt><dd><code>${subpath}</code></dd><dt>Proxy URL</dt><dd>${copyBox('proxy-url', `${base}/proxy`)}</dd></dl>`
        : ''}
      <div class="muted">Webhooks API version: <code>${deps.config.shopifyApiVersion}</code>. URLs de redirecionamento: pode deixar a URL do app.</div>
    </li>
    <li><strong>Lançar a versão, instalar e copiar credenciais</strong>
      <ol class="substeps">
        <li>Clique em <strong>Release</strong> na versão e depois em <strong>Install app</strong> na loja.</li>
        <li>Em Settings → Credentials, copie o <strong>Client ID</strong> e cole no campo ao lado.</li>
        <li>Copie o <strong>Client secret</strong> e cole no campo ao lado.</li>
        <li>Clique em <strong>Salvar</strong> — a conexão é feita automaticamente.</li>
      </ol>
    </li>
    ${role === 'vitrine'
      ? html`<li><strong>Script de redirecionamento no tema</strong>
          <div class="muted">Ao salvar, o Checkout Bridge grava o script no tema publicado automaticamente (escopos read_themes e write_themes). Se a Shopify recusar, a página da loja mostra o bloco para colar à mão. Confirme que o tema está <strong>ativo e publicado</strong> e desligue os botões de compra acelerada (Buy it now, Shop Pay) no tema.</div>
        </li>`
      : html`<li><strong>Checkout pronto para receber</strong>
          <div class="muted">A loja checkout não pode estar protegida por senha e os produtos precisam estar publicados no canal da loja online. Depois, crie uma rota ligando a vitrine a esta loja em <a href="/admin/links/new">Rotas</a>.</div>
        </li>`}
  </ol>`;
}

function addStoreBody(deps: AdminDeps, v: StoreFormValues, error: string | null, csrf: Markup): Markup {
  const role: StoreRole = v.role === 'checkout' ? 'checkout' : 'vitrine';
  const domainLabel = v.shopDomain.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/.*$/, '');
  return html`<div class="add-store">
    <section class="card add-store-form">
      <form method="post" action="/admin/stores">
        ${csrf}
        ${errorBox(error)}
        <div class="field"><span>Tipo</span>
          <div class="type-toggle" role="radiogroup" aria-label="Tipo da loja">
            <input type="radio" id="role-vitrine" name="role" value="vitrine" ${role === 'vitrine' ? 'checked' : ''}><label for="role-vitrine">Vitrine</label>
            <input type="radio" id="role-checkout" name="role" value="checkout" ${role === 'checkout' ? 'checked' : ''}><label for="role-checkout">Checkout</label>
          </div>
          <small>Vitrine: loja com tema, onde o comprador navega. Checkout: loja onde o pedido é fechado.</small>
        </div>
        <label class="field"><span>Domínio Shopify</span>
          <span class="input-suffix"><input type="text" name="shopDomain" value="${domainLabel}" required placeholder="minha-loja" autocomplete="off" autocapitalize="off"><span class="suffix">.myshopify.com</span></span>
          <small>Cole a URL completa ou só o nome da loja — funciona dos dois jeitos.</small>
        </label>
        <label class="field"><span>Client ID</span>
          <input type="text" name="clientId" value="${v.clientId}" required maxlength="200" placeholder="Cole o Client ID do seu app Shopify" autocomplete="off">
        </label>
        <label class="field"><span>Client Secret</span>
          <span class="input-suffix"><input type="password" id="client-secret" name="clientSecret" required placeholder="Cole o Client Secret do seu app Shopify" autocomplete="new-password"><button type="button" class="icon-button suffix-btn" data-toggle-secret="#client-secret" aria-label="Mostrar ou ocultar">${icon('search')}</button></span>
        </label>
        <details class="section"><summary>Opções avançadas</summary><div class="section-body">
          <label class="field"><span>Nome (opcional)</span><input type="text" name="name" value="${v.name}" maxlength="200" autocomplete="off"><small>Em branco, usa o nome da loja na Shopify.</small></label>
          <label class="field"><span>Domínio público (opcional)</span><input type="text" name="publicDomain" value="${v.publicDomain}" placeholder="www.minhaloja.com.br" autocomplete="off"></label>
          <label class="field only-vitrine"><span>Caminho do App Proxy</span><input type="text" name="proxyPath" value="${v.proxyPath}" placeholder="${DEFAULT_PROXY_PATH}" autocomplete="off"><small>Em branco usa ${DEFAULT_PROXY_PATH}. Precisa ser igual ao configurado no app.</small></label>
          <label class="field only-checkout"><span>Modo da Storefront API</span>
            <select name="storefrontAuthMode">${AUTH_MODES.map((m) => html`<option value="${m}" ${sel((v.storefrontAuthMode === '' ? 'tokenless' : v.storefrontAuthMode) === m)}>${AUTH_MODE_LABEL[m]}</option>`)}</select>
            <small>"Sem token" funciona na maioria dos casos. Token privado é indicado para volume alto.</small></label>
          <label class="field only-checkout"><span>Token da Storefront API</span><input type="password" name="storefrontToken" autocomplete="new-password"><small>Só nos modos com token.</small></label>
        </div></details>
        <button class="btn btn-block" type="submit">Salvar</button>
        <p class="muted">Ao salvar, a conexão é feita automaticamente com o Client ID e Client Secret — sem passos extras.</p>
      </form>
    </section>
    <aside class="card add-store-help">
      <h2>${icon('guide')} Como configurar na Shopify</h2>
      <div class="steps-vitrine">${setupSteps(deps, 'vitrine', v.proxyPath === '' ? DEFAULT_PROXY_PATH : v.proxyPath)}</div>
      <div class="steps-checkout">${setupSteps(deps, 'checkout', DEFAULT_PROXY_PATH)}</div>
    </aside>
  </div>`;
}

function reportCard(report: ConnectionReport): Markup {
  return html`<section class="card">
    <h2>Resultado da última conexão ${report.ok ? badge('ok', 'Sucesso') : badge('error', 'Falhou')}</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Etapa</th><th>Resultado</th><th>Detalhe</th></tr></thead>
      <tbody>${report.steps.map(
        (step) => html`<tr>
          <td>${STEP_LABEL[step.name] ?? step.name}</td>
          <td>${step.ok ? badge('ok', 'OK') : badge('error', 'Falhou')}</td>
          <td>${step.detail}</td>
        </tr>`,
      )}</tbody>
    </table></div>
    ${report.missingScopes.length > 0
      ? html`<p>Escopos que faltam no app: <span class="mono">${report.missingScopes.join(', ')}</span>.
          Adicione-os na versão do app no Dev Dashboard, lance a versão e aprove a mudança na loja.</p>`
      : ''}
    ${report.shop === null
      ? ''
      : html`<dl class="pairs">
          <dt>Loja na Shopify</dt><dd>${report.shop.name}</dd>
          <dt>Moeda</dt><dd>${report.shop.currency}</dd>
          <dt>Domínio principal</dt><dd>${report.shop.primaryDomainHost ?? '—'}</dd>
        </dl>`}
  </section>`;
}

/** Prefixo e subcaminho do App Proxy, como o Dev Dashboard pede separados. */
function splitProxyPath(proxyPath: string | null): { prefix: string; subpath: string } {
  const match = /^\/([a-z]+)\/([A-Za-z0-9_-]+)$/.exec(proxyPath ?? DEFAULT_PROXY_PATH);
  return { prefix: match?.[1] ?? 'apps', subpath: match?.[2] ?? 'checkout-bridge' };
}

function scopesList(role: StoreRole): Markup {
  return html`<p>Escopos que o app precisa ter na versão lançada:
    ${REQUIRED_SCOPES[role].map((scope) => html`<code>${scope}</code> `)}</p>`;
}

function webhooksNote(deps: AdminDeps): Markup {
  return html`<p>Endereço que recebe os webhooks de catálogo (o botão "Conectar" cadastra as assinaturas automaticamente):
    <code>${deps.config.publicBaseUrl}${WEBHOOK_CALLBACK_PATH}</code></p>`;
}

function vitrineInstructions(deps: AdminDeps, store: Store, session: AdminSession): Markup {
  const { prefix, subpath } = splitProxyPath(store.proxyPath);
  const proxyPath = store.proxyPath ?? DEFAULT_PROXY_PATH;
  const host = store.publicDomain ?? store.shopDomain;
  const snippets = deps.renderSnippets(store);
  return html`<section class="card">
    <h2>Instalação na vitrine</h2>
    <h3>1. App no Dev Dashboard</h3>
    ${scopesList('vitrine')}
    <p>Na seção App Proxy da versão do app, informe:</p>
    <dl class="pairs">
      <dt>Subpath prefix</dt><dd><code>${prefix}</code></dd>
      <dt>Subpath</dt><dd><code>${subpath}</code></dd>
      <dt>Proxy URL</dt><dd><code>${deps.config.publicBaseUrl}/proxy</code></dd>
    </dl>
    <p>Para testar o proxy depois de instalar o app, abra
      <a href="https://${host}${proxyPath}/ping" rel="noopener noreferrer" target="_blank">https://${host}${proxyPath}/ping</a>:
      a resposta deve vir deste serviço.</p>
    ${webhooksNote(deps)}
    <h3>2. Script no tema</h3>
    ${deps.themeInstaller === undefined ? '' : html`<form method="post" action="/admin/stores/${store.id}/install-theme" class="actions">
      ${csrfField(session)}
      <button class="btn" type="submit" data-confirm="Gravar o bloco do checkout-bridge no theme.liquid do tema publicado desta vitrine?">Instalar no tema automaticamente</button>
      <span class="muted">Grava o bloco abaixo no tema publicado (exige o escopo write_themes no app). Se a Shopify recusar, cole à mão.</span>
    </form>`}
    <p>Ou cole o bloco abaixo no <code>theme.liquid</code>, antes de <code>&lt;/body&gt;</code>. Ele intercepta o botão de
      finalizar compra e envia só variantes e quantidades para este serviço.</p>
    <textarea id="snippet-inline" class="mono" rows="10" readonly>${snippets.inline}</textarea>
    <p><button type="button" class="btn btn-secondary btn-small" data-copy="#snippet-inline">Copiar bloco</button></p>
    <p>Alternativa em uma linha, que carrega o script pelo App Proxy a cada visualização de página
      (depende do proxy estar funcionando e adiciona uma requisição por página):</p>
    <textarea id="snippet-loader" class="mono" rows="2" readonly>${snippets.loader}</textarea>
    <p><button type="button" class="btn btn-secondary btn-small" data-copy="#snippet-loader">Copiar linha</button></p>
    <h3>3. Botões de compra acelerada</h3>
    <p>Desligue no tema os botões de checkout acelerado (Comprar agora, Shop Pay, Apple Pay, Google Pay, PayPal):
      eles levam direto ao checkout da própria vitrine, sem passar por este serviço.</p>
  </section>`;
}

function checkoutInstructions(deps: AdminDeps): Markup {
  return html`<section class="card">
    <h2>Configuração da loja checkout</h2>
    <h3>1. App no Dev Dashboard</h3>
    ${scopesList('checkout')}
    ${webhooksNote(deps)}
    <h3>2. Storefront API</h3>
    <ul>${AUTH_MODES.map((m) => html`<li>${AUTH_MODE_HELP[m]}</li>`)}</ul>
    <h3>3. Visibilidade dos produtos</h3>
    <p>Os produtos precisam estar publicados no canal de vendas que a Storefront API lê (Loja virtual ou Headless,
      conforme a origem do token); produto não publicado não entra no carrinho. A loja não pode estar protegida pela
      senha da loja virtual: o link do checkout e o permalink de carrinho param na página de senha.</p>
  </section>`;
}

function detailBody(deps: AdminDeps, c: Context<AdminEnv>, store: Store, opts: { report: ConnectionReport | null; values: StoreFormValues; error: string | null }): Markup {
  const csrf = csrfField(c.get('session'));
  const base = `/admin/stores/${store.id}`;
  const actionForm = (path: string, label: string, cls: string, confirm?: string): Markup =>
    html`<form method="post" action="${base}/${path}" ${confirm === undefined ? '' : html`data-confirm="${confirm}"`}>
      ${csrf}<button class="btn ${cls}" type="submit">${label}</button>
    </form>`;
  return html`<section class="card">
      <dl class="pairs">
        <dt>Papel</dt><dd>${ROLE_LABEL[store.role]}</dd>
        <dt>Status</dt><dd>${statusBadge(store)} ${store.statusDetail === null ? '' : html`<span class="muted">${store.statusDetail}</span>`}</dd>
        <dt>Domínio</dt><dd class="mono">${store.shopDomain}</dd>
        <dt>Domínio público</dt><dd class="mono">${store.publicDomain ?? '—'}</dd>
        <dt>Moeda</dt><dd>${store.currency ?? '—'}</dd>
        <dt>Variantes no catálogo</dt><dd>${store.variantCount}</dd>
        <dt>Última sincronização</dt>
        <dd>${fmtDate(store.lastSyncAt)}
          ${store.lastSyncOk === null ? '' : store.lastSyncOk ? badge('ok', 'OK') : badge('error', 'Falhou')}
          ${store.lastSyncDetail === null ? '' : html`<span class="muted">${store.lastSyncDetail}</span>`}</dd>
        ${store.role === 'checkout' ? html`<dt>Storefront API</dt><dd>${AUTH_MODE_LABEL[store.storefrontAuthMode]}</dd>` : ''}
      </dl>
      <div class="actions">
        ${actionForm('connect', 'Conectar', 'btn-secondary')}
        ${actionForm('sync', 'Sincronizar catálogo', 'btn-secondary')}
        ${store.status === 'disabled'
          ? actionForm('enable', 'Reativar', 'btn-secondary')
          : actionForm('disable', 'Desativar', 'btn-danger', 'Desativar esta loja? O checkout que passa por ela deixa de funcionar.')}
      </div>
    </section>
    ${opts.report === null ? '' : reportCard(opts.report)}
    ${store.role === 'vitrine' ? vitrineInstructions(deps, store, c.get('session')) : checkoutInstructions(deps)}
    <section class="card">
      <h2>Editar loja</h2>
      ${storeForm({ mode: 'edit', action: base, values: opts.values, csrf, error: opts.error, store })}
    </section>
    <section class="card">
      <h2>Remover loja</h2>
      <p>Remove a loja, o catálogo sincronizado, os mapeamentos e as rotas que passam por ela. Para confirmar,
        digite o domínio <span class="mono">${store.shopDomain}</span>.</p>
      <form method="post" action="${base}/delete" class="form-row">
        ${csrf}
        <label class="field"><span>Domínio da loja</span>
          <input type="text" name="confirmDomain" autocomplete="off" placeholder="${store.shopDomain}"></label>
        <button class="btn btn-danger" type="submit">Remover loja</button>
      </form>
    </section>`;
}

function syncSummary(result: SyncResult): string {
  if (!result.ok) return `Sincronização falhou${result.detail === null ? '' : `: ${result.detail}`}`;
  return `Catálogo sincronizado: ${result.variants} variantes (${result.removed} removidas). Mapeamentos recalculados.`;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function createStoreAdminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const { repos } = deps;

  /**
   * Relatório da última conexão de cada loja, só em memória: é um resultado de diagnóstico
   * do momento, mostrado na página da loja até a próxima ação. Reiniciar o serviço perde
   * só isso; o status e o detalhe persistentes ficam na própria loja.
   */
  const lastReports = new Map<string, ConnectionReport>();

  function notFound(c: Context<AdminEnv>): Response | Promise<Response> {
    return errorPage(c, 404, 'Loja não encontrada', 'Essa loja não existe ou já foi removida.', c.get('session'));
  }

  function renderDetail(c: Context<AdminEnv>, store: Store, opts: { values?: StoreFormValues; error?: string; status?: 200 | 400 | 409 } = {}) {
    const body = detailBody(deps, c, store, {
      report: lastReports.get(store.id) ?? null,
      values: opts.values ?? formValuesFromStore(store),
      error: opts.error ?? null,
    });
    return c.html(
      page({ title: `${ROLE_LABEL[store.role]}: ${store.name}`, active: 'stores', session: c.get('session'), flash: takeFlash(c), body }),
      opts.status ?? 200,
    );
  }

  function renderNew(c: Context<AdminEnv>, values: StoreFormValues, error: string | null, status: 200 | 400 | 409) {
    const body = addStoreBody(deps, values, error, csrfField(c.get('session')));
    return c.html(
      page({
        title: 'Adicionar Loja',
        description: 'Conecte uma nova loja Shopify à sua biblioteca.',
        active: 'stores',
        session: c.get('session'),
        flash: takeFlash(c),
        host: new URL(deps.config.publicBaseUrl).host,
        body,
      }),
      status,
    );
  }

  /** Vitrine recém-conectada: tenta gravar o script no tema (se o app tiver write_themes). */
  async function autoInstallTheme(store: Store): Promise<string | null> {
    if (deps.themeInstaller === undefined || store.role !== 'vitrine') return null;
    const result = await deps.themeInstaller.install(store, deps.renderSnippets(store).inline);
    audit(deps, 'store.install_theme', 'store', store.id, { ok: result.ok, theme: result.themeName, action: result.action, auto: true });
    return result.ok ? `Script instalado no tema ${result.themeName ?? ''}.` : `Script não instalado no tema (${result.detail}). Use o bloco na página da loja.`;
  }

  async function connectAndRemember(storeId: string): Promise<ConnectionReport> {
    const report = await deps.connection.connect(storeId);
    lastReports.set(storeId, report);
    return report;
  }

  app.get('/', (c) => {
    const stores = repos.stores.list();
    const vitrines = stores.filter((s) => s.role === 'vitrine');
    const checkouts = stores.filter((s) => s.role === 'checkout');
    const session = c.get('session');
    // Vendas dos últimos 30 dias por loja checkout, para o cartão (sem dados do comprador).
    const since = new Date((deps.clock ?? systemClock).now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const until = (deps.clock ?? systemClock).now().toISOString();
    const salesByStore = new Map(repos.orders.stats({ since, until }).byCheckoutStore.map((row) => [row.storeId, row]));
    const checkoutExtra = (store: Store): Markup => {
      const row = salesByStore.get(store.id);
      const revenue = row === undefined ? '—' : Object.entries(row.revenueByCurrency).map(([cur, amt]) => fmtMoney(amt, cur)).join(' · ');
      return html`<dl class="tile-meta tile-meta-sales">
        <dt>${icon('bag')} Pedidos (30 dias)</dt><dd class="num">${row?.orders ?? 0}</dd>
        <dt>${icon('cash')} Faturamento (30 dias)</dt><dd class="num">${revenue}</dd>
      </dl>`;
    };
    const body = html`<div class="columns">
      <section class="card store-section">
        <div class="section-head"><div class="store-id"><span class="card-icon">${icon('bag')}</span><div><h2>Vitrines</h2><div class="muted">Origem dos produtos e da experiência de compra</div></div></div><span class="count-pill">${vitrines.length}</span></div>
        <div class="column">${storeCards(vitrines, 'vitrine', () => html``, session)}</div>
      </section>
      <section class="card store-section">
        <div class="section-head"><div class="store-id"><span class="card-icon teal">${icon('store')}</span><div><h2>Lojas de checkout</h2><div class="muted">Destinos conectados às rotas e aos pagamentos</div></div></div><span class="count-pill">${checkouts.length}</span></div>
        <div class="column">${storeCards(checkouts, 'checkout', checkoutExtra, session)}</div>
      </section>
    </div>`;
    return c.html(
      page({
        title: 'Minhas Lojas',
        description: 'Centralize conexões, saúde e dados operacionais das suas lojas.',
        actions: html`<span class="pill"><strong>${stores.length}</strong> lojas</span><span class="pill"><strong>${vitrines.length}</strong> vitrine${vitrines.length === 1 ? '' : 's'}</span><span class="pill"><strong>${checkouts.length}</strong> checkout${checkouts.length === 1 ? '' : 's'}</span>
          <a class="btn" href="/admin/stores/new">${icon('plus')}<span>Adicionar Loja</span></a>`,
        active: 'stores',
        session,
        flash: takeFlash(c),
        host: new URL(deps.config.publicBaseUrl).host,
        body,
      }),
    );
  });

  app.get('/new', (c) =>
    renderNew(c, { role: '', name: '', shopDomain: '', clientId: '', publicDomain: '', proxyPath: '', storefrontAuthMode: 'tokenless' }, null, 200),
  );

  app.post('/', async (c) => {
    const form = await readForm(c);
    const parsed = parseNewStore(form);
    if (!parsed.ok) return renderNew(c, formValuesFrom(form), parsed.message, 400);
    let store: Store;
    try {
      store = repos.stores.create(parsed.value);
    } catch (err) {
      const { message, status } = describeError(err);
      return renderNew(c, formValuesFrom(form), message, status);
    }
    audit(deps, 'store.create', 'store', store.id, {
      role: store.role,
      shopDomain: store.shopDomain,
      storefrontAuthMode: store.storefrontAuthMode,
      hasStorefrontToken: store.hasStorefrontToken,
    });
    const report = await connectAndRemember(store.id);
    const themeNote = report.ok ? await autoInstallTheme(repos.stores.get(store.id) ?? store) : null;
    setFlash(c, {
      kind: report.ok ? 'ok' : 'error',
      text: report.ok ? `Loja cadastrada e conectada.${themeNote === null ? '' : ` ${themeNote}`}` : 'Loja cadastrada, mas a conexão falhou. Veja o relatório abaixo.',
    });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.get('/:id', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    return renderDetail(c, store);
  });

  app.post('/:id', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    const form = await readForm(c);
    const parsed = parseStorePatch(form, store);
    if (!parsed.ok) return renderDetail(c, store, { values: formValuesFrom(form), error: parsed.message, status: 400 });
    try {
      repos.stores.update(store.id, parsed.value.patch);
    } catch (err) {
      const { message, status } = describeError(err);
      return renderDetail(c, store, { values: formValuesFrom(form), error: message, status });
    }
    if (parsed.value.credentialsChanged) deps.tokens.invalidate(store.id);
    // Só os NOMES dos campos alterados: nunca o valor de um segredo.
    audit(deps, 'store.update', 'store', store.id, { changed: parsed.value.changed, credentialsChanged: parsed.value.credentialsChanged });
    setFlash(c, {
      kind: 'ok',
      text: parsed.value.credentialsChanged ? 'Loja salva. Credenciais alteradas: use "Conectar" para validá-las.' : 'Loja salva.',
    });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.post('/:id/install-theme', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    if (deps.themeInstaller === undefined || store.role !== 'vitrine') return notFound(c);
    const form = await readForm(c);
    const result = await deps.themeInstaller.install(store, deps.renderSnippets(store).inline);
    audit(deps, 'store.install_theme', 'store', store.id, { ok: result.ok, theme: result.themeName, action: result.action });
    setFlash(c, { kind: result.ok ? 'ok' : 'error', text: result.ok ? `Script instalado no tema ${result.themeName ?? ''}: ${result.detail}` : `Não foi possível instalar no tema: ${result.detail}` });
    return redirectTo(c, form['return'] ?? `/admin/stores/${store.id}`);
  });

  app.post('/:id/connect', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    const report = await connectAndRemember(store.id);
    audit(deps, 'store.connect_requested', 'store', store.id, { ok: report.ok });
    setFlash(c, { kind: report.ok ? 'ok' : 'error', text: report.ok ? 'Conexão verificada com sucesso.' : 'A conexão falhou. Veja o relatório abaixo.' });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.post('/:id/sync', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    const result = await deps.sync.syncStore(store.id);
    // O recálculo vem depois do catálogo já gravado: se ele falhar, a sincronização não
    // deixa de ter acontecido. Falha vira aviso e auditoria, nunca uma página de erro que
    // levaria o lojista a repetir a leitura inteira do catálogo.
    let pairs: number | null = 0;
    if (result.ok) {
      try {
        pairs = deps.matcher.rematchStore(store.id).length;
      } catch (err) {
        pairs = null;
        deps.logger.warn({ err, storeId: store.id }, 'falha ao recalcular mapeamentos depois da sincronização');
      }
    }
    audit(deps, 'store.sync', 'store', store.id, { ok: result.ok, variants: result.variants, removed: result.removed, pairs, rematchFailed: pairs === null });
    const text = pairs === null ? `${syncSummary(result)} O recálculo dos mapeamentos falhou; use "Recalcular mapeamento" na rota mais tarde.` : syncSummary(result);
    setFlash(c, { kind: result.ok && pairs !== null ? 'ok' : 'error', text });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.post('/:id/disable', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    repos.stores.update(store.id, { status: 'disabled', statusDetail: 'Desativada pelo painel.' });
    audit(deps, 'store.disable', 'store', store.id, { previousStatus: store.status });
    setFlash(c, { kind: 'ok', text: 'Loja desativada.' });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.post('/:id/enable', (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    // Volta a 'pending', não a 'connected': as credenciais podem ter mudado enquanto a
    // loja esteve desligada, e só "Conectar" confirma que continuam válidas.
    repos.stores.update(store.id, { status: 'pending', statusDetail: null });
    audit(deps, 'store.enable', 'store', store.id, {});
    setFlash(c, { kind: 'ok', text: 'Loja reativada. Use "Conectar" para validar as credenciais e sincronizar.' });
    return redirectTo(c, `/admin/stores/${store.id}`);
  });

  app.post('/:id/delete', async (c) => {
    const store = repos.stores.get(c.req.param('id'));
    if (store === null) return notFound(c);
    const form = await readForm(c);
    const typed = normalizeShopDomain(form['confirmDomain'] ?? '');
    if (typed !== store.shopDomain) {
      return renderDetail(c, store, { error: 'Para remover a loja, digite o domínio dela exatamente como aparece acima.', status: 400 });
    }
    repos.stores.delete(store.id);
    lastReports.delete(store.id);
    deps.tokens.invalidate(store.id);
    audit(deps, 'store.delete', 'store', store.id, { role: store.role, shopDomain: store.shopDomain });
    setFlash(c, { kind: 'ok', text: `Loja ${store.name} removida.` });
    return redirectTo(c, '/admin/stores');
  });

  return app;
}
