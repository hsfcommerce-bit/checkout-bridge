import { Hono } from 'hono';
import { createAdminAuth } from './admin/auth.ts';
import type { AdminAuth } from './admin/auth.ts';
import { createStoreConnectionService } from './catalog/connection.ts';
import { createMatchService } from './catalog/match.ts';
import { createCatalogEventQueue } from './catalog/queue.ts';
import type { QueueTimers } from './catalog/queue.ts';
import { createCatalogSyncService } from './catalog/sync.ts';
import { createWebhookRegistrar } from './catalog/webhooks.ts';
import { parseCheckoutBody } from './checkout/schema.ts';
import { createCheckoutService } from './checkout/service.ts';
import type { Config } from './config.ts';
import { openDatabase } from './db/db.ts';
import type { Db } from './db/db.ts';
import { createRepos } from './db/repos.ts';
import { migrate } from './db/schema.ts';
import { createScheduler } from './jobs/scheduler.ts';
import type { Scheduler } from './jobs/scheduler.ts';
import { createAlerter } from './lib/alerts.ts';
import { systemClock } from './lib/clock.ts';
import { createSecretBox } from './lib/crypto.ts';
import { newRequestId } from './lib/http.ts';
import { createLogger } from './lib/logger.ts';
import { createMetrics } from './lib/metrics.ts';
import { createRateLimiter } from './lib/ratelimit.ts';
import { createAdminRoutes } from './routes/admin/index.ts';
import { createHealthRoutes } from './routes/health.ts';
import { createProxyRoutes } from './routes/proxy.ts';
import { createWebhookRoutes } from './routes/webhooks.ts';
import { createAdminClient } from './shopify/admin.ts';
import { createThemeInstaller } from './shopify/theme-install.ts';
import { createAdminTokenProvider } from './shopify/auth.ts';
import { createStorefrontClient } from './shopify/storefront.ts';
import { defaultScriptConfig, renderBridgeScript, renderInlineSnippet, renderLoaderSnippet } from './theme/render.ts';
import type {
  AdminClient,
  AdminTokenProvider,
  Alerter,
  CatalogEventQueue,
  CatalogSyncService,
  CheckoutService,
  Clock,
  Logger,
  MatchService,
  Metrics,
  RateLimiter,
  Repos,
  Store,
  StoreConnectionService,
  StorefrontClient,
  WebhookRegistrar,
} from './types.ts';

/**
 * Raiz de composição: monta banco, repositórios, clientes Shopify, serviços e rotas, e
 * devolve a aplicação Hono pronta para `serve` (src/server.ts) ou para `app.request`
 * (testes de ponta a ponta).
 *
 * Tudo o que toca o mundo externo (relógio, fetch, espera, sorteio) é injetável, para que
 * os testes rodem sem rede e sem esperar; em produção valem os padrões do Node.
 */

export interface CreateAppOptions {
  config: Config;
  /** Banco já aberto (os testes passam um em memória). Sem ele o serviço abre e migra o de config. */
  db?: Db;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
  /** Espera usada nas repetições dos clientes Shopify; os testes passam uma que não espera. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Timers da fila de catálogo; os testes passam timers controláveis para disparar a releitura. */
  queueTimers?: QueueTimers;
}

export interface AppDeps {
  config: Config;
  db: Db;
  repos: Repos;
  logger: Logger;
  metrics: Metrics;
  alerter: Alerter;
  tokens: AdminTokenProvider;
  admin: AdminClient;
  storefront: StorefrontClient;
  sync: CatalogSyncService;
  matcher: MatchService;
  webhooks: WebhookRegistrar;
  connection: StoreConnectionService;
  queue: CatalogEventQueue;
  checkout: CheckoutService;
  adminAuth: AdminAuth;
  ipLimiter: RateLimiter;
  shopLimiter: RateLimiter;
  loginLimiter: RateLimiter;
  globalLoginLimiter: RateLimiter;
  scheduler: Scheduler;
  clock: Clock;
}

export interface App {
  app: Hono<AppEnv>;
  deps: AppDeps;
  /** Liga as tarefas periódicas. Idempotente. */
  start(): void;
  /**
   * Desligamento: para o agendador e a fila, espera (com teto) as releituras em curso e
   * fecha o banco se foi este módulo que o abriu. Idempotente.
   */
  close(): Promise<void>;
}

type AppEnv = { Variables: { requestId: string } };

/** Teto da espera pela fila no desligamento; depois disso o processo fecha mesmo assim. */
const QUEUE_DRAIN_TIMEOUT_MS = 10_000;
/** Tentativas de login do painel por minuto, por IP do cliente. */
const ADMIN_LOGIN_PER_MINUTE = 5;
/**
 * Tentativas de login por minuto somando todos os IPs. O IP vem de X-Forwarded-For e,
 * com o proxy reverso mal configurado (TRUSTED_PROXY_HOPS errado), pode ser forjado a cada
 * requisição; este teto vale mesmo assim.
 */
const ADMIN_LOGIN_GLOBAL_PER_MINUTE = 30;

/** Host público de uma loja checkout para o preconnect do script: domínio próprio, senão o myshopify. */
function hostOf(store: Store): string {
  return store.publicDomain ?? store.shopDomain;
}

