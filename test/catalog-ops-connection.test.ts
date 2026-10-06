import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStoreConnectionService } from '../src/catalog/connection.ts';
import { createLogger } from '../src/lib/logger.ts';
import { BridgeError } from '../src/types.ts';
import type {
  AdminTokenProvider,
  CatalogSyncService,
  ConnectionReport,
  MatchService,
  MatchSummary,
  ShopInfo,
  Store,
  SyncResult,
  WebhookRegistrar,
} from '../src/types.ts';
import { makeStore, setup } from './db-helpers.ts';

const logger = createLogger({ level: 'silent', env: 'test' });

interface Fakes {
  calls: string[];
  shop: Partial<ShopInfo>;
  shopError: unknown;
  scopes: string[];
  scopesError: unknown;
  webhooksError: unknown;
  syncResult: Partial<SyncResult>;
  syncError: unknown;
  summaries: MatchSummary[];
  matchError: unknown;
}

function harness(role: 'vitrine' | 'checkout' = 'vitrine', overrides: Partial<Fakes> = {}) {
  const ctx = setup();
  const store = makeStore(ctx.repos, role);
  const f: Fakes = {
    calls: [],
    shop: {},
    shopError: null,
    scopes: role === 'vitrine' ? ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders'] : ['read_products', 'read_inventory', 'read_orders'],
    scopesError: null,
    webhooksError: null,
    syncResult: {},
    syncError: null,
    summaries: [],
    matchError: null,
    ...overrides,
  };
  const tokens: AdminTokenProvider = {
    getToken: async () => 'token',
    getScopes: async () => {
      f.calls.push('getScopes');
      if (f.scopesError !== null) throw f.scopesError;
      return f.scopes;
    },
    invalidate: () => {
      f.calls.push('invalidate');
    },
  };
  const sync: CatalogSyncService = {
    fetchShopInfo: async (s: Store) => {
      f.calls.push('fetchShopInfo');
      if (f.shopError !== null) throw f.shopError;
      return { name: 'Minha Loja', currency: 'BRL', primaryDomainHost: 'www.minhaloja.com.br', myshopifyDomain: s.shopDomain, ...f.shop };
    },
    syncStore: async (storeId) => {
      f.calls.push('syncStore');
      if (f.syncError !== null) throw f.syncError;
      return { storeId, ok: true, variants: 12, removed: 1, durationMs: 5, detail: null, ...f.syncResult };
    },
    refreshProduct: async () => {},
    removeProduct: () => {},
  };
  const matcher: MatchService = {
    rematchPair: () => {
      throw new Error('não usado');
    },
    rematchStore: () => {
      f.calls.push('rematchStore');
      if (f.matchError !== null) throw f.matchError;
      return f.summaries;
    },
  };
  const webhooks: WebhookRegistrar = {
    ensure: async () => {
      f.calls.push('ensure');
      if (f.webhooksError !== null) throw f.webhooksError;
      return { created: ['PRODUCTS_CREATE'], existing: ['PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED'] };
    },
  };
  const service = createStoreConnectionService({ repos: ctx.repos, tokens, sync, matcher, webhooks, logger, clock: ctx.clock });
  return { ...ctx, store, f, service };
}

function step(report: ConnectionReport, name: string) {
  const found = report.steps.find((s) => s.name === name);
  assert.ok(found, `etapa ${name} ausente`);
  return found;
}

function summary(counts: Partial<MatchSummary['counts']> = {}): MatchSummary {
  return {
    vitrineStoreId: 'v',
    checkoutStoreId: 'c',
    counts: { active: 10, suggested: 2, conflict: 1, unmapped: 3, disabled: 0, divergent: 4, total: 16, ...counts },
  };
}

