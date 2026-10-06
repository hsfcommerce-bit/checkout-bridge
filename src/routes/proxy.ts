import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { isoNow, systemClock } from '../lib/clock.ts';
import { clientIpFromHeaders, newRequestId, safeJsonParse, truncate } from '../lib/http.ts';
import { peekProxyShop, verifyAppProxySignature } from '../shopify/proxy-signature.ts';
import type { ProxySignatureFailure } from '../shopify/proxy-signature.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type {
  BridgeErrorCode,
  CheckoutRequest,
  CheckoutService,
  Clock,
  Logger,
  Metrics,
  RateLimiter,
  Repos,
  RequestContext,
  Store,
} from '../types.ts';

/**
 * Rotas chamadas pelo navegador do comprador ATRAVÉS do App Proxy da Shopify
 * (https://<vitrine>/<prefixo>/<subcaminho>/... -> este serviço, em /proxy/...).
 *
 * Restrições do proxy que moldam tudo aqui:
 * - A resposta é SEMPRE 200. O proxy não repassa ao navegador o corpo de respostas de erro
 *   (relato de comunidade: um 500 virou a página HTML da loja) e "segue" 3xx de um jeito não
 *   documentado, que já foi visto resolvendo o Location contra o domínio da vitrine. O
 *   resultado de negócio viaja no corpo: { ok: true, ... } ou { ok: false, code, message }.
 * - A assinatura cobre só a query string. O corpo é dado não confiável, e a loja é decidida
 *   pelo `shop` assinado, nunca por um campo do corpo.
 * - Cookies não atravessam o proxy em nenhum sentido; não há sessão aqui.
 * - A chamada é de mesma origem para o navegador (domínio da vitrine), então não há
 *   cabeçalho de CORS: emitir um só abriria a rota para outras origens.
 */

export interface ProxyRouteDeps {
  repos: Repos;
  checkout: CheckoutService;
  parseBody: (
    body: unknown,
  ) => { ok: true; value: Omit<CheckoutRequest, 'shopDomain'> } | { ok: false; message: string };
  renderScript: (store: Store, pathPrefix: string) => string;
  config: Pick<Config, 'proxySignatureMaxAgeSeconds' | 'trustedProxyHops'>;
  ipLimiter: RateLimiter;
  shopLimiter: RateLimiter;
  logger: Logger;
  metrics: Metrics;
  clock?: Clock;
}

/**
 * A aplicação principal gera um id por requisição e o guarda na variável `requestId` antes
 * de chegar aqui; a linha de acesso `http` sai com esse id. As rotas do proxy usam o MESMO
 * id no cabeçalho X-Request-Id, nos logs e no contexto do serviço, para que uma requisição
 * apareça sob um único id. Sem a variável (sub-aplicação usada sozinha), gera um.
 */
export type ProxyEnv = { Variables: { requestId?: string } };

function requestIdOf(c: Context<ProxyEnv>): string {
  const fromApp = c.get('requestId');
  return typeof fromApp === 'string' && fromApp !== '' ? fromApp : newRequestId();
}

/** Teto rígido do corpo do POST. Um carrinho real fica em poucos KB. */
const MAX_BODY_BYTES = 64 * 1024;

/** Prefixos e subcaminho que a Shopify aceita para o App Proxy (a, apps, community, tools). */
const PROXY_PATH_RE = /^\/(?:a|apps|community|tools)\/[A-Za-z0-9_-]{1,30}$/;

type AuthFailureReason =
  | ProxySignatureFailure
  | 'unknown_store'
  | 'wrong_role'
  | 'store_disabled'
  | 'store_lookup_failed'
  | 'shop_mismatch';

type ProxyAuth =
  | { ok: true; store: Store; shop: string; pathPrefix: string }
  | { ok: false; reason: AuthFailureReason; claimedShop: string | null };

type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' | 'encoding' };

/**
 * Query string exatamente como chegou, sem passar por URLSearchParams (que descartaria a
 * distinção entre "+" e "%20" e não deixa ver repetições na ordem original).
 */
function rawQueryOf(url: string): string {
  const start = url.indexOf('?');
  if (start === -1) return '';
  const hash = url.indexOf('#', start);
  return hash === -1 ? url.slice(start + 1) : url.slice(start + 1, hash);
}

