import { z } from 'zod';
import type { Config } from '../config.ts';
import { truncate } from '../lib/http.ts';
import { CircuitOpenError, HttpStatusError, isRetryableError, TimeoutError } from '../lib/resilience.ts';
import { BridgeError, isBridgeError } from '../types.ts';
import type { AdminClient, Logger, Store, WebhookRegistrar, StoreRole } from '../types.ts';

/**
 * Assinaturas de webhook por loja, criadas pela Admin API (webhookSubscriptionCreate).
 *
 * Por que pela API e não pelo arquivo de configuração do app: cada loja tem o próprio app
 * do Dev Dashboard e o lojista não usa a Shopify CLI; a API é o caminho documentado que
 * funciona só com as credenciais já cadastradas (AC-52, AC-72).
 *
 * Consequências que quem opera precisa conhecer:
 * - Assinatura criada pela API é APAGADA pela Shopify depois de 8 falhas seguidas de
 *   entrega (AC-53, AC-64). ensure() é idempotente justamente para ser chamado de novo
 *   (a cada conexão e periodicamente) e recriar o que sumiu.
 * - A consulta webhookSubscriptions devolve só as assinaturas criadas pela API deste app;
 *   as declaradas em shopify.app.toml não aparecem. Se o lojista declarar as mesmas no
 *   TOML, haverá entrega em dobro, que o recebimento já descarta pelo id da entrega.
 * - A versão da API usada no corpo do webhook não é escolhida aqui: vale a "Webhooks API
 *   version" configurada na versão do app (AC-55).
 */

/** Valores do enum WebhookSubscriptionTopic (AC-50). */
export const WEBHOOK_TOPICS: string[] = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'];

/** Tópicos de pedido: a checkout alimenta o painel de vendas; a vitrine só detecta vazamento. */
const ORDER_TOPICS_CHECKOUT: string[] = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'];
const ORDER_TOPICS_VITRINE: string[] = ['ORDERS_CREATE'];

export function topicsForRole(role: StoreRole): string[] {
  return [...WEBHOOK_TOPICS, ...(role === 'vitrine' ? ORDER_TOPICS_VITRINE : ORDER_TOPICS_CHECKOUT)];
}

/** Caminho do recebimento, relativo à URL pública do serviço (src/routes/webhooks.ts). */
export const WEBHOOK_CALLBACK_PATH = '/webhooks/shopify';

const LIST_PAGE_SIZE = 100;
/** Um app tem poucas assinaturas por loja; o teto só impede um laço sem fim. */
const MAX_LIST_PAGES = 20;
const MAX_USER_ERRORS = 5;
const MAX_USER_ERROR_CHARS = 200;

/**
 * Campos conferidos em shopify.dev para a 2026-10: WebhookSubscription.uri (String!) é o
 * campo atual; callbackUrl e endpoint estão descontinuados e não são lidos.
 */
