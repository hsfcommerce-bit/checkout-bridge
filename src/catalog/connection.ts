import { systemClock } from '../lib/clock.ts';
import { truncate } from '../lib/http.ts';
import { normalizeShopDomain } from '../lib/shop.ts';
import { isBridgeError } from '../types.ts';
import type {
  AdminTokenProvider,
  CatalogSyncService,
  Clock,
  ConnectionReport,
  ConnectionStep,
  ConnectionStepName,
  Logger,
  MatchService,
  Repos,
  ShopInfo,
  Store,
  StoreConnectionService,
  StorePatch,
  WebhookRegistrar,
} from '../types.ts';
import { missingScopes, REQUIRED_SCOPES } from './scopes.ts';

/**
 * Conexão de uma loja: o "testar e ativar" do painel.
 *
 * As etapas rodam em ordem e cada uma vira uma linha do relatório, com texto para o
 * lojista. Só a falha das credenciais interrompe o fluxo (sem token nada mais funciona, e
 * credenciais de OUTRA loja fariam o catálogo errado ser sincronizado). As demais falhas
 * são relatadas e o fluxo segue, para o lojista ver todos os problemas de uma vez.
 *
 * O que decide o status final: credenciais válidas, catálogo sincronizado e nenhum escopo
 * faltando. Webhooks e mapeamentos são acessórios (a sincronização periódica cobre os
 * primeiros; os segundos são recalculados a cada mudança de catálogo) e viram só aviso.
 */

const STEP_ORDER: ConnectionStepName[] = ['credentials', 'scopes', 'webhooks', 'catalog', 'mappings'];

const STEP_LABEL: Record<ConnectionStepName, string> = {
  credentials: 'credenciais',
  scopes: 'escopos',
  webhooks: 'webhooks',
  catalog: 'catálogo',
  mappings: 'mapeamentos',
};

const MAX_ERROR_CHARS = 300;
const MAX_STATUS_DETAIL_CHARS = 600;

/**
 * Texto de uma falha para o painel. A mensagem de um BridgeError é escrita pelos nossos
 * módulos (já sem segredos, com o status e o código da Shopify) e ajuda o lojista; a de
 * qualquer outro erro pode trazer trechos de resposta e fica só no nome, no log.
 */