function publicMessage(code: BridgeErrorCode): string {
  return new BridgeError(code).publicMessage;
}

function jsonResponse(body: Record<string, unknown>, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Correlação com o log sem expor nada; não está na lista de cabeçalhos que o proxy remove.
      'X-Request-Id': requestId,
    },
  });
}

function failureResponse(code: BridgeErrorCode, requestId: string): Response {
  return jsonResponse({ ok: false, code, message: publicMessage(code) }, requestId);
}

function scriptResponse(source: string, cacheable: boolean): Response {
  return new Response(source, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Falha nunca fica em cache: o comprador ficaria cinco minutos sem o script.
      'Cache-Control': cacheable ? 'public, max-age=300' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Lê o corpo como texto com teto em bytes. Confere o Content-Length declarado e também
 * conta o que realmente chega, porque o cabeçalho pode faltar ou mentir.
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get('content-length')?.trim();
  if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  const stream = request.body;
  if (!stream) return { ok: true, text: '' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: 'encoding' };
  }
}

/** Só o tipo de mídia, sem parâmetros ("application/json; charset=utf-8" -> "application/json"). */
function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function errorSummary(err: unknown): { errName: string; errMessage: string } {
  if (err instanceof Error) return { errName: err.name, errMessage: truncate(err.message, 300) };
  return { errName: typeof err, errMessage: '' };
}

type Admission =
  | { ok: true; store: Store; shop: string; pathPrefix: string; buyerIp: string | null }
  | { ok: false; code: 'unauthorized' | 'rate_limited'; log: Record<string, unknown> };

type CheckoutOutcome =
  | { code: 'ok'; checkoutUrl: string; sessionId: string; log: Record<string, unknown> }
  | { code: BridgeErrorCode; log: Record<string, unknown> };

