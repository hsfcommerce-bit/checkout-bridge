import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AdminAuth } from '../../admin/auth.ts';
import type { ThemeInstaller } from '../../shopify/theme-install.ts';
import type { Config } from '../../config.ts';
import { hmacSha256Hex, timingSafeEqualStr } from '../../lib/crypto.ts';
import { safeJsonParse, truncate } from '../../lib/http.ts';
import { BridgeError } from '../../types.ts';
import type {
  AdminSession,
  AdminTokenProvider,
  CatalogSyncService,
  CheckoutService,
  Clock,
  Logger,
  MatchService,
  Repos,
  Store,
  StoreConnectionService,
} from '../../types.ts';
import { page } from './layout.ts';

/**
 * Peças comuns às rotas do painel: dependências, sessão obrigatória com CSRF, leitura de
 * formulário, mensagem de uma só exibição (flash), redirecionamento e auditoria.
 */

export interface AdminDeps {
  repos: Repos;
  auth: AdminAuth;
  connection: StoreConnectionService;
  sync: CatalogSyncService;
  matcher: MatchService;
  checkout: CheckoutService;
  tokens: AdminTokenProvider;
  renderSnippets: (store: Store) => { inline: string; loader: string };
  /** Instalação automática do script no tema (opcional: sem ele, só a colagem manual). */
  themeInstaller?: ThemeInstaller;
  config: Config;
  logger: Logger;
  clock?: Clock;
}

export type AdminEnv = { Variables: { session: AdminSession } };

export type Flash = { kind: 'ok' | 'error'; text: string };

/** Métodos que não alteram estado e por isso dispensam o token de CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const MAX_FORM_BYTES = 64 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

const FLASH_COOKIE = 'cb_flash';
const FLASH_MAX_AGE_SECONDS = 60;
const FLASH_MAX_CHARS = 300;
const FLASH_ATTRIBUTES = 'Path=/admin; HttpOnly; SameSite=Strict';

/**
 * Chave que assina o cookie de flash, sorteada a cada início do processo. O cookie vive
 * no máximo um minuto e só carrega um texto de interface; a assinatura existe para que um
 * cookie plantado por outra página do mesmo site não consiga exibir texto arbitrário
 * dentro do painel. Reiniciar o serviço só faz perder uma mensagem pendente.
 */
const FLASH_KEY = randomBytes(32);

/** Página de erro com a moldura do painel. Com `session` nula não mostra o menu. */
export function errorPage(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  message: string,
  session: AdminSession | null,
): Response | Promise<Response> {
  const body = html`<div class="card">
    <p>${message}</p>
    <p><a href="/admin">Voltar ao painel</a></p>
  </div>`;
  return c.html(page({ title, active: null, session, body }), status);
}

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------

function formTooLarge(): BridgeError {
  return new BridgeError('invalid_request', 'Formulário maior que o limite de 64 KB');
}

/** Lê o corpo até o limite; passou disso, cancela a leitura em vez de carregar tudo. */
async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) throw formTooLarge();
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw formTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function parseForm(request: Request): Promise<Record<string, string>> {
  // Objeto sem protótipo: um campo chamado "__proto__" ou "constructor" vira só mais uma
  // chave, e ler um campo ausente dá undefined em vez de algo herdado de Object.
  const fields: Record<string, string> = Object.create(null);
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  // Só urlencoded: é o que os formulários do painel enviam. Qualquer outro tipo resulta em
  // formulário vazio, que não passa na conferência de CSRF.
  if (mediaType !== FORM_CONTENT_TYPE) return fields;
  const bytes = await readLimitedBody(request);
  const params = new URLSearchParams(new TextDecoder('utf-8').decode(bytes));
  // Campo repetido: vale o último valor.
  for (const [key, value] of params) fields[key] = value;
  return fields;
}

const formCache = new WeakMap<Request, Promise<Record<string, string>>>();

/**
 * Campos do formulário urlencoded da requisição (corpo limitado a 64 KB; acima disso
 * lança BridgeError('invalid_request')). O corpo só pode ser lido uma vez, então o
 * resultado fica guardado por requisição: o middleware de sessão lê para conferir o CSRF
 * e o handler chama de novo sem custo. Cada chamada recebe uma cópia própria, sem
 * protótipo (use form.campo ?? '' para ler).
 */
export async function readForm(c: Context): Promise<Record<string, string>> {
  const request = c.req.raw;
  let pending = formCache.get(request);
  if (pending === undefined) {
    pending = parseForm(request);
    formCache.set(request, pending);
  }
  const copy: Record<string, string> = Object.assign(Object.create(null), await pending);
  return copy;
}

