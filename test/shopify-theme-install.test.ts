import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../src/lib/logger.ts';
import { createThemeInstaller, spliceSnippet, THEME_MARK_END, THEME_MARK_START } from '../src/shopify/theme-install.ts';
import { BridgeError } from '../src/types.ts';
import type { AdminClient, Store } from '../src/types.ts';
import { makeStore, setup } from './db-helpers.ts';

const SNIPPET = `${THEME_MARK_START}\n<script>/* ponte */</script>\n${THEME_MARK_END}`;

function fakeAdmin(opts: {
  content?: string | null;
  userErrors?: Array<{ message: string; code?: string }>;
  throwOn?: 'themes' | 'file' | 'upsert';
  error?: unknown;
}): { admin: AdminClient; calls: Array<{ query: string; variables: Record<string, unknown> | undefined }> } {
  const calls: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];
  const admin: AdminClient = {
    async graphql<T>(_store: Store, query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });
      if (query.includes('BridgeMainTheme')) {
        if (opts.throwOn === 'themes') throw opts.error;
        return { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn' }] } } as T;
      }
      if (query.includes('BridgeThemeFile') && !query.includes('Upsert')) {
        if (opts.throwOn === 'file') throw opts.error;
        const content = opts.content === undefined ? '<html><body>loja\n</body></html>' : opts.content;
        return { theme: { files: { nodes: content === null ? [] : [{ filename: 'layout/theme.liquid', body: { content } }] } } } as T;
      }
      if (opts.throwOn === 'upsert') throw opts.error;
      return { themeFilesUpsert: { upsertedThemeFiles: [{ filename: 'layout/theme.liquid' }], userErrors: opts.userErrors ?? [] } } as T;
    },
  };
  return { admin, calls };
}

const logger = createLogger({ level: 'silent', env: 'test' });

describe('spliceSnippet', () => {
  it('insere antes de </body> e substitui um bloco existente inteiro', () => {
    const first = spliceSnippet('<body>\n<p>x</p>\n</body>', SNIPPET);
    assert.equal(first.action, 'inserted');
    assert.ok(first.content.includes(`${SNIPPET}\n</body>`));
    const second = spliceSnippet(first.content, `${THEME_MARK_START}\n<script>/* v2 */</script>\n${THEME_MARK_END}`);
    assert.equal(second.action, 'replaced');
    assert.ok(second.content.includes('/* v2 */') && !second.content.includes('/* ponte */'));
    assert.equal(second.content.split(THEME_MARK_START).length, 2);
  });
  it('sem </body> recusa com erro claro', () => {
    assert.throws(() => spliceSnippet('<html></html>', SNIPPET), (err: unknown) => err instanceof BridgeError && err.details['reason'] === 'no_body_tag');
  });
});

describe('createThemeInstaller', () => {
  it('lê o tema principal, grava o arquivo e informa o resultado', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin({});
    const result = await createThemeInstaller({ admin: fake.admin, logger }).install(store, SNIPPET);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'inserted');
    assert.equal(result.themeName, 'Dawn');
    const upsert = fake.calls[2];
    assert.ok(upsert && upsert.query.includes('themeFilesUpsert'));
    const files = (upsert.variables?.['files'] as Array<{ filename: string; body: { type: string; value: string } }>);
    assert.equal(files[0]?.filename, 'layout/theme.liquid');
    assert.equal(files[0]?.body.type, 'TEXT');
    assert.ok(files[0]?.body.value.includes(SNIPPET));
  });

  it('userErrors da Shopify viram falha com o texto, sem lançar', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin({ userErrors: [{ message: 'Access denied for themeFilesUpsert', code: 'ACCESS_DENIED' }] });
    const result = await createThemeInstaller({ admin: fake.admin, logger }).install(store, SNIPPET);
    assert.equal(result.ok, false);
    assert.match(result.detail, /recusou a gravação/);
  });

  it('ACCESS_DENIED na leitura explica o escopo write_themes; loja checkout é recusada', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const fake = fakeAdmin({ throwOn: 'themes', error: new BridgeError('upstream_rejected', 'negado', { code: 'ACCESS_DENIED' }) });
    const result = await createThemeInstaller({ admin: fake.admin, logger }).install(store, SNIPPET);
    assert.equal(result.ok, false);
    assert.match(result.detail, /write_themes/);
    const checkout = makeStore(repos, 'checkout');
    const other = await createThemeInstaller({ admin: fakeAdmin({}).admin, logger }).install(checkout, SNIPPET);
    assert.equal(other.ok, false);
  });

  it('arquivo ilegível devolve falha explicativa', async () => {
    const { repos } = setup();
    const store = makeStore(repos, 'vitrine');
    const result = await createThemeInstaller({ admin: fakeAdmin({ content: null }).admin, logger }).install(store, SNIPPET);
    assert.equal(result.ok, false);
    assert.match(result.detail, /theme\.liquid/);
  });
});