describe('conexão de loja', () => {
  it('todas as etapas bem-sucedidas: loja conectada, moeda e domínio preenchidos, auditoria gravada', async () => {
    const h = harness('vitrine', { summaries: [summary()] });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, true);
    assert.deepEqual(report.steps.map((s) => s.name), ['credentials', 'scopes', 'webhooks', 'catalog', 'mappings']);
    assert.ok(report.steps.every((s) => s.ok), JSON.stringify(report.steps));
    assert.deepEqual(report.missingScopes, []);
    assert.equal(report.shop?.currency, 'BRL');
    assert.match(step(report, 'catalog').detail, /12 variante/);
    assert.match(step(report, 'mappings').detail, /1 rota.*10 ativo.*3 aguardando.*3 sem.*4 com divergência/);
    assert.match(step(report, 'webhooks').detail, /1 criado.*3 já existente/);

    // O token em cache é descartado ANTES de validar as credenciais.
    assert.deepEqual(h.f.calls, ['invalidate', 'fetchShopInfo', 'getScopes', 'ensure', 'syncStore', 'rematchStore']);

    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'connected');
    assert.equal(saved?.statusDetail, null);
    assert.equal(saved?.currency, 'BRL');
    assert.equal(saved?.publicDomain, 'www.minhaloja.com.br');

    const audit = h.repos.audit.list({ limit: 10, offset: 0, targetType: 'store', targetId: h.store.id });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor, 'system');
    assert.equal(audit[0]?.action, 'store.connect');
    assert.equal(audit[0]?.detail['status'], 'connected');
    assert.ok(!JSON.stringify(audit[0]?.detail).includes('shpss_segredo'));
  });

  it('não troca um domínio público já informado', async () => {
    const h = harness('checkout');
    h.repos.stores.update(h.store.id, { publicDomain: 'loja.escolhida.com' });
    await h.service.connect(h.store.id);
    assert.equal(h.repos.stores.get(h.store.id)?.publicDomain, 'loja.escolhida.com');
  });

  it('credenciais recusadas: status error, etapa nomeada, demais etapas não executadas', async () => {
    const h = harness('vitrine', {
      shopError: new BridgeError('upstream_rejected', 'Client ID ou Client secret recusados em x.myshopify.com. Confira as credenciais.', { status: 401 }),
    });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, false);
    assert.equal(report.shop, null);
    assert.equal(report.steps.length, 5);
    const cred = step(report, 'credentials');
    assert.equal(cred.ok, false);
    assert.match(cred.detail, /recusou a requisição/);
    assert.match(cred.detail, /Client ID ou Client secret recusados/);
    for (const name of ['scopes', 'webhooks', 'catalog', 'mappings']) {
      assert.equal(step(report, name).ok, false);
      assert.match(step(report, name).detail, /Não executada/);
    }
    assert.deepEqual(h.f.calls, ['invalidate', 'fetchShopInfo']);
    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'error');
    assert.match(saved?.statusDetail ?? '', /^Etapa "credenciais"/);
    assert.equal(saved?.currency, null);
  });

  it('a Shopify fora do ar na validação também é uma falha de credenciais, com outro texto', async () => {
    const h = harness('vitrine', { shopError: new BridgeError('upstream_unavailable', 'Admin API indisponível') });
    const report = await h.service.connect(h.store.id);
    assert.match(step(report, 'credentials').detail, /não respondeu/);
    assert.equal(h.repos.stores.get(h.store.id)?.status, 'error');
  });

  it('credenciais de outra loja são recusadas', async () => {
    const h = harness('vitrine', { shop: { myshopifyDomain: 'Outra-Loja.myshopify.com' } });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, false);
    assert.match(step(report, 'credentials').detail, /outra loja \(outra-loja\.myshopify\.com\)/);
    assert.equal(h.f.calls.includes('syncStore'), false);
    assert.equal(h.repos.stores.get(h.store.id)?.currency, null);
  });

  it('escopo faltando: a etapa lista o que falta, o fluxo continua e o status fica em erro', async () => {
    const h = harness('vitrine', { scopes: ['read_products', 'read_inventory', 'read_orders'] });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingScopes, ['write_app_proxy']);
    const scopes = step(report, 'scopes');
    assert.equal(scopes.ok, false);
    assert.match(scopes.detail, /write_app_proxy/);
    assert.match(scopes.detail, /nova versão/);
    assert.equal(step(report, 'catalog').ok, true);
    assert.ok(h.f.calls.includes('syncStore') && h.f.calls.includes('rematchStore'));
    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'error');
    assert.match(saved?.statusDetail ?? '', /^Etapa "escopos".*write_app_proxy/);
  });

  it('write_x concedido vale como read_x', async () => {
    const h = harness('checkout', { scopes: ['write_products', 'write_inventory', 'write_orders'] });
    const report = await h.service.connect(h.store.id);
    assert.equal(step(report, 'scopes').ok, true);
    assert.deepEqual(report.missingScopes, []);
    assert.equal(h.repos.stores.get(h.store.id)?.status, 'connected');
  });

  it('falha ao ler os escopos vira aviso, sem bloquear a conexão', async () => {
    const h = harness('checkout', { scopesError: new BridgeError('upstream_unavailable', 'x') });
    const report = await h.service.connect(h.store.id);
    assert.equal(step(report, 'scopes').ok, false);
    assert.deepEqual(report.missingScopes, []);
    assert.equal(report.ok, true);
    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'connected');
    assert.match(saved?.statusDetail ?? '', /Conectada com avisos.*escopos/);
  });

  it('falha nos webhooks não é fatal', async () => {
    const h = harness('vitrine', { webhooksError: new BridgeError('upstream_rejected', 'A Shopify recusou a assinatura do webhook PRODUCTS_CREATE: Address is invalid') });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, true);
    const hooks = step(report, 'webhooks');
    assert.equal(hooks.ok, false);
    assert.match(hooks.detail, /sincronização periódica/);
    assert.equal(step(report, 'catalog').ok, true);
    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'connected');
    assert.match(saved?.statusDetail ?? '', /Conectada com avisos\. Etapa "webhooks"/);
  });

  it('catálogo falhou: status error nomeando o catálogo, mapeamentos ainda recalculados', async () => {
    const h = harness('vitrine', { syncResult: { ok: false, variants: 3, detail: 'A Shopify não respondeu. O catálogo anterior foi mantido.' } });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, false);
    const catalog = step(report, 'catalog');
    assert.equal(catalog.ok, false);
    assert.match(catalog.detail, /catálogo anterior foi mantido/);
    assert.equal(step(report, 'mappings').ok, true);
    assert.ok(h.f.calls.includes('rematchStore'));
    const saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'error');
    assert.match(saved?.statusDetail ?? '', /^Etapa "catálogo"/);
  });

  it('syncStore que lança (contra o contrato) vira falha da etapa', async () => {
    const h = harness('vitrine', { syncError: new Error('explodiu') });
    const report = await h.service.connect(h.store.id);
    assert.equal(step(report, 'catalog').ok, false);
    assert.equal(h.repos.stores.get(h.store.id)?.status, 'error');
  });

  it('falha no recálculo de mapeamentos vira aviso', async () => {
    const h = harness('vitrine', { matchError: new Error('banco') });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, true);
    assert.equal(step(report, 'mappings').ok, false);
    assert.match(h.repos.stores.get(h.store.id)?.statusDetail ?? '', /mapeamentos/);
  });

  it('sem rotas, a etapa de mapeamentos explica que não há o que recalcular', async () => {
    const h = harness('checkout');
    const report = await h.service.connect(h.store.id);
    assert.match(step(report, 'mappings').detail, /Nenhuma rota/);
  });

  it('o aviso de webhook não é a etapa nomeada quando o catálogo também falhou', async () => {
    const h = harness('vitrine', { webhooksError: new Error('x'), syncResult: { ok: false, detail: 'falhou' } });
    await h.service.connect(h.store.id);
    assert.match(h.repos.stores.get(h.store.id)?.statusDetail ?? '', /^Etapa "catálogo"/);
  });

  it('loja desligada continua desligada; só o detalhe muda', async () => {
    const h = harness('vitrine');
    h.repos.stores.update(h.store.id, { status: 'disabled', statusDetail: 'App desinstalado na loja' });
    const report = await h.service.connect(h.store.id);
    assert.equal(report.ok, true);
    let saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'disabled');
    assert.equal(saved?.statusDetail, null);

    h.f.syncResult = { ok: false, detail: 'falhou' };
    await h.service.connect(h.store.id);
    saved = h.repos.stores.get(h.store.id);
    assert.equal(saved?.status, 'disabled');
    assert.match(saved?.statusDetail ?? '', /^Etapa "catálogo"/);
  });

  it('loja inexistente: relatório com falha, sem lançar', async () => {
    const h = harness();
    const report = await h.service.connect('st_nao_existe');
    assert.equal(report.ok, false);
    assert.equal(report.steps.length, 5);
    assert.match(step(report, 'credentials').detail, /não encontrada/);
    assert.deepEqual(h.f.calls, []);
  });

  it('erro inesperado fora das etapas não escapa', async () => {
    const h = harness();
    const broken = createStoreConnectionService({
      repos: {
        ...h.repos,
        stores: {
          ...h.repos.stores,
          get: () => {
            throw new Error('banco indisponível');
          },
        },
      },
      tokens: { getToken: async () => '', getScopes: async () => [], invalidate: () => {} },
      sync: {
        syncStore: async () => {
          throw new Error('x');
        },
        refreshProduct: async () => {},
        removeProduct: () => {},
        fetchShopInfo: async () => {
          throw new Error('x');
        },
      },
      matcher: { rematchPair: () => summary(), rematchStore: () => [] },
      webhooks: { ensure: async () => ({ created: [], existing: [] }) },
      logger,
    });
    const report = await broken.connect(h.store.id);
    assert.equal(report.ok, false);
    assert.equal(report.steps.length, 5);
    assert.match(step(report, 'credentials').detail, /Erro interno/);
  });

  it('duas chamadas simultâneas para a mesma loja compartilham a execução', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.connect(h.store.id), h.service.connect(h.store.id)]);
    assert.equal(a, b);
    assert.equal(h.f.calls.filter((c) => c === 'syncStore').length, 1);
    // Depois de terminar, uma nova chamada executa de novo.
    await h.service.connect(h.store.id);
    assert.equal(h.f.calls.filter((c) => c === 'syncStore').length, 2);
  });
});