// ---------------------------------------------------------------------------
// Sessão e CSRF
// ---------------------------------------------------------------------------

/**
 * Exige sessão válida. Sem sessão, redireciona para o login (303, para que um POST não
 * seja repetido lá). Em métodos que alteram estado exige também o campo _csrf do
 * formulário; SameSite=Strict no cookie já barra o envio vindo de outro site, o token é a
 * segunda barreira e não depende do navegador.
 */
export function requireSession(auth: AdminAuth): MiddlewareHandler<AdminEnv> {
  return createMiddleware<AdminEnv>(async (c, next) => {
    const session = auth.authenticate(c.req.header('cookie'));
    if (session === null) return c.redirect('/admin/login', 303);
    c.set('session', session);
    if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
      const form = await readForm(c);
      if (!auth.verifyCsrf(session, form['_csrf'])) {
        return errorPage(
          c,
          403,
          'Requisição recusada',
          'O formulário expirou ou não veio desta página. Volte, recarregue a página e tente de novo.',
          session,
        );
      }
    }
    await next();
  });
}

// ---------------------------------------------------------------------------
// Flash, redirecionamento e auditoria
// ---------------------------------------------------------------------------

/** https visto pelo navegador: direto ou informado pelo proxy na frente do serviço. */
function isSecureRequest(c: Context): boolean {
  const forwarded = (c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https') return true;
  return c.req.url.toLowerCase().startsWith('https://');
}

function flashCookie(c: Context, value: string, maxAge: number): string {
  return `${FLASH_COOKIE}=${value}; ${FLASH_ATTRIBUTES}; Max-Age=${maxAge}${isSecureRequest(c) ? '; Secure' : ''}`;
}

/** Guarda uma mensagem para a próxima página exibida (normalmente após um redirect). */
export function setFlash(c: Context, flash: Flash): void {
  const payload = JSON.stringify({
    k: flash.kind === 'ok' ? 'ok' : 'error',
    t: truncate(String(flash.text), FLASH_MAX_CHARS),
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const value = `${encoded}.${hmacSha256Hex(FLASH_KEY, encoded)}`;
  c.header('Set-Cookie', flashCookie(c, value, FLASH_MAX_AGE_SECONDS), { append: true });
}

/** Lê a mensagem pendente e apaga o cookie na mesma resposta (exibição única). */
export function takeFlash(c: Context): Flash | null {
  const raw = getCookie(c, FLASH_COOKIE);
  if (raw === undefined) return null;
  c.header('Set-Cookie', flashCookie(c, '', 0), { append: true });

  const dot = raw.indexOf('.');
  if (dot <= 0 || raw.length > 4096) return null;
  const encoded = raw.slice(0, dot);
  if (!timingSafeEqualStr(raw.slice(dot + 1), hmacSha256Hex(FLASH_KEY, encoded))) return null;
  const parsed = safeJsonParse<{ k?: unknown; t?: unknown }>(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return null;
  const { k, t } = parsed.value;
  if (typeof t !== 'string' || t === '') return null;
  return { kind: k === 'ok' ? 'ok' : 'error', text: truncate(t, FLASH_MAX_CHARS) };
}

/** Caminho dentro do painel: "/admin" sozinho ou seguido de "/", "?" ou "#". */
function isAdminPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 2000) return false;
  if (!/^\/admin(?:[/?#]|$)/.test(path)) return false;
  // Barra invertida e caracteres de controle são normalizados de formas diferentes pelos
  // navegadores; ".." sairia do painel depois da normalização.
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  const pathname = path.split(/[?#]/)[0] ?? '';
  return !pathname.split('/').includes('..');
}

/**
 * Redirect 303 (o navegador segue com GET) somente para dentro do painel. Qualquer outro
 * destino, inclusive URL absoluta ou "//host", é trocado por /admin: assim um parâmetro
 * "voltar para" manipulado nunca manda o lojista para fora.
 */
export function redirectTo(c: Context, path: string): Response {
  return c.redirect(isAdminPath(path) ? path : '/admin', 303);
}

/** Registra uma ação do painel na auditoria. Nunca lança: a ação em si já aconteceu. */
export function audit(
  deps: AdminDeps,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: Record<string, unknown>,
): void {
  try {
    deps.repos.audit.record({ actor: 'admin', action, targetType, targetId, detail: detail ?? {} });
  } catch (err) {
    deps.logger.warn({ err, action, targetType, targetId }, 'falha ao gravar auditoria do painel');
  }
}