export function createProxyRoutes(deps: ProxyRouteDeps): Hono<ProxyEnv> {
  const clock = deps.clock ?? systemClock;
  const { logger, metrics } = deps;

  /**
   * O `shop` não verificado serve só para achar a loja e o segredo dela; a decisão vale
   * depois que a assinatura fecha com esse segredo e o `shop` assinado é o da loja achada.
   */
  function authenticate(url: string): ProxyAuth {
    const rawQuery = rawQueryOf(url);
    const window = { maxAgeSeconds: deps.config.proxySignatureMaxAgeSeconds, now: clock.now() };
    const claimedShop = peekProxyShop(rawQuery);
    if (claimedShop === null) {
      // Sem segredo a verificação para em 'bad_signature' no máximo; ela é usada aqui só
      // para dar ao log e à métrica o motivo exato (malformada, faltando, repetido).
      const probe = verifyAppProxySignature(rawQuery, '', window);
      const reason = probe.ok || probe.reason === 'bad_signature' ? 'invalid_shop' : probe.reason;
      return { ok: false, reason, claimedShop: null };
    }

    let store: Store | null;
    let secret = '';
    try {
      store = deps.repos.stores.getByShopDomain(claimedShop);
      if (store && store.role === 'vitrine' && store.status !== 'disabled') {
        secret = deps.repos.stores.getSecrets(store.id).clientSecret;
      }
    } catch (err) {
      logger.error({ claimedShop, ...errorSummary(err) }, 'proxy: falha ao ler a loja ou o segredo dela');
      return { ok: false, reason: 'store_lookup_failed', claimedShop };
    }
    if (!store) return { ok: false, reason: 'unknown_store', claimedShop };
    // Loja checkout não recebe tráfego de comprador pelo proxy: só vitrine tem script no tema.
    if (store.role !== 'vitrine') return { ok: false, reason: 'wrong_role', claimedShop };
    if (store.status === 'disabled') return { ok: false, reason: 'store_disabled', claimedShop };

    // A documentação não diz qual segredo assina o proxy durante a rotação do client secret
    // (o contrato guarda um só por loja). Precisa de teste em loja real: trocar o segredo
    // no painel logo depois de rotacionar na Shopify, antes de revogar o antigo.
    const result = verifyAppProxySignature(rawQuery, secret, window);
    if (!result.ok) return { ok: false, reason: result.reason, claimedShop };
    if (result.shop !== store.shopDomain) return { ok: false, reason: 'shop_mismatch', claimedShop };
    return { ok: true, store, shop: result.shop, pathPrefix: result.pathPrefix };
  }

  /** Autenticação e, quando `limited`, os dois limites de taxa (nessa ordem). */
  function admit(c: Context<ProxyEnv>, limited: boolean): Admission {
    const auth = authenticate(c.req.url);
    if (!auth.ok) {
      metrics.inc('bridge_proxy_auth_failures_total', { reason: auth.reason });
      // O motivo fica só no log e na métrica; a resposta não diz por que recusou.
      return { ok: false, code: 'unauthorized', log: { claimedShop: auth.claimedShop, reason: auth.reason } };
    }
    // O App Proxy da Shopify acrescenta a X-Forwarded-For o IP do comprador [SC-61], e o
    // proxy reverso do operador acrescenta depois o IP da Shopify: o comprador é o item
    // TRUSTED_PROXY_HOPS + 1 a contar da direita. Qualquer coisa mais à esquerda foi escrita
    // pelo navegador e é ignorada. O valor serve para limitar taxa, para o hash de IP da
    // sessão e para o cabeçalho de IP do comprador na Storefront API, nunca para autorizar.
    const buyerIp = clientIpFromHeaders(c.req.raw.headers, deps.config.trustedProxyHops + 1);
    if (limited) {
      // IP primeiro: um comprador insistente não gasta a cota da loja inteira.
      if (buyerIp !== null && !deps.ipLimiter.take(`${auth.shop}:${buyerIp}`).allowed) {
        metrics.inc('bridge_proxy_rate_limited_total', { scope: 'ip' });
        return { ok: false, code: 'rate_limited', log: { shop: auth.shop, reason: 'ip' } };
      }
      if (!deps.shopLimiter.take(auth.shop).allowed) {
        metrics.inc('bridge_proxy_rate_limited_total', { scope: 'shop' });
        return { ok: false, code: 'rate_limited', log: { shop: auth.shop, reason: 'shop' } };
      }
    }
    return { ok: true, store: auth.store, shop: auth.shop, pathPrefix: auth.pathPrefix, buyerIp };
  }

  async function runCheckout(c: Context<ProxyEnv>, requestId: string): Promise<CheckoutOutcome> {
    const admission = admit(c, true);
    if (!admission.ok) return { code: admission.code, log: admission.log };
    const { shop, buyerIp } = admission;
    const invalid = (reason: string, detail?: string): CheckoutOutcome => ({
      code: 'invalid_request',
      log: detail === undefined ? { shop, reason } : { shop, reason, detail },
    });

    if (mediaType(c.req.header('content-type')) !== 'application/json') return invalid('content_type');
    const body = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
    if (!body.ok) return invalid(`body_${body.reason}`);
    const json = safeJsonParse(body.text);
    if (!json.ok) return invalid('json');
    const parsed = deps.parseBody(json.value);
    if (!parsed.ok) return invalid('schema', truncate(parsed.message, 200));

    // shopDomain por último: um campo "shopDomain" que tenha sobrado do corpo nunca vence o assinado.
    const request: CheckoutRequest = { ...parsed.value, shopDomain: shop };
    const userAgent = c.req.header('user-agent');
    const ctx: RequestContext = {
      requestId,
      buyerIp,
      userAgent: userAgent === undefined || userAgent === '' ? null : truncate(userAgent, 300),
    };
    try {
      const result = await deps.checkout.createCheckout(request, ctx);
      return {
        code: 'ok',
        checkoutUrl: result.checkoutUrl,
        sessionId: result.sessionId,
        // A URL do checkout não vai para o log: pode carregar a chave do carrinho.
        log: { shop, sessionId: result.sessionId, strategy: result.strategy, reused: result.reused },
      };
    } catch (err) {
      // details do BridgeError ficam com quem lançou (o serviço loga o que for seguro).
      if (isBridgeError(err)) return { code: err.code, log: { shop } };
      return { code: 'internal', log: { shop, ...errorSummary(err) } };
    }
  }

  async function handleCheckout(c: Context<ProxyEnv>): Promise<Response> {
    const requestId = requestIdOf(c);
    const started = performance.now();
    let outcome: CheckoutOutcome;
    try {
      outcome = await runCheckout(c, requestId);
    } catch (err) {
      outcome = { code: 'internal', log: errorSummary(err) };
    }
    const ms = Math.round(performance.now() - started);
    const result = outcome.code === 'ok' ? 'ok' : 'error';
    metrics.inc('bridge_checkout_requests_total', { result, code: outcome.code });
    metrics.observe('bridge_checkout_request_ms', ms, { result });
    // Uma linha por requisição, sem query string (tem a assinatura), sem corpo e sem IP.
    const entry = { requestId, route: 'checkout', code: outcome.code, ms, ...outcome.log };
    if (outcome.code === 'ok') logger.info(entry, 'proxy: checkout criado');
    else if (outcome.code === 'internal') logger.error(entry, 'proxy: erro inesperado no checkout');
    else logger.warn(entry, 'proxy: checkout recusado');

    if (outcome.code !== 'ok') return failureResponse(outcome.code, requestId);
    return jsonResponse({ ok: true, checkoutUrl: outcome.checkoutUrl, sessionId: outcome.sessionId }, requestId);
  }

  function handlePing(c: Context<ProxyEnv>): Response {
    const requestId = requestIdOf(c);
    const admission = admit(c, true);
    if (!admission.ok) {
      logger.warn({ requestId, route: 'ping', code: admission.code, ...admission.log }, 'proxy: ping recusado');
      return failureResponse(admission.code, requestId);
    }
    logger.debug({ requestId, route: 'ping', code: 'ok', shop: admission.shop }, 'proxy: ping');
    return jsonResponse({ ok: true, shop: admission.shop, at: isoNow(clock) }, requestId);
  }

  /**
   * Sem limite de taxa: o script é pedido a cada página vista, é barato de gerar e não pode
   * consumir a cota de checkouts da loja. Uma recusa aqui deixaria o comprador sem o script,
   * ou seja, no checkout nativo da vitrine. Falhas respondem 200 com um comentário, porque
   * o navegador vai executar o corpo como JavaScript.
   */
  function handleScript(c: Context<ProxyEnv>): Response {
    const requestId = requestIdOf(c);
    try {
      const admission = admit(c, false);
      if (!admission.ok) {
        logger.warn({ requestId, route: 'bridge.js', code: admission.code, ...admission.log }, 'proxy: script recusado');
        return scriptResponse('/* checkout-bridge: requisição não autorizada */\n', false);
      }
      // path_prefix assinado é o caminho realmente em uso na loja (o lojista pode trocá-lo
      // no admin da Shopify); o cadastrado no painel fica como reserva se vier fora do padrão.
      const pathPrefix = PROXY_PATH_RE.test(admission.pathPrefix) ? admission.pathPrefix : admission.store.proxyPath;
      if (pathPrefix === null) {
        logger.warn({ requestId, route: 'bridge.js', code: 'invalid_request', shop: admission.shop }, 'proxy: caminho do proxy desconhecido');
        return scriptResponse('/* checkout-bridge: caminho do proxy desconhecido */\n', false);
      }
      const source = deps.renderScript(admission.store, pathPrefix);
      logger.debug({ requestId, route: 'bridge.js', code: 'ok', shop: admission.shop }, 'proxy: script servido');
      return scriptResponse(source, true);
    } catch (err) {
      logger.error({ requestId, route: 'bridge.js', code: 'internal', ...errorSummary(err) }, 'proxy: erro ao gerar o script');
      return scriptResponse('/* checkout-bridge: erro ao gerar o script */\n', false);
    }
  }

  const app = new Hono<ProxyEnv>();
  // O proxy da Shopify já foi visto encaminhando com barra final (relato de comunidade, não
  // documentado). As duas formas são registradas para responder direto, sem redirecionar.
  for (const suffix of ['', '/']) {
    app.get(`/ping${suffix}`, handlePing);
    app.get(`/bridge.js${suffix}`, handleScript);
    app.post(`/checkout${suffix}`, handleCheckout);
  }
  // Caminho ou método desconhecido e exceção não tratada também respondem 200 com JSON:
  // um 404 ou 500 chegaria ao navegador como a página HTML da loja.
  app.all('*', (c) => failureResponse('not_found', requestIdOf(c)));
  app.onError((err, c) => {
    const requestId = requestIdOf(c);
    logger.error({ requestId, route: 'proxy', code: 'internal', ...errorSummary(err) }, 'proxy: exceção não tratada');
    return failureResponse('internal', requestId);
  });
  return app;
}