export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query BridgeWebhookSubscriptions($first: Int!, $after: String, $topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: $first, after: $after, topics: $topics) {
      nodes {
        id
        topic
        uri
        format
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** WebhookSubscriptionInput na 2026-10: uri (callbackUrl está descontinuado) e format. */
export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = /* GraphQL */ `
  mutation BridgeWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const listSchema = z.object({
  webhookSubscriptions: z.object({
    nodes: z.array(
      z.object({
        topic: z.string(),
        // uri é não nulo na 2026-10; aceitar ausente evita quebrar a listagem inteira por
        // causa de uma assinatura antiga em formato que não é o nosso.
        uri: z.string().nullish(),
        format: z.string().nullish(),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});

const createSchema = z.object({
  webhookSubscriptionCreate: z
    .object({
      webhookSubscription: z.object({ id: z.string().nullish() }).nullish(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullish(), message: z.string() })).nullish(),
    })
    .nullish(),
});

function malformed(what: string): BridgeError {
  return new BridgeError('upstream_rejected', `Resposta inesperada da Admin API (${what})`, {
    reason: 'malformed_response',
  });
}

/** Todo erro que sai daqui é BridgeError; detalhes de erros de terceiros não são repassados. */
function toBridgeError(err: unknown): BridgeError {
  if (isBridgeError(err)) return err;
  const cause = err instanceof Error ? err.name : typeof err;
  if (err instanceof CircuitOpenError || err instanceof TimeoutError || err instanceof HttpStatusError || isRetryableError(err)) {
    return new BridgeError('upstream_unavailable', 'Admin API indisponível', { cause });
  }
  return new BridgeError('internal', 'Falha inesperada ao registrar webhooks', { cause });
}

/**
 * Compara dois endereços de entrega ignorando diferenças que não mudam o destino (caixa do
 * host, barra final). Destinos que não são URL http(s), como Pub/Sub e EventBridge, nunca
 * são iguais ao nosso.
 */
function sameCallback(a: string, b: string): boolean {
  const parse = (value: string): string | null => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return null;
    }
  };
  const left = parse(a);
  return left !== null && left === parse(b);
}

export function createWebhookRegistrar(deps: {
  admin: AdminClient;
  config: Pick<Config, 'publicBaseUrl'>;
  logger: Logger;
}): WebhookRegistrar {
  const { admin, config, logger } = deps;

  /**
   * Tópicos (entre os nossos) que já têm assinatura JSON apontando para este serviço.
   * Assinaturas do mesmo tópico para outro endereço ou em outro formato são ignoradas:
   * não são nossas para mexer.
   */
  async function listOurs(store: Store, callbackUrl: string, topics: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const cursor: string | null = after;
      const data = await admin.graphql<unknown>(store, WEBHOOK_SUBSCRIPTIONS_QUERY, {
        first: LIST_PAGE_SIZE,
        after: cursor,
        topics,
      });
      const parsed = listSchema.safeParse(data);
      if (!parsed.success) throw malformed('assinaturas de webhook');
      const { nodes, pageInfo } = parsed.data.webhookSubscriptions;
      for (const node of nodes) {
        if (!topics.includes(node.topic)) continue;
        if (typeof node.uri !== 'string' || !sameCallback(node.uri, callbackUrl)) continue;
        if (typeof node.format === 'string' && node.format.toUpperCase() !== 'JSON') continue;
        found.add(node.topic);
      }
      if (!pageInfo.hasNextPage) return found;
      const next = pageInfo.endCursor;
      if (typeof next !== 'string' || next === '' || next === cursor) throw malformed('paginação de assinaturas');
      after = next;
    }
    logger.warn(
      { storeId: store.id, pages: MAX_LIST_PAGES },
      'listagem de assinaturas de webhook interrompida no teto de páginas',
    );
    return found;
  }

  /** Cria uma assinatura. Devolve os userErrors (vazio = criada). */
  async function createOne(store: Store, callbackUrl: string, topic: string): Promise<Array<{ field: string | null; message: string }>> {
    const data = await admin.graphql<unknown>(store, WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
      topic,
      webhookSubscription: { uri: callbackUrl, format: 'JSON' },
    });
    const parsed = createSchema.safeParse(data);
    const payload = parsed.success ? parsed.data.webhookSubscriptionCreate : null;
    if (payload === null || payload === undefined) throw malformed('criação de assinatura de webhook');
    const userErrors = (payload.userErrors ?? []).slice(0, MAX_USER_ERRORS).map((error) => ({
      field: error.field ? truncate(error.field.join('.'), 80) : null,
      message: truncate(error.message, MAX_USER_ERROR_CHARS),
    }));
    if (userErrors.length === 0 && !payload.webhookSubscription) throw malformed('criação de assinatura de webhook');
    return userErrors;
  }

  async function ensure(store: Store): Promise<{ created: string[]; existing: string[] }> {
    const callbackUrl = `${config.publicBaseUrl.replace(/\/+$/, '')}${WEBHOOK_CALLBACK_PATH}`;
    // A Shopify só entrega webhooks em HTTPS com certificado válido (AC-63). Recusar aqui
    // dá uma mensagem clara em vez de um userError genérico em cada tópico.
    if (!callbackUrl.startsWith('https://')) {
      throw new BridgeError('invalid_request', 'PUBLIC_BASE_URL precisa começar com https:// para a Shopify entregar webhooks.', {
        reason: 'callback_not_https',
      });
    }

    const created: string[] = [];
    const existing: string[] = [];
    try {
      const topics = topicsForRole(store.role);
      const ours = await listOurs(store, callbackUrl, topics);
      for (const topic of topics) {
        if (ours.has(topic)) {
          existing.push(topic);
          continue;
        }
        const userErrors = await createOne(store, callbackUrl, topic);
        if (userErrors.length === 0) {
          created.push(topic);
          continue;
        }
        // Outra execução pode ter criado a mesma assinatura entre a listagem e a criação
        // (a Shopify recusa endereço repetido para o mesmo tópico). O texto desse userError
        // não é documentado, então em vez de interpretar a mensagem a listagem é refeita.
        // PRECISA DE TESTE EM LOJA REAL: confirmar que a duplicata vem como userError.
        const now = await listOurs(store, callbackUrl, [topic]);
        if (now.has(topic)) {
          existing.push(topic);
          continue;
        }
        throw new BridgeError(
          'upstream_rejected',
          `A Shopify recusou a assinatura do webhook ${topic}: ${userErrors.map((error) => error.message).join('; ')}`,
          { reason: 'user_errors', topic, userErrors, created: [...created] },
        );
      }
    } catch (err) {
      const bridge = toBridgeError(err);
      logger.warn(
        { storeId: store.id, shopDomain: store.shopDomain, code: bridge.code, created, existing },
        'registro de webhooks falhou',
      );
      throw bridge;
    }

    if (created.length > 0) {
      logger.info({ storeId: store.id, shopDomain: store.shopDomain, created, existing }, 'assinaturas de webhook criadas');
    }
    return { created, existing };
  }

  return { ensure };
}