export function createApp(opts: CreateAppOptions): App {
  const { config } = opts;
  const clock = opts.clock ?? systemClock;
  const ownsDb = opts.db === undefined;
  const db = opts.db ?? openDatabase(config.databasePath);
  if (ownsDb) migrate(db);

  const secretBox = createSecretBox(config.encryptionKey);
  const repos = createRepos(db, { secretBox, clock });
  const logger = opts.logger ?? createLogger({ level: config.logLevel, env: config.env });
  const metrics = createMetrics();
  const alerter = createAlerter({ webhookUrl: config.alertWebhookUrl, logger, fetchImpl: opts.fetchImpl, clock });

  const shopifyDeps = { logger, metrics, alerter, fetchImpl: opts.fetchImpl, clock, sleep: opts.sleep, random: opts.random };
  const tokens = createAdminTokenProvider({ stores: repos.stores, config, ...shopifyDeps });
  const admin = createAdminClient({ tokens, config, ...shopifyDeps });
  const storefront = createStorefrontClient({ stores: repos.stores, config, ...shopifyDeps });

  const sync = createCatalogSyncService({ repos, admin, logger, metrics, alerter, clock });
  const matcher = createMatchService({ repos, logger, metrics, clock });
  const webhooks = createWebhookRegistrar({ admin, config, logger });
  const connection = createStoreConnectionService({ repos, tokens, sync, matcher, webhooks, logger, clock });
  const queue = createCatalogEventQueue({ sync, matcher, logger, metrics, timers: opts.queueTimers });
  const checkout = createCheckoutService({ repos, storefront, config, logger, metrics, alerter, clock, sleep: opts.sleep });

  const loginLimiter = createRateLimiter({ capacity: ADMIN_LOGIN_PER_MINUTE, refillPerSecond: ADMIN_LOGIN_PER_MINUTE / 60, clock });
  const globalLoginLimiter = createRateLimiter({
    capacity: ADMIN_LOGIN_GLOBAL_PER_MINUTE,
    refillPerSecond: ADMIN_LOGIN_GLOBAL_PER_MINUTE / 60,
    clock,
  });
  const adminAuth = createAdminAuth({
    adminSessions: repos.adminSessions,
    audit: repos.audit,
    config,
    loginLimiter,
    globalLoginLimiter,
    logger,
    clock,
  });
  const ipLimiter = createRateLimiter({
    capacity: config.rateLimitPerIpPerMinute,
    refillPerSecond: config.rateLimitPerIpPerMinute / 60,
    clock,
  });
  const shopLimiter = createRateLimiter({
    capacity: config.rateLimitPerShopPerMinute,
    refillPerSecond: config.rateLimitPerShopPerMinute / 60,
    clock,
  });

  const scheduler = createScheduler({ repos, sync, matcher, webhooks, config, logger, metrics, clock });

  /** Hosts das lojas checkout ligadas à vitrine por rotas habilitadas (para o preconnect). */
  function checkoutHostsFor(store: Store): string[] {
    const hosts = new Set<string>();
    for (const link of repos.links.list({ vitrineStoreId: store.id, enabledOnly: true })) {
      const target = repos.stores.get(link.checkoutStoreId);
      if (target !== null) hosts.add(hostOf(target));
    }
    return [...hosts];
  }

  const renderScript = (store: Store, pathPrefix: string): string =>
    renderBridgeScript({ ...defaultScriptConfig(store, checkoutHostsFor(store)), proxyPath: pathPrefix });

  const renderSnippets = (store: Store): { inline: string; loader: string } => {
    const scriptConfig = defaultScriptConfig(store, checkoutHostsFor(store));
    return { inline: renderInlineSnippet(scriptConfig), loader: renderLoaderSnippet(scriptConfig.proxyPath) };
  };

  const app = new Hono<AppEnv>();

  // Id de requisição e uma linha de acesso por requisição. Só o CAMINHO entra no log: a
  // query string do App Proxy carrega a assinatura, e a do painel pode trazer termos de busca.
  app.use('*', async (c, next) => {
    const requestId = newRequestId();
    c.set('requestId', requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      const ms = Math.round(performance.now() - started);
      if (!c.res.headers.has('X-Request-Id')) c.res.headers.set('X-Request-Id', requestId);
      logger.info({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'http');
    }
  });

  // Erro não tratado pelas sub-aplicações: nada do erro vai para a resposta. No log vai o
  // erro inteiro (nome, mensagem e pilha, pelo serializador padrão do pino; a censura por
  // nome de campo continua valendo), senão uma exceção numa rota sem onError próprio (os
  // webhooks, por exemplo) deixaria só o nome da classe para diagnosticar.
  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? newRequestId();
    logger.error({ requestId, path: c.req.path, err, errorName: err instanceof Error ? err.name : typeof err }, 'erro não tratado');
    return c.json({ error: 'internal', message: 'Erro inesperado.' }, 500);
  });

  app.notFound((c) => c.text('Não encontrado', 404));

  app.get('/', (c) => c.redirect('/admin', 302));
  app.route(
    '/proxy',
    createProxyRoutes({ repos, checkout, parseBody: parseCheckoutBody, renderScript, config, ipLimiter, shopLimiter, logger, metrics, clock }),
  );
  app.route('/webhooks', createWebhookRoutes({ repos, queue, tokens, logger, metrics, alerter, clock }));
  app.route(
    '/admin',
    createAdminRoutes({ repos, auth: adminAuth, connection, sync, matcher, checkout, tokens, renderSnippets, themeInstaller: createThemeInstaller({ admin, logger }), config, logger, clock }),
  );
  app.route('/', createHealthRoutes({ db, metrics, config }));

  let closed = false;

  return {
    app,
    deps: {
      config,
      db,
      repos,
      logger,
      metrics,
      alerter,
      tokens,
      admin,
      storefront,
      sync,
      matcher,
      webhooks,
      connection,
      queue,
      checkout,
      adminAuth,
      ipLimiter,
      shopLimiter,
      loginLimiter,
      globalLoginLimiter,
      scheduler,
      clock,
    },
    start() {
      scheduler.start();
    },
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      queue.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUEUE_DRAIN_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([queue.idle(), deadline]);
      if (timer !== undefined) clearTimeout(timer);
      if (ownsDb) db.close();
    },
  };
}
