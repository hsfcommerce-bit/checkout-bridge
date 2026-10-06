import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { clientIpFromHeaders } from '../../lib/http.ts';
import { isBridgeError } from '../../types.ts';
import { auditPage, salesPage, sessionsPage } from './activity.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { errorPage, readForm, redirectTo, requireSession, takeFlash } from './context.ts';
import { dashboardPage } from './dashboard.ts';
import { guidePage } from './guide.ts';
import { createOperationsRoutes } from './operations.ts';
import { ADMIN_CSS, ADMIN_JS, page } from './layout.ts';
import { createLinkAdminRoutes } from './links.ts';
import { createStoreAdminRoutes } from './stores.ts';

/**
 * Painel administrativo (montado em /admin).
 *
 * Ordem das rotas importa: arquivos estáticos e login ficam antes do middleware de sessão;
 * tudo o que vem depois dele exige sessão válida e, nos POSTs, o token de CSRF.
 *
 * A CSP só permite script e estilo servidos por este mesmo serviço (os dois arquivos em
 * /admin/assets). Nenhuma página pode ter <script> ou style= embutido, e form-action
 * 'self' impede que um formulário do painel seja apontado para outro domínio.
 */

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data: https://cdn.shopify.com",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Os arquivos estáticos mudam só com uma nova versão do serviço; 5 minutos de cache bastam. */
const ASSET_CACHE_CONTROL = 'public, max-age=300';
const ASSET_SUFFIXES = ['/assets/app.css', '/assets/app.js'];

const LOGIN_ERROR_TEXT = 'Não foi possível entrar. Confira a senha e tente de novo em instantes.';

/** 200 na tela limpa, 401 com senha errada e 429 quando o limitador barrou; o texto é o mesmo. */
function loginPage(c: Context, status: 200 | 401 | 429): Response | Promise<Response> {
  const body = html`<div class="card narrow">
    ${status === 200 ? '' : html`<div class="flash flash-error" role="alert">${LOGIN_ERROR_TEXT}</div>`}
    <form method="post" action="/admin/login">
      <label class="field"><span>Senha do painel</span>
        <input type="password" name="password" autocomplete="current-password" required autofocus>
      </label>
      <button class="btn" type="submit">Entrar</button>
    </form>
  </div>`;
  return c.html(page({ title: 'Entrar', active: null, session: null, flash: takeFlash(c), body }), status);
}

export function createAdminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // Cabeçalhos de segurança em toda resposta do painel, inclusive erros e 404.
  app.use('*', async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    const isAsset = c.res.status === 200 && ASSET_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix));
    headers.set('Cache-Control', isAsset ? ASSET_CACHE_CONTROL : 'no-store');
  });

  app.onError((err, c) => {
    const session = c.get('session') ?? null;
    if (isBridgeError(err)) {
      deps.logger.warn({ err, path: c.req.path }, 'erro tratado no painel');
      // Todos os códigos de BridgeError têm corpo (nenhum é 1xx, 204 ou 304).
      return errorPage(c, err.httpStatus as ContentfulStatusCode, 'Não foi possível concluir', err.message, session);
    }
    deps.logger.error({ err, path: c.req.path }, 'erro inesperado no painel');
    return errorPage(c, 500, 'Erro inesperado', 'Algo deu errado ao processar a requisição. Tente de novo.', session);
  });

  app.get('/assets/app.css', (c) => c.body(ADMIN_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/assets/app.js', (c) => c.body(ADMIN_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));

  app.get('/login', (c) => {
    if (deps.auth.authenticate(c.req.header('cookie')) !== null) return c.redirect('/admin', 303);
    return loginPage(c, 200);
  });

  app.post('/login', async (c) => {
    const form = await readForm(c);
    // O IP só serve ao limitador; nunca é gravado. O painel é chamado direto pelo navegador
    // (sem a Shopify no meio): o cliente é o item TRUSTED_PROXY_HOPS a contar da direita.
    const ip = clientIpFromHeaders(c.req.raw.headers, deps.config.trustedProxyHops);
    const result = deps.auth.login(form['password'] ?? '', ip);
    if (!result.ok) {
      // A tela não diz se a senha estava errada ou se o limitador barrou; só o status muda.
      if (result.reason === 'rate_limited') {
        c.header('Retry-After', '60');
        return loginPage(c, 429);
      }
      return loginPage(c, 401);
    }
    c.header('Set-Cookie', result.setCookie, { append: true });
    return c.redirect('/admin', 303);
  });

  // Daqui em diante, sessão obrigatória (e CSRF nos POSTs).
  app.use('*', requireSession(deps.auth));

  app.post('/logout', (c) => {
    const { setCookie } = deps.auth.logout(c.req.header('cookie'));
    c.header('Set-Cookie', setCookie, { append: true });
    return c.redirect('/admin/login', 303);
  });

  app.get('/', (c) => dashboardPage(deps, c));
  app.get('/sessions', (c) => sessionsPage(deps, c));
  app.get('/sales', (c) => salesPage(deps, c));
  app.get('/guide', (c) => guidePage(deps, c));
  app.get('/audit', (c) => auditPage(deps, c));
  app.route('/operations', createOperationsRoutes(deps));
  app.route('/stores', createStoreAdminRoutes(deps));
  app.route('/links', createLinkAdminRoutes(deps));

  app.all('*', (c) => {
    // "/admin/" e afins: tira a barra final em vez de mostrar 404.
    const path = c.req.path;
    if (c.req.method === 'GET' && path.length > 1 && path.endsWith('/')) return redirectTo(c, path.slice(0, -1));
    return errorPage(c, 404, 'Página não encontrada', 'Esse endereço não existe no painel.', c.get('session'));
  });

  return app;
}
