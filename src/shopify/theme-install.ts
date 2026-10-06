import { BridgeError, isBridgeError } from '../types.ts';
import type { AdminClient, Logger, Store } from '../types.ts';

/**
 * Instalação automática do script no tema publicado da vitrine ("Instalar no tema").
 *
 * Lê layout/theme.liquid do tema principal pela Admin API, coloca (ou substitui) o bloco
 * entre os marcadores do checkout-bridge logo antes de </body> e grava com themeFilesUpsert.
 * A mutação exige o escopo write_themes e, pela documentação, pode exigir uma isenção da
 * Shopify para apps públicos [SC-94/SC-95]; para app da própria organização isso não está
 * documentado. Quando a Shopify recusa, o painel mostra o motivo e a colagem manual continua
 * valendo. Nada além desse arquivo é tocado, e o bloco antigo é sempre substituído inteiro.
 */

export const THEME_MARK_START = '<!-- checkout-bridge: início -->';
export const THEME_MARK_END = '<!-- checkout-bridge: fim -->';
const THEME_FILE = 'layout/theme.liquid';

export interface ThemeInstallResult {
  ok: boolean;
  themeName: string | null;
  /** 'inserted' quando o bloco entrou pela primeira vez; 'replaced' quando já havia um. */
  action: 'inserted' | 'replaced' | null;
  detail: string;
}

export interface ThemeInstaller {
  install(store: Store, snippet: string): Promise<ThemeInstallResult>;
}

const MAIN_THEME_QUERY = `
  query BridgeMainTheme {
    themes(first: 1, roles: [MAIN]) { nodes { id name } }
  }`;

const THEME_FILE_QUERY = `
  query BridgeThemeFile($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      files(filenames: $filenames, first: 1) {
        nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }`;

const UPSERT_MUTATION = `
  mutation BridgeThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message code }
    }
  }`;

interface MainThemeData {
  themes?: { nodes?: Array<{ id?: string; name?: string }> } | null;
}
interface ThemeFileData {
  theme?: { files?: { nodes?: Array<{ filename?: string; body?: { content?: string } | null }> } | null } | null;
}
interface UpsertData {
  themeFilesUpsert?: {
    upsertedThemeFiles?: Array<{ filename?: string }> | null;
    userErrors?: Array<{ field?: string[] | null; message?: string; code?: string | null }>;
  } | null;
}

/** Monta o novo theme.liquid: substitui o bloco existente ou insere antes de </body>. */
export function spliceSnippet(content: string, snippet: string): { content: string; action: 'inserted' | 'replaced' } {
  const block = snippet.includes(THEME_MARK_START) ? snippet : `${THEME_MARK_START}\n${snippet}\n${THEME_MARK_END}`;
  const start = content.indexOf(THEME_MARK_START);
  const end = content.indexOf(THEME_MARK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return { content: `${content.slice(0, start)}${block}${content.slice(end + THEME_MARK_END.length)}`, action: 'replaced' };
  }
  const bodyClose = content.lastIndexOf('</body>');
  if (bodyClose === -1) {
    throw new BridgeError('invalid_request', 'O theme.liquid do tema não tem a tag </body>; cole o bloco manualmente.', {
      reason: 'no_body_tag',
    });
  }
  return { content: `${content.slice(0, bodyClose)}${block}\n${content.slice(bodyClose)}`, action: 'inserted' };
}

function describe(err: unknown): string {
  if (isBridgeError(err)) {
    const code = typeof err.details['code'] === 'string' ? err.details['code'] : null;
    if (code === 'ACCESS_DENIED') {
      return 'A Shopify negou o acesso ao tema. Adicione o escopo write_themes à versão do app e aprove na loja; se continuar negado, a Shopify exige uma isenção para escrever em temas e a colagem manual é o caminho.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Erro inesperado';
}

export function createThemeInstaller(deps: { admin: AdminClient; logger: Logger }): ThemeInstaller {
  const log = deps.logger.child({ module: 'theme-install' });
  return {
    async install(store, snippet) {
      if (store.role !== 'vitrine') {
        return { ok: false, themeName: null, action: null, detail: 'Só lojas vitrine recebem o script.' };
      }
      try {
        const themes = await deps.admin.graphql<MainThemeData>(store, MAIN_THEME_QUERY);
        const theme = themes.themes?.nodes?.[0];
        if (theme === undefined || typeof theme.id !== 'string') {
          return { ok: false, themeName: null, action: null, detail: 'Nenhum tema publicado foi encontrado na loja.' };
        }
        const file = await deps.admin.graphql<ThemeFileData>(store, THEME_FILE_QUERY, { id: theme.id, filenames: [THEME_FILE] });
        const content = file.theme?.files?.nodes?.[0]?.body?.content;
        if (typeof content !== 'string' || content === '') {
          return { ok: false, themeName: theme.name ?? null, action: null, detail: 'Não foi possível ler layout/theme.liquid (o app tem o escopo read_themes?).' };
        }
        const next = spliceSnippet(content, snippet);
        const result = await deps.admin.graphql<UpsertData>(store, UPSERT_MUTATION, {
          themeId: theme.id,
          files: [{ filename: THEME_FILE, body: { type: 'TEXT', value: next.content } }],
        });
        const errors = result.themeFilesUpsert?.userErrors ?? [];
        if (errors.length > 0) {
          const text = errors.map((e) => e.message ?? e.code ?? 'erro').join('; ');
          log.warn({ storeId: store.id, errors: text }, 'themeFilesUpsert recusado');
          return { ok: false, themeName: theme.name ?? null, action: null, detail: `A Shopify recusou a gravação: ${text}` };
        }
        log.info({ storeId: store.id, theme: theme.name, action: next.action }, 'script instalado no tema');
        return {
          ok: true,
          themeName: theme.name ?? null,
          action: next.action,
          detail: next.action === 'inserted' ? 'Bloco inserido antes de </body>.' : 'Bloco existente substituído pela versão atual.',
        };
      } catch (err) {
        log.warn({ err, storeId: store.id }, 'falha ao instalar o script no tema');
        return { ok: false, themeName: null, action: null, detail: describe(err) };
      }
    },
  };
}