function describeError(err: unknown): string {
  if (!isBridgeError(err)) return 'Erro interno inesperado.';
  const own = err.message !== '' && err.message !== err.code ? ` ${truncate(err.message, MAX_ERROR_CHARS)}` : '';
  switch (err.code) {
    case 'upstream_unavailable':
    case 'rate_limited':
      return `A Shopify não respondeu (rede, tempo limite ou limite de requisições). Tente novamente em instantes.${own}`;
    case 'upstream_rejected':
    case 'unauthorized':
    case 'forbidden':
      return `A Shopify recusou a requisição.${own}`;
    case 'store_not_found':
      return 'Loja não encontrada.';
    default:
      return `Erro interno.${own}`;
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createStoreConnectionService(deps: {
  repos: Repos;
  tokens: AdminTokenProvider;
  sync: CatalogSyncService;
  matcher: MatchService;
  webhooks: WebhookRegistrar;
  logger: Logger;
  clock?: Clock;
}): StoreConnectionService {
  const { repos, tokens, sync, matcher, webhooks, logger } = deps;
  const clock = deps.clock ?? systemClock;

  /** Uma conexão por loja de cada vez; um segundo clique no painel espera a mesma execução. */
  const running = new Map<string, Promise<ConnectionReport>>();

  /** Atualização que não pode derrubar o fluxo (a loja pode ter sido apagada no meio). */
  function tryUpdate(storeId: string, patch: StorePatch, what: string): Store | null {
    try {
      return repos.stores.update(storeId, patch);
    } catch (err) {
      logger.warn({ storeId, what, errorName: errorName(err), code: isBridgeError(err) ? err.code : undefined }, 'conexão: atualização da loja falhou');
      return null;
    }
  }

  async function checkCredentials(store: Store): Promise<{ step: ConnectionStep; shop: ShopInfo | null; store: Store }> {
    const fail = (detail: string): { step: ConnectionStep; shop: null; store: Store } => ({
      step: { name: 'credentials', ok: false, detail },
      shop: null,
      store,
    });
    let shop: ShopInfo;
    try {
      // Credenciais recém-salvas no painel precisam valer agora, não quando o token em
      // cache expirar.
      tokens.invalidate(store.id);
      shop = await sync.fetchShopInfo(store);
    } catch (err) {
      logger.warn({ storeId: store.id, errorName: errorName(err), code: isBridgeError(err) ? err.code : undefined }, 'conexão: validação das credenciais falhou');
      return fail(
        `${describeError(err)} Confira o domínio myshopify.com, o Client ID e o Client secret, se o app tem uma versão lançada e se está instalado nesta loja.`,
      );
    }

    const reported = typeof shop.myshopifyDomain === 'string' ? shop.myshopifyDomain.trim().toLowerCase() : '';
    const answered = normalizeShopDomain(reported) ?? reported;
    if (answered === '' || answered !== store.shopDomain) {
      // Não segue: sincronizar o catálogo de outra loja sob este cadastro venderia os
      // produtos errados.
      return fail(
        `As credenciais respondem por outra loja (${truncate(answered === '' ? 'domínio não informado' : answered, 100)}), não por ${store.shopDomain}. ` +
          'Corrija o domínio myshopify.com cadastrado ou use as credenciais do app instalado nesta loja.',
      );
    }

    let current = store;
    if (store.currency !== shop.currency) {
      current = tryUpdate(store.id, { currency: shop.currency }, 'currency') ?? current;
    }
    // Um domínio público já preenchido nunca é trocado: pode ter sido escolhido à mão.
    if (current.publicDomain === null && shop.primaryDomainHost !== null && shop.primaryDomainHost !== '') {
      current = tryUpdate(store.id, { publicDomain: shop.primaryDomainHost }, 'publicDomain') ?? current;
    }
    return {
      step: { name: 'credentials', ok: true, detail: `Credenciais válidas. Loja "${truncate(shop.name, 80)}", moeda ${shop.currency}.` },
      shop,
      store: current,
    };
  }

  async function checkScopes(store: Store): Promise<{ step: ConnectionStep; missing: string[] }> {
    try {
      const granted = await tokens.getScopes(store);
      const missing = missingScopes(store.role, granted);
      if (missing.length === 0) {
        return {
          step: { name: 'scopes', ok: true, detail: `Escopos necessários concedidos (${REQUIRED_SCOPES[store.role].join(', ')}).` },
          missing,
        };
      }
      // Mudança de escopo não vale sozinha: precisa de versão nova lançada e de aprovação
      // em cada loja (SC-27, SC-28).
      return {
        step: {
          name: 'scopes',
          ok: false,
          detail:
            `Escopos ausentes: ${missing.join(', ')}. Adicione-os aos escopos do app no Dev Dashboard, lance uma nova versão, ` +
            'aprove a alteração no admin desta loja e conecte novamente.',
        },
        missing,
      };
    } catch (err) {
      logger.warn({ storeId: store.id, errorName: errorName(err), code: isBridgeError(err) ? err.code : undefined }, 'conexão: leitura dos escopos falhou');
      return {
        step: { name: 'scopes', ok: false, detail: `Não foi possível ler os escopos concedidos. ${describeError(err)}` },
        missing: [],
      };
    }
  }

  async function ensureWebhooks(store: Store): Promise<ConnectionStep> {
    try {
      const result = await webhooks.ensure(store);
      return {
        name: 'webhooks',
        ok: true,
        detail: `Webhooks ativos: ${result.created.length} criado(s) agora, ${result.existing.length} já existente(s).`,
      };
    } catch (err) {
      return {
        name: 'webhooks',
        ok: false,
        detail:
          `Não foi possível registrar os webhooks. ${describeError(err)} ` +
          'Sem eles o catálogo só é atualizado pela sincronização periódica; conecte novamente depois de corrigir.',
      };
    }
  }

  async function syncCatalog(storeId: string): Promise<ConnectionStep> {
    try {
      const result = await sync.syncStore(storeId);
      if (result.ok) {
        return {
          name: 'catalog',
          ok: true,
          detail: `Catálogo sincronizado: ${result.variants} variante(s) lida(s), ${result.removed} removida(s).`,
        };
      }
      return {
        name: 'catalog',
        ok: false,
        detail: `${result.detail ?? 'A sincronização do catálogo falhou.'} Conecte novamente; se o erro persistir, confira o escopo read_products.`,
      };
    } catch (err) {
      // O contrato diz que syncStore não lança; se lançar, vira falha da etapa.
      return { name: 'catalog', ok: false, detail: `A sincronização do catálogo falhou. ${describeError(err)}` };
    }
  }

  function rematch(storeId: string): ConnectionStep {
    try {
      const summaries = matcher.rematchStore(storeId);
      if (summaries.length === 0) {
        return { name: 'mappings', ok: true, detail: 'Nenhuma rota usa esta loja ainda; não há mapeamentos para recalcular.' };
      }
      const sum = { active: 0, review: 0, unmapped: 0, divergent: 0 };
      for (const summary of summaries) {
        sum.active += summary.counts.active;
        sum.review += summary.counts.suggested + summary.counts.conflict;
        sum.unmapped += summary.counts.unmapped;
        sum.divergent += summary.counts.divergent;
      }
      return {
        name: 'mappings',
        ok: true,
        detail:
          `Mapeamentos recalculados em ${summaries.length} rota(s): ${sum.active} ativo(s), ${sum.review} aguardando revisão, ` +
          `${sum.unmapped} sem correspondência, ${sum.divergent} com divergência.`,
      };
    } catch (err) {
      logger.warn({ storeId, errorName: errorName(err), code: isBridgeError(err) ? err.code : undefined }, 'conexão: recálculo dos mapeamentos falhou');
      return { name: 'mappings', ok: false, detail: `Não foi possível recalcular os mapeamentos. ${describeError(err)}` };
    }
  }

  /** Relatório em que só a primeira etapa rodou (ou nem ela): as demais aparecem como não executadas. */
  function abortedSteps(first: ConnectionStep, reason: string): ConnectionStep[] {
    return STEP_ORDER.map((name) => (name === first.name ? first : { name, ok: false, detail: `Não executada: ${reason}` }));
  }

  /**
   * Fecha a conexão: decide o status, grava na loja e registra a auditoria. Nenhuma dessas
   * gravações pode impedir o relatório de voltar para quem chamou.
   */
  function finalize(
    storeId: string,
    steps: ConnectionStep[],
    missing: string[],
    shop: ShopInfo | null,
    startedMs: number,
  ): ConnectionReport {
    const stepOk = (name: ConnectionStepName): boolean => steps.find((step) => step.name === name)?.ok === true;
    const ok = stepOk('credentials') && stepOk('catalog') && missing.length === 0;
    const failed = steps.filter((step) => !step.ok);
    const describe = (step: ConnectionStep): string => `Etapa "${STEP_LABEL[step.name]}": ${step.detail}`;

    let statusDetail: string | null = null;
    let firstFailed: ConnectionStepName | null = null;
    if (!ok) {
      // A primeira etapa que de fato impede a conexão; um aviso de webhook antes dela não
      // é o que o lojista precisa corrigir primeiro.
      const blocking =
        failed.find(
          (step) => step.name === 'credentials' || step.name === 'catalog' || (step.name === 'scopes' && missing.length > 0),
        ) ?? failed[0];
      if (blocking) {
        firstFailed = blocking.name;
        statusDetail = truncate(describe(blocking), MAX_STATUS_DETAIL_CHARS);
      }
    } else if (failed.length > 0) {
      firstFailed = failed[0]?.name ?? null;
      statusDetail = truncate(`Conectada com avisos. ${failed.map(describe).join(' ')}`, MAX_STATUS_DETAIL_CHARS);
    }

    let finalStatus: string | null = null;
    let previousStatus: string | null = null;
    let fresh: Store | null = null;
    try {
      // Relido agora: a sincronização e o webhook de desinstalação também escrevem na loja.
      fresh = repos.stores.get(storeId);
    } catch (err) {
      logger.warn({ storeId, errorName: errorName(err) }, 'conexão: leitura final da loja falhou');
    }
    if (fresh) {
      previousStatus = fresh.status;
      // Loja desligada pelo lojista continua desligada; só o detalhe passa a refletir o
      // resultado deste teste.
      const patch: StorePatch =
        fresh.status === 'disabled' ? { statusDetail } : { status: ok ? 'connected' : 'error', statusDetail };
      finalStatus = tryUpdate(storeId, patch, 'status')?.status ?? fresh.status;
    }

    const durationMs = Math.max(0, clock.now().getTime() - startedMs);
    try {
      repos.audit.record({
        actor: 'system',
        action: 'store.connect',
        targetType: 'store',
        targetId: storeId,
        // Só nomes de etapa, escopos e status: nada de credencial, token ou resposta da Shopify.
        detail: {
          ok,
          status: finalStatus,
          previousStatus,
          shopDomain: fresh?.shopDomain ?? null,
          role: fresh?.role ?? null,
          steps: steps.map((step) => ({ name: step.name, ok: step.ok })),
          firstFailedStep: firstFailed,
          missingScopes: missing,
          durationMs,
        },
      });
    } catch (err) {
      logger.warn({ storeId, errorName: errorName(err) }, 'conexão: registro de auditoria falhou');
    }
    logger.info(
      { storeId, ok, status: finalStatus, firstFailedStep: firstFailed, missingScopes: missing, durationMs },
      'conexão da loja concluída',
    );
    return { storeId, ok, steps, missingScopes: missing, shop };
  }

  async function run(storeId: string): Promise<ConnectionReport> {
    const startedMs = clock.now().getTime();
    const store = repos.stores.get(storeId);
    if (!store) {
      const steps = abortedSteps({ name: 'credentials', ok: false, detail: 'Loja não encontrada.' }, 'a loja não foi encontrada.');
      return finalize(storeId, steps, [], null, startedMs);
    }

    const credentials = await checkCredentials(store);
    if (!credentials.step.ok) {
      const steps = abortedSteps(credentials.step, 'a validação das credenciais falhou.');
      return finalize(storeId, steps, [], null, startedMs);
    }

    const scopes = await checkScopes(credentials.store);
    const webhookStep = await ensureWebhooks(credentials.store);
    const catalogStep = await syncCatalog(storeId);
    // Roda mesmo com falha no catálogo: o catálogo anterior foi mantido e o recálculo
    // sobre ele não muda nada de errado.
    const mappingStep = rematch(storeId);
    return finalize(storeId, [credentials.step, scopes.step, webhookStep, catalogStep, mappingStep], scopes.missing, credentials.shop, startedMs);
  }

  function connect(storeId: string): Promise<ConnectionReport> {
    const inFlight = running.get(storeId);
    if (inFlight) return inFlight;
    const promise = run(storeId)
      .catch((err: unknown): ConnectionReport => {
        // Só chega aqui uma falha fora das etapas (banco, por exemplo). O contrato é não lançar.
        logger.error({ storeId, errorName: errorName(err), code: isBridgeError(err) ? err.code : undefined }, 'conexão da loja falhou de forma inesperada');
        const steps = abortedSteps(
          { name: 'credentials', ok: false, detail: 'Erro interno inesperado ao conectar a loja. Tente novamente.' },
          'a conexão foi interrompida por um erro interno.',
        );
        return { storeId, ok: false, steps, missingScopes: [], shop: null };
      })
      .finally(() => {
        running.delete(storeId);
      });
    running.set(storeId, promise);
    return promise;
  }

  return { connect };
}
