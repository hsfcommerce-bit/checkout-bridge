import type { Clock, Repos, SecretBox } from '../types.ts';
import { createCatalogRepo } from './catalog-repo.ts';
import type { Db } from './db.ts';
import { createLinkRepo } from './link-repo.ts';
import { createMappingRepo } from './mapping-repo.ts';
import { createOrderRepo } from './order-repo.ts';
import { createBoardRepo } from './board-repo.ts';
import { createAdminSessionRepo, createAuditRepo, createJobRunRepo, createWebhookEventRepo } from './misc-repos.ts';
import { createSessionRepo } from './session-repo.ts';
import { createStoreRepo } from './store-repo.ts';

/**
 * Monta todos os repositórios sobre uma conexão já migrada (veja migrate em schema.ts).
 *
 * O SecretBox é usado só pelo repositório de lojas, para cifrar client secret e token de
 * Storefront antes de gravar. O relógio injetado dá as datas geradas aqui (createdAt,
 * updatedAt, "at" da auditoria); datas recebidas por parâmetro são normalizadas para o
 * formato canônico antes de gravar ou comparar.
 */
export function createRepos(db: Db, deps: { secretBox: SecretBox; clock: Clock }): Repos {
  return {
    stores: createStoreRepo(db, deps),
    links: createLinkRepo(db, deps),
    catalog: createCatalogRepo(db),
    mappings: createMappingRepo(db, deps),
    sessions: createSessionRepo(db),
    audit: createAuditRepo(db, deps),
    webhookEvents: createWebhookEventRepo(db),
    adminSessions: createAdminSessionRepo(db),
    jobRuns: createJobRunRepo(db),
    orders: createOrderRepo(db, deps),
    board: createBoardRepo(db, deps),
  };
}
