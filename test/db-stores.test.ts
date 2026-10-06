import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Db, SqlParams } from '../src/db/db.ts';
import { createStoreRepo, DEFAULT_PROXY_PATH } from '../src/db/store-repo.ts';
import type { NewStore, Store, StorePatch } from '../src/types.ts';
import { at, expectBridgeError, makeMapping, makeSession, makeStore, makeVariant, setup, T0, tableCount } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

const open: TestContext[] = [];

function ctx(): TestContext {
  const context = setup();
  open.push(context);
  return context;
}

afterEach(() => {
  for (const context of open.splice(0)) context.db.close();
});

/** Passa um valor de tipo errado por uma assinatura tipada, como chegaria em tempo de execução. */
function unsafe<T>(value: unknown): T {
  return value as T;
}

let seq = 0;

/** Entrada mínima válida, com domínio único por chamada. */
function input(overrides: Partial<NewStore> = {}): NewStore {
  seq += 1;
  return {
    role: 'vitrine',
    name: `Loja de teste ${seq}`,
    shopDomain: `teste-${seq}.myshopify.com`,
    clientId: `cid-${seq}`,
    clientSecret: `shpss_plain_${seq}`,
    ...overrides,
  };
}

/** Tudo o que está gravado na tabela stores, lido por SQL puro e serializado. */
function rawStores(db: Db): string {
  return JSON.stringify(db.all<Record<string, unknown>>('SELECT * FROM stores'));
}

function rawRow(db: Db, id: string): Record<string, unknown> {
  const row = db.get<Record<string, unknown>>('SELECT * FROM stores WHERE id = ?', [id]);
  assert.ok(row, 'linha da loja não encontrada');
  return row;
}

/**
 * Db que "não enxerga" uma consulta: simula outro processo gravando entre a checagem e o
 * INSERT, para exercitar a segunda barreira (restrição do esquema).
 */
function blindTo(db: Db, hidden: RegExp): Db {
  return {
    ...db,
    get<T>(sql: string, params?: SqlParams): T | undefined {
      return hidden.test(sql) ? undefined : db.get<T>(sql, params);
    },
  };
}

const INJECTIONS = [
  "'; DROP TABLE stores; --",
  "' OR '1'='1",
  '" OR ""="',
  "x'); DELETE FROM links; --",
  "1; UPDATE stores SET role = 'checkout'",
  "' UNION SELECT client_secret_enc FROM stores --",
  '%',
  '_',
  '\\',
];

const STORE_KEYS = [
  'clientId',
  'createdAt',
  'currency',
  'hasStorefrontToken',
  'id',
  'lastSyncAt',
  'lastSyncDetail',
  'lastSyncOk',
  'name',
  'proxyPath',
  'publicDomain',
  'role',
  'shopDomain',
  'status',
  'statusDetail',
  'storefrontAuthMode',
  'updatedAt',
  'variantCount',
];

describe('StoreRepo.create', () => {
  it('cria vitrine com os valores padrão', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ name: '  Minha Vitrine  ', clientId: ' cid ' }));
    assert.match(store.id, /^st_[0-9a-f]{24}$/);
    assert.equal(store.role, 'vitrine');
    assert.equal(store.name, 'Minha Vitrine');
    assert.equal(store.clientId, 'cid');
    assert.equal(store.status, 'pending');
    assert.equal(store.statusDetail, null);
    assert.equal(store.storefrontAuthMode, 'tokenless');
    assert.equal(store.hasStorefrontToken, false);
    assert.equal(store.proxyPath, '/apps/checkout-bridge');
    assert.equal(DEFAULT_PROXY_PATH, '/apps/checkout-bridge');
    assert.equal(store.publicDomain, null);
    assert.equal(store.currency, null);
    assert.equal(store.lastSyncAt, null);
    assert.equal(store.lastSyncOk, null);
    assert.equal(store.lastSyncDetail, null);
    assert.equal(store.variantCount, 0);
    assert.equal(store.createdAt, T0);
    assert.equal(store.updatedAt, T0);
    assert.deepEqual(repos.stores.get(store.id), store);
  });

  it('gera um id diferente para cada loja', () => {
    const { repos } = ctx();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i += 1) ids.add(repos.stores.create(input()).id);
    assert.equal(ids.size, 25);
    for (const id of ids) assert.match(id, /^st_[0-9a-f]{24}$/);
  });

  it('o objeto Store tem exatamente os campos públicos, sem segredo', () => {
    const { repos } = ctx();
    const store = repos.stores.create(
      input({ role: 'checkout', clientSecret: 'shpss_NUNCA_SAI', storefrontToken: 'shpat_NUNCA_SAI' }),
    );
    for (const view of [store, repos.stores.get(store.id), repos.stores.list()[0], repos.stores.getByShopDomain(store.shopDomain)]) {
      assert.ok(view);
      assert.deepEqual(Object.keys(view).sort(), STORE_KEYS);
      const text = JSON.stringify(view);
      assert.ok(!text.includes('NUNCA_SAI'));
      assert.ok(!text.includes('v1.'), 'nem o texto cifrado deve aparecer no objeto Store');
    }
  });

  it('põe o domínio em minúsculas', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ shopDomain: 'Minha-LOJA.MyShopify.COM' }));
    assert.equal(store.shopDomain, 'minha-loja.myshopify.com');
  });

  it('aceita rótulo de 1 e de 63 caracteres e recusa 64', () => {
    const { repos } = ctx();
    assert.equal(repos.stores.create(input({ shopDomain: 'a.myshopify.com' })).shopDomain, 'a.myshopify.com');
    const label63 = 'b'.repeat(63);
    assert.equal(repos.stores.create(input({ shopDomain: `${label63}.myshopify.com` })).shopDomain, `${label63}.myshopify.com`);
    expectBridgeError(() => repos.stores.create(input({ shopDomain: `${'c'.repeat(64)}.myshopify.com` })), 'invalid_request');
  });

  it('recusa domínios hostis ou fora do formato estrito', () => {
    const { db, repos } = ctx();
    const hostile: unknown[] = [
      '',
      ' ',
      'loja',
      'myshopify.com',
      '.myshopify.com',
      '-loja.myshopify.com',
      'loja.myshopify.com.evil.com',
      'evil.com/loja.myshopify.com',
      'loja.myshopify.com/admin',
      'https://loja.myshopify.com',
      'loja.myshopify.com:443',
      'user@loja.myshopify.com',
      'sub.loja.myshopify.com',
      'loja.myshopify.com.',
      ' loja.myshopify.com',
      'loja.myshopify.com ',
      'loja.myshopify.com\n',
      'loja.myshopify.com\u0000',
      'loja\u0000.myshopify.com',
      'loja.myshopify.com?x=1',
      'loja.myshopify.com#x',
      'loja_x.myshopify.com',
      'loja.myshopifyXcom',
      'loja.shopify.com',
      'lojamyshopify.com',
      'lojaK.myshopify.com',
      'lója.myshopify.com',
      'loja.myshopify.com​',
      "loja'--.myshopify.com",
      "'; DROP TABLE stores; --",
      "x.myshopify.com' OR '1'='1",
      `${'a'.repeat(100_000)}.myshopify.com`,
      null,
      undefined,
      123,
      true,
      {},
      ['loja.myshopify.com'],
      { toString: () => 'loja.myshopify.com' },
    ];
    for (const shopDomain of hostile) {
      expectBridgeError(() => repos.stores.create(input({ shopDomain: unsafe<string>(shopDomain) })), 'invalid_request');
    }
    assert.equal(tableCount(db, 'stores'), 0);
  });

  it('domínio repetido dá conflict, inclusive com outra caixa e outro papel', () => {
    const { db, repos } = ctx();
    const first = repos.stores.create(input({ shopDomain: 'unica.myshopify.com' }));
    expectBridgeError(() => repos.stores.create(input({ shopDomain: 'unica.myshopify.com' })), 'conflict');
    expectBridgeError(() => repos.stores.create(input({ shopDomain: 'UNICA.myshopify.com' })), 'conflict');
    expectBridgeError(() => repos.stores.create(input({ role: 'checkout', shopDomain: 'Unica.Myshopify.com' })), 'conflict');
    assert.equal(tableCount(db, 'stores'), 1);
    assert.deepEqual(repos.stores.getByShopDomain('unica.myshopify.com'), first);
  });

  it('o índice único do esquema também vira conflict (corrida entre processos)', () => {
    const { db, secretBox, clock, repos } = ctx();
    repos.stores.create(input({ shopDomain: 'corrida.myshopify.com' }));
    const racing = createStoreRepo(blindTo(db, /FROM stores WHERE shop_domain = \?/), { secretBox, clock });
    expectBridgeError(() => racing.create(input({ shopDomain: 'corrida.myshopify.com' })), 'conflict');
    assert.equal(tableCount(db, 'stores'), 1);
  });

  it('exige papel, nome, client id e client secret válidos', () => {
    const { db, repos } = ctx();
    const bad: Array<Partial<Record<keyof NewStore, unknown>>> = [
      { role: 'admin' },
      { role: 'VITRINE' },
      { role: '' },
      { role: null },
      { role: 1 },
      { name: '' },
      { name: '   ' },
      { name: null },
      { name: 42 },
      { name: 'n'.repeat(201) },
      { clientId: '' },
      { clientId: undefined },
      { clientId: ['x'] },
      { clientId: 'c'.repeat(201) },
      { clientSecret: '' },
      { clientSecret: ' \t\n' },
      { clientSecret: null },
      { clientSecret: 123456 },
      { clientSecret: 's'.repeat(4097) },
      { storefrontAuthMode: 'oauth' },
      { storefrontAuthMode: null },
    ];
    for (const overrides of bad) {
      expectBridgeError(() => repos.stores.create(unsafe<NewStore>({ ...input(), ...overrides })), 'invalid_request');
    }
    assert.equal(tableCount(db, 'stores'), 0);
  });

  it('aceita os tamanhos máximos de nome, client id e segredo', () => {
    const { repos } = ctx();
    const store = repos.stores.create(
      input({ name: 'n'.repeat(200), clientId: 'c'.repeat(200), clientSecret: 's'.repeat(4096) }),
    );
    assert.equal(store.name.length, 200);
    assert.equal(store.clientId.length, 200);
    assert.equal(repos.stores.getSecrets(store.id).clientSecret.length, 4096);
  });

  it('recusa entrada que não é objeto com invalid_request, não com TypeError', () => {
    const { db, repos } = ctx();
    for (const value of [null, undefined, 'loja.myshopify.com', 7, true, [], [input()]]) {
      expectBridgeError(() => repos.stores.create(unsafe<NewStore>(value)), 'invalid_request');
    }
    assert.equal(tableCount(db, 'stores'), 0);
  });
});

describe('StoreRepo: caminho do App Proxy', () => {
  const PROXY_RE = /^\/(a|apps|community|tools)\/[A-Za-z0-9_-]{1,30}$/;

  it('vitrine sem caminho informado (ausente, null ou em branco) recebe o padrão', () => {
    const { repos } = ctx();
    for (const proxyPath of [undefined, null, '', '   ']) {
      assert.equal(repos.stores.create(input({ proxyPath })).proxyPath, '/apps/checkout-bridge');
    }
  });

  it('aceita os quatro prefixos e subcaminho de 1 a 30 caracteres [A-Za-z0-9_-]', () => {
    const { repos } = ctx();
    const accepted = [
      '/a/x',
      '/apps/checkout-bridge',
      '/community/Minha_Ponte-2',
      '/tools/0',
      `/apps/${'z'.repeat(30)}`,
      '/apps/A-b_C',
    ];
    for (const proxyPath of accepted) {
      assert.equal(repos.stores.create(input({ proxyPath })).proxyPath, proxyPath);
    }
  });

  it('espaço nas pontas e barra final são normalizados; o valor gravado é sempre canônico', () => {
    const { db, repos } = ctx();
    assert.equal(repos.stores.create(input({ proxyPath: '  /apps/ponte  ' })).proxyPath, '/apps/ponte');
    assert.equal(repos.stores.create(input({ proxyPath: '/tools/ponte/' })).proxyPath, '/tools/ponte');
    for (const row of db.all<{ proxy_path: string }>('SELECT proxy_path FROM stores')) {
      assert.match(row.proxy_path, PROXY_RE);
    }
  });

  it('recusa qualquer outro formato', () => {
    const { db, repos } = ctx();
    const rejected: unknown[] = [
      '/',
      '//',
      '///',
      '/apps',
      '/apps/',
      '/apps//',
      'apps/ponte',
      '/app/ponte',
      '/Apps/ponte',
      '/APPS/ponte',
      '/proxy/ponte',
      '/apps/ponte/extra',
      '/apps/a b',
      '/apps/a.b',
      '/apps/a%2Fb',
      '/apps/ponte?x=1',
      '/apps/ponte#x',
      '/apps/../admin',
      '/apps/é',
      '/apps/ponte\u0000',
      '/apps/pon\nte',
      `/apps/${'z'.repeat(31)}`,
      '//evil.com/apps/ponte',
      'https://evil.com/apps/ponte',
      "/apps/x'; DROP TABLE stores; --",
      '/apps/<script>',
      '\\apps\\ponte',
      `/apps/${'z'.repeat(100_000)}`,
      0,
      123,
      true,
      {},
      ['/apps/ponte'],
    ];
    for (const proxyPath of rejected) {
      expectBridgeError(() => repos.stores.create(input({ proxyPath: unsafe<string>(proxyPath) })), 'invalid_request');
    }
    assert.equal(tableCount(db, 'stores'), 0);
  });

  it('loja checkout tem sempre null, mesmo informando um caminho (válido ou não)', () => {
    const { db, repos } = ctx();
    for (const proxyPath of [undefined, null, '', '/apps/ponte', 'lixo', unsafe<string>(123)]) {
      const store = repos.stores.create(input({ role: 'checkout', proxyPath }));
      assert.equal(store.proxyPath, null);
      assert.equal(rawRow(db, store.id).proxy_path, null);
    }
  });

  it('update: vitrine troca, volta ao padrão com null/branco e recusa inválidos sem gravar', () => {
    const { clock, repos } = ctx();
    const store = repos.stores.create(input());
    clock.advance(1000);
    assert.equal(repos.stores.update(store.id, { proxyPath: '/tools/outra/' }).proxyPath, '/tools/outra');
    for (const bad of ['/', '/apps/', '/x/y', 'apps/y', `/a/${'q'.repeat(31)}`, unsafe<string>(5), unsafe<string>({})]) {
      expectBridgeError(() => repos.stores.update(store.id, { proxyPath: bad }), 'invalid_request');
      assert.equal(repos.stores.get(store.id)?.proxyPath, '/tools/outra');
    }
    assert.equal(repos.stores.update(store.id, { proxyPath: null }).proxyPath, '/apps/checkout-bridge');
    assert.equal(repos.stores.update(store.id, { proxyPath: '/a/b' }).proxyPath, '/a/b');
    assert.equal(repos.stores.update(store.id, { proxyPath: '  ' }).proxyPath, '/apps/checkout-bridge');
  });

  it('update: loja checkout continua com null', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input({ role: 'checkout' }));
    for (const proxyPath of ['/apps/ponte', 'lixo', null]) {
      assert.equal(repos.stores.update(store.id, { proxyPath }).proxyPath, null);
      assert.equal(rawRow(db, store.id).proxy_path, null);
    }
  });
});

describe('StoreRepo: segredos', () => {
  it('client secret e token de Storefront ficam só cifrados na tabela', () => {
    const { db, repos } = ctx();
    const clientSecret = 'shpss_CLIENT_SECRET_em_claro_0123456789';
    const storefrontToken = 'shpat_STOREFRONT_TOKEN_em_claro_9876543210';
    const store = repos.stores.create(input({ role: 'checkout', clientSecret, storefrontToken }));

    const row = rawRow(db, store.id);
    assert.match(String(row.client_secret_enc), /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.match(String(row.storefront_token_enc), /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.notEqual(row.client_secret_enc, row.storefront_token_enc);

    const dump = rawStores(db);
    for (const secret of [clientSecret, storefrontToken]) {
      assert.ok(!dump.includes(secret), 'segredo em claro encontrado na tabela stores');
      assert.ok(!dump.includes(Buffer.from(secret).toString('base64')));
      assert.ok(!dump.includes(Buffer.from(secret).toString('base64url')));
      assert.ok(!dump.includes(Buffer.from(secret).toString('hex')));
      for (const value of Object.values(row)) assert.notEqual(value, secret);
    }
    assert.deepEqual(repos.stores.getSecrets(store.id), { clientSecret, storefrontToken });
  });

  it('o mesmo segredo em duas lojas gera textos cifrados diferentes', () => {
    const { db, repos } = ctx();
    const a = repos.stores.create(input({ clientSecret: 'shpss_igual' }));
    const b = repos.stores.create(input({ clientSecret: 'shpss_igual' }));
    assert.notEqual(rawRow(db, a.id).client_secret_enc, rawRow(db, b.id).client_secret_enc);
  });

  it('getSecrets devolve token null quando não há token', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input({ clientSecret: 'shpss_so_o_secret' }));
    assert.equal(rawRow(db, store.id).storefront_token_enc, null);
    assert.deepEqual(repos.stores.getSecrets(store.id), { clientSecret: 'shpss_so_o_secret', storefrontToken: null });
  });

  it('segredos com aspas, acentos e emoji voltam idênticos', () => {
    const { db, repos } = ctx();
    const clientSecret = `s'e"g\\r;e--d/*o*/ çãé 🔐 %_`;
    const storefrontToken = "t'); DROP TABLE stores; --";
    const store = repos.stores.create(input({ role: 'checkout', clientSecret, storefrontToken }));
    assert.deepEqual(repos.stores.getSecrets(store.id), { clientSecret, storefrontToken });
    assert.ok(!rawStores(db).includes('DROP TABLE'));
    assert.equal(tableCount(db, 'stores'), 1);
  });

  it('update troca os segredos, que continuam só cifrados; o valor antigo some', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input({ role: 'checkout', clientSecret: 'shpss_ANTIGO', storefrontToken: 'shpat_ANTIGO' }));
    const before = rawRow(db, store.id);
    repos.stores.update(store.id, { clientSecret: 'shpss_NOVO', storefrontToken: 'shpat_NOVO' });
    const after = rawRow(db, store.id);
    assert.notEqual(after.client_secret_enc, before.client_secret_enc);
    assert.notEqual(after.storefront_token_enc, before.storefront_token_enc);
    const dump = rawStores(db);
    for (const plain of ['shpss_ANTIGO', 'shpat_ANTIGO', 'shpss_NOVO', 'shpat_NOVO']) assert.ok(!dump.includes(plain));
    assert.deepEqual(repos.stores.getSecrets(store.id), { clientSecret: 'shpss_NOVO', storefrontToken: 'shpat_NOVO' });
  });

  it('update com token null remove o token; string vazia é recusada e não apaga nada', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ role: 'checkout', storefrontToken: 'shpat_fica' }));
    for (const blank of ['', '   ', unsafe<string>(0), unsafe<string>(false), unsafe<string>({})]) {
      expectBridgeError(() => repos.stores.update(store.id, { storefrontToken: blank }), 'invalid_request');
    }
    assert.equal(repos.stores.get(store.id)?.hasStorefrontToken, true);
    assert.equal(repos.stores.getSecrets(store.id).storefrontToken, 'shpat_fica');

    const cleared = repos.stores.update(store.id, { storefrontToken: null });
    assert.equal(cleared.hasStorefrontToken, false);
    assert.equal(repos.stores.getSecrets(store.id).storefrontToken, null);
  });

  it('update recusa client secret vazio, de outro tipo ou longo demais e mantém o atual', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ clientSecret: 'shpss_fica' }));
    for (const bad of ['', ' ', unsafe<string>(null), unsafe<string>(1), 's'.repeat(4097)]) {
      expectBridgeError(() => repos.stores.update(store.id, { clientSecret: bad }), 'invalid_request');
    }
    assert.equal(repos.stores.getSecrets(store.id).clientSecret, 'shpss_fica');
  });

  it('getSecrets de id desconhecido ou de outro tipo dá store_not_found', () => {
    const { repos } = ctx();
    repos.stores.create(input());
    for (const id of ['st_nao_existe', '', "' OR '1'='1", unsafe<string>(null), unsafe<string>(undefined), unsafe<string>(1), unsafe<string>({})]) {
      expectBridgeError(() => repos.stores.getSecrets(id), 'store_not_found');
    }
  });

  it('texto cifrado adulterado ou de outra chave dá erro interno sem vazar o conteúdo', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input({ clientSecret: 'shpss_integro' }));
    const blob = String(rawRow(db, store.id).client_secret_enc);
    const tampered = `${blob.slice(0, -2)}${blob.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const broken of [tampered, 'shpss_gravado_em_claro_por_engano', 'v1.a.b.c', '']) {
      db.run('UPDATE stores SET client_secret_enc = ? WHERE id = ?', [broken, store.id]);
      const err = expectBridgeError(() => repos.stores.getSecrets(store.id), 'internal');
      assert.ok(broken === '' || !err.message.includes(broken));
      assert.ok(broken === '' || !JSON.stringify(err).includes(broken));
    }
  });
});

describe('StoreRepo: token e modo de autenticação da Storefront', () => {
  it('com token o modo padrão é private_token; sem token é tokenless', () => {
    const { repos } = ctx();
    const withToken = repos.stores.create(input({ role: 'checkout', storefrontToken: '  shpat_abc  ' }));
    assert.equal(withToken.storefrontAuthMode, 'private_token');
    assert.equal(withToken.hasStorefrontToken, true);
    assert.equal(repos.stores.getSecrets(withToken.id).storefrontToken, 'shpat_abc');

    for (const storefrontToken of [undefined, null, '', '  \n']) {
      const store = repos.stores.create(input({ role: 'checkout', storefrontToken }));
      assert.equal(store.storefrontAuthMode, 'tokenless');
      assert.equal(store.hasStorefrontToken, false);
    }
  });

  it('modo informado explicitamente prevalece', () => {
    const { repos } = ctx();
    const publicMode = repos.stores.create(
      input({ role: 'checkout', storefrontToken: 'tok_publico', storefrontAuthMode: 'public_token' }),
    );
    assert.equal(publicMode.storefrontAuthMode, 'public_token');
    assert.equal(publicMode.hasStorefrontToken, true);
    const privateNoToken = repos.stores.create(input({ role: 'checkout', storefrontAuthMode: 'private_token' }));
    assert.equal(privateNoToken.storefrontAuthMode, 'private_token');
    assert.equal(privateNoToken.hasStorefrontToken, false);
  });

  it('token de tipo errado ou longo demais é recusado na criação, não ignorado', () => {
    const { db, repos } = ctx();
    for (const storefrontToken of [123, 0, true, false, {}, ['shpat_x'], 't'.repeat(4097)]) {
      expectBridgeError(
        () => repos.stores.create(input({ role: 'checkout', storefrontToken: unsafe<string>(storefrontToken) })),
        'invalid_request',
      );
    }
    assert.equal(tableCount(db, 'stores'), 0);
  });

  it('hasStorefrontToken acompanha a coluna e update do modo é validado', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ role: 'checkout' }));
    assert.equal(store.hasStorefrontToken, false);
    const updated = repos.stores.update(store.id, { storefrontToken: 'shpat_novo', storefrontAuthMode: 'private_token' });
    assert.equal(updated.hasStorefrontToken, true);
    assert.equal(updated.storefrontAuthMode, 'private_token');
    for (const mode of ['', 'PRIVATE_TOKEN', 'x', null, 1]) {
      expectBridgeError(
        () => repos.stores.update(store.id, { storefrontAuthMode: unsafe<Store['storefrontAuthMode']>(mode) }),
        'invalid_request',
      );
    }
    assert.equal(repos.stores.get(store.id)?.storefrontAuthMode, 'private_token');
  });
});

describe('StoreRepo: leitura', () => {
  it('get devolve null para id desconhecido ou de outro tipo', () => {
    const { repos } = ctx();
    repos.stores.create(input());
    for (const id of ['st_nao_existe', '', '%', 'st_%', unsafe<string>(null), unsafe<string>(undefined), unsafe<string>(0), unsafe<string>({}), unsafe<string>(['x'])]) {
      assert.equal(repos.stores.get(id), null);
    }
  });

  it('getByShopDomain ignora a caixa e não aceita variações do domínio', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ shopDomain: 'lojak.myshopify.com' }));
    assert.deepEqual(repos.stores.getByShopDomain('lojak.myshopify.com'), store);
    assert.deepEqual(repos.stores.getByShopDomain('LojaK.MYSHOPIFY.com'), store);
    const misses: unknown[] = [
      'outra.myshopify.com',
      '',
      ' lojak.myshopify.com',
      'lojak.myshopify.com ',
      'lojak.myshopify.com\n',
      'https://lojak.myshopify.com',
      'lojak.myshopify.com/',
      'lojak.myshopify.com.',
      // Sinal Kelvin (U+212A): vira "k" no toLowerCase() e não pode achar a loja "lojak".
      'lojaK.myshopify.com',
      'LOJAK.MYSHOPIFY.COM',
      'lojak%',
      '%',
      "lojak.myshopify.com' OR '1'='1",
      "' OR 1=1 --",
      null,
      undefined,
      1,
      {},
      ['lojak.myshopify.com'],
    ];
    for (const value of misses) assert.equal(repos.stores.getByShopDomain(unsafe<string>(value)), null);
  });

  it('list ordena por criação e filtra por papel', () => {
    const { clock, repos } = ctx();
    const v1 = repos.stores.create(input());
    clock.advance(1000);
    const c1 = repos.stores.create(input({ role: 'checkout' }));
    clock.advance(1000);
    const v2 = repos.stores.create(input());
    assert.deepEqual(repos.stores.list().map((s) => s.id), [v1.id, c1.id, v2.id]);
    assert.deepEqual(repos.stores.list({}).map((s) => s.id), [v1.id, c1.id, v2.id]);
    assert.deepEqual(repos.stores.list({ role: 'vitrine' }).map((s) => s.id), [v1.id, v2.id]);
    assert.deepEqual(repos.stores.list({ role: 'checkout' }).map((s) => s.id), [c1.id]);
  });

  it('list desempata pelo id quando as lojas nasceram no mesmo instante', () => {
    const { repos } = ctx();
    const ids = [repos.stores.create(input()).id, repos.stores.create(input()).id, repos.stores.create(input()).id];
    const expected = [...ids].sort();
    assert.deepEqual(repos.stores.list().map((s) => s.id), expected);
    assert.deepEqual(repos.stores.list().map((s) => s.id), expected);
  });

  it('list com papel desconhecido ou hostil não devolve nada', () => {
    const { db, repos } = ctx();
    repos.stores.create(input());
    repos.stores.create(input({ role: 'checkout' }));
    for (const role of ['', 'admin', 'VITRINE', "vitrine' OR '1'='1", "'; DROP TABLE stores; --", 1, {}, ['vitrine'], true]) {
      assert.deepEqual(repos.stores.list({ role: unsafe<Store['role']>(role) }), []);
    }
    assert.equal(repos.stores.list(unsafe<{ role?: Store['role'] }>(null)).length, 2);
    assert.equal(tableCount(db, 'stores'), 2);
  });

  it('variantCount é a contagem viva de catalog_variants da própria loja', () => {
    const { clock, repos } = ctx();
    const a = repos.stores.create(input());
    // Datas de criação distintas: no empate a ordem de list() cai no id, que é aleatório.
    clock.advance(1000);
    const b = repos.stores.create(input({ role: 'checkout' }));
    repos.catalog.upsertVariants([makeVariant(a.id, '1'), makeVariant(a.id, '2'), makeVariant(a.id, '3', { productId: '2000' })]);
    repos.catalog.upsertVariants([makeVariant(b.id, '1')]);
    assert.equal(repos.stores.get(a.id)?.variantCount, 3);
    assert.equal(repos.stores.get(b.id)?.variantCount, 1);
    assert.equal(repos.stores.getByShopDomain(a.shopDomain)?.variantCount, 3);
    assert.deepEqual(repos.stores.list().map((s) => s.variantCount), [3, 1]);

    repos.catalog.deleteProduct(a.id, '1000');
    assert.equal(repos.stores.get(a.id)?.variantCount, 1);
    assert.equal(repos.stores.get(b.id)?.variantCount, 1);
    repos.catalog.deleteStore(a.id);
    assert.equal(repos.stores.get(a.id)?.variantCount, 0);
    // update devolve a contagem atual, não um valor guardado na linha.
    assert.equal(repos.stores.update(b.id, { name: 'Outro nome' }).variantCount, 1);
  });
});

describe('StoreRepo.update', () => {
  it('altera cada campo do patch e avança updatedAt', () => {
    const { clock, repos } = ctx();
    const store = repos.stores.create(input({ role: 'checkout' }));
    clock.advance(5000);
    const updated = repos.stores.update(store.id, {
      name: '  Novo nome ',
      publicDomain: 'https://WWW.Loja.com.br/pagina',
      clientId: ' novo-cid ',
      currency: 'brl',
      status: 'connected',
      statusDetail: 'tudo certo',
      storefrontAuthMode: 'public_token',
    });
    assert.equal(updated.name, 'Novo nome');
    assert.equal(updated.publicDomain, 'www.loja.com.br');
    assert.equal(updated.clientId, 'novo-cid');
    assert.equal(updated.currency, 'BRL');
    assert.equal(updated.status, 'connected');
    assert.equal(updated.statusDetail, 'tudo certo');
    assert.equal(updated.storefrontAuthMode, 'public_token');
    assert.equal(updated.createdAt, T0);
    assert.equal(updated.updatedAt, at(5000));
    assert.equal(updated.id, store.id);
    assert.equal(updated.shopDomain, store.shopDomain);
    assert.equal(updated.role, 'checkout');
    assert.deepEqual(repos.stores.get(store.id), updated);
  });

  it('null limpa os campos anuláveis', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input({ publicDomain: 'loja.com' }));
    repos.stores.update(store.id, { currency: 'USD', statusDetail: 'x' });
    const cleared = repos.stores.update(store.id, { publicDomain: null, currency: null, statusDetail: null });
    assert.equal(cleared.publicDomain, null);
    assert.equal(cleared.currency, null);
    assert.equal(cleared.statusDetail, null);
    assert.equal(repos.stores.update(store.id, { publicDomain: '  ' }).publicDomain, null);
  });

  it('patch vazio devolve a loja sem mexer em updatedAt', () => {
    const { clock, repos } = ctx();
    const store = repos.stores.create(input());
    clock.advance(1000);
    assert.deepEqual(repos.stores.update(store.id, {}), store);
    assert.deepEqual(repos.stores.update(store.id, { name: undefined }), store);
  });

  it('id desconhecido dá store_not_found, mesmo com patch vazio ou inválido', () => {
    const { repos } = ctx();
    repos.stores.create(input());
    const patches: StorePatch[] = [{}, { name: 'x' }, { name: '' }, { status: unsafe<Store['status']>('bogus') }, unsafe<StorePatch>(null)];
    for (const id of ['st_nao_existe', '', "' OR '1'='1", unsafe<string>(null), unsafe<string>(undefined), unsafe<string>(7)]) {
      for (const patch of patches) expectBridgeError(() => repos.stores.update(id, patch), 'store_not_found');
    }
  });

  it('recusa valores inválidos e não grava nada do patch (tudo ou nada)', () => {
    const { clock, repos } = ctx();
    const store = repos.stores.create(input());
    clock.advance(1000);
    const bad: Array<Partial<Record<keyof StorePatch, unknown>>> = [
      { name: '' },
      { name: 'n'.repeat(201) },
      { name: null },
      { name: 5 },
      { clientId: '' },
      { clientId: 'c'.repeat(201) },
      { status: 'active' },
      { status: '' },
      { status: null },
      { currency: 'real' },
      { currency: 'R$' },
      { currency: '' },
      { currency: 986 },
      { publicDomain: 'user@loja.com' },
      { publicDomain: 'loja com espaço.com' },
      { publicDomain: '127.0.0.1' },
      { publicDomain: 12 },
      { publicDomain: "loja.com'; DROP TABLE stores; --" },
    ];
    for (const patch of bad) {
      // O campo válido vem junto de propósito: se o inválido falha, o válido não pode ficar.
      expectBridgeError(() => repos.stores.update(store.id, unsafe<StorePatch>({ statusDetail: 'gravou?', ...patch })), 'invalid_request');
      assert.deepEqual(repos.stores.get(store.id), store);
    }
    for (const patch of [null, 'name', 3, [], [{ name: 'x' }]]) {
      expectBridgeError(() => repos.stores.update(store.id, unsafe<StorePatch>(patch)), 'invalid_request');
    }
    assert.deepEqual(repos.stores.get(store.id), store);
  });

  it('ignora chaves fora do contrato: papel, domínio, id e nomes de coluna não mudam', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input({ clientSecret: 'shpss_intacto' }));
    const before = rawRow(db, store.id);
    const hostilePatch = {
      id: 'st_outro',
      role: 'checkout',
      shopDomain: 'outra.myshopify.com',
      shop_domain: 'outra.myshopify.com',
      client_secret_enc: 'em claro',
      createdAt: '1999-01-01T00:00:00.000Z',
      variantCount: 999,
      hasStorefrontToken: true,
      "name = 'x', role": 'checkout',
      // Como chegaria de um JSON.parse: "__proto__" vira propriedade comum, não protótipo.
      ...(JSON.parse('{"__proto__": {"status": "disabled"}, "constructor": {"prototype": {"status": "disabled"}}}') as object),
    };
    const updated = repos.stores.update(store.id, unsafe<StorePatch>(hostilePatch));
    assert.equal(updated.status, 'pending');
    assert.equal(updated.id, store.id);
    assert.equal(updated.role, 'vitrine');
    assert.equal(updated.shopDomain, store.shopDomain);
    assert.equal(updated.createdAt, T0);
    assert.equal(updated.hasStorefrontToken, false);
    const after = rawRow(db, store.id);
    assert.equal(after.client_secret_enc, before.client_secret_enc);
    assert.equal(after.role, 'vitrine');
    assert.equal(repos.stores.getSecrets(store.id).clientSecret, 'shpss_intacto');
  });

  it('statusDetail é cortado em 2000 caracteres', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input());
    const updated = repos.stores.update(store.id, { status: 'error', statusDetail: 'e'.repeat(1_000_000) });
    assert.equal(updated.statusDetail?.length, 2000);
  });

  it('percorre todos os status válidos', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input());
    for (const status of ['connected', 'error', 'disabled', 'pending'] as const) {
      assert.equal(repos.stores.update(store.id, { status }).status, status);
    }
  });
});

/** Duas vitrines e dois checkouts, com rotas, catálogo, mapeamentos, sessões e auditoria. */
function populate(context: TestContext): { v1: Store; v2: Store; c1: Store; c2: Store } {
  const { repos } = context;
  const v1 = makeStore(repos, 'vitrine');
  const v2 = makeStore(repos, 'vitrine');
  const c1 = makeStore(repos, 'checkout');
  const c2 = makeStore(repos, 'checkout');
  repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c1.id, kind: 'default' });
  repos.links.create({ vitrineStoreId: v1.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] });
  repos.links.create({ vitrineStoreId: v2.id, checkoutStoreId: c1.id, kind: 'default' });
  repos.links.create({ vitrineStoreId: v2.id, checkoutStoreId: c2.id, kind: 'country', countries: ['US'] });
  for (const store of [v1, v2, c1, c2]) {
    repos.catalog.upsertVariants([makeVariant(store.id, '1'), makeVariant(store.id, '2')]);
  }
  for (const vitrine of [v1, v2]) {
    for (const checkout of [c1, c2]) {
      repos.mappings.upsertAuto([makeMapping(vitrine.id, checkout.id, '1'), makeMapping(vitrine.id, checkout.id, '2')]);
    }
  }
  repos.sessions.insertPending(makeSession({ idempotencyKey: 'k1', vitrineStoreId: v1.id, checkoutStoreId: c1.id }), T0);
  repos.sessions.insertPending(makeSession({ idempotencyKey: 'k2', vitrineStoreId: v2.id, checkoutStoreId: c2.id }), T0);
  for (const store of [v1, v2, c1, c2]) {
    repos.audit.record({ actor: 'admin', action: 'store.create', targetType: 'store', targetId: store.id, detail: {} });
  }
  return { v1, v2, c1, c2 };
}

function counts(db: Db): Record<string, number> {
  return {
    stores: tableCount(db, 'stores'),
    links: tableCount(db, 'links'),
    catalog: tableCount(db, 'catalog_variants'),
    mappings: tableCount(db, 'variant_mappings'),
    sessions: tableCount(db, 'checkout_sessions'),
    audit: tableCount(db, 'audit_log'),
  };
}

describe('StoreRepo.delete', () => {
  it('remove a vitrine com rotas, catálogo e mapeamentos; sessões e auditoria ficam', () => {
    const context = ctx();
    const { db, repos } = context;
    const { v1, v2, c1, c2 } = populate(context);
    assert.deepEqual(counts(db), { stores: 4, links: 4, catalog: 8, mappings: 8, sessions: 2, audit: 4 });

    repos.stores.delete(v1.id);
    assert.equal(repos.stores.get(v1.id), null);
    assert.deepEqual(counts(db), { stores: 3, links: 2, catalog: 6, mappings: 4, sessions: 2, audit: 4 });
    assert.deepEqual(repos.links.list({ vitrineStoreId: v1.id }), []);
    assert.equal(repos.catalog.count(v1.id), 0);
    assert.deepEqual(repos.mappings.listAll(v1.id, c1.id), []);
    assert.deepEqual(repos.mappings.listAll(v1.id, c2.id), []);
    // O que é das outras lojas continua inteiro.
    assert.equal(repos.links.list({ vitrineStoreId: v2.id }).length, 2);
    assert.equal(repos.mappings.listAll(v2.id, c1.id).length, 2);
    assert.equal(repos.catalog.count(c1.id), 2);
    assert.equal(repos.sessions.list({ vitrineStoreId: v1.id, limit: 10, offset: 0 }).length, 1);
    assert.equal(repos.audit.list({ targetType: 'store', targetId: v1.id, limit: 10, offset: 0 }).length, 1);
    expectBridgeError(() => repos.stores.getSecrets(v1.id), 'store_not_found');
  });

  it('remove a loja checkout com as rotas e os mapeamentos em que ela é o destino', () => {
    const context = ctx();
    const { db, repos } = context;
    const { v1, v2, c1, c2 } = populate(context);

    repos.stores.delete(c1.id);
    assert.deepEqual(counts(db), { stores: 3, links: 2, catalog: 6, mappings: 4, sessions: 2, audit: 4 });
    assert.deepEqual(repos.links.list({ checkoutStoreId: c1.id }), []);
    assert.deepEqual(repos.mappings.listAll(v1.id, c1.id), []);
    assert.deepEqual(repos.mappings.listAll(v2.id, c1.id), []);
    assert.equal(repos.mappings.listAll(v1.id, c2.id).length, 2);
    assert.deepEqual(repos.links.list().map((l) => l.checkoutStoreId), [c2.id, c2.id]);
    assert.equal(repos.sessions.list({ checkoutStoreId: c1.id, limit: 10, offset: 0 }).length, 1);
  });

  it('o domínio fica livre para ser cadastrado de novo, com outro id', () => {
    const { repos } = ctx();
    const first = repos.stores.create(input({ shopDomain: 'volta.myshopify.com' }));
    repos.stores.delete(first.id);
    assert.equal(repos.stores.getByShopDomain('volta.myshopify.com'), null);
    const second = repos.stores.create(input({ shopDomain: 'volta.myshopify.com' }));
    assert.notEqual(second.id, first.id);
  });

  it('id desconhecido ou de outro tipo dá store_not_found e não remove nada', () => {
    const context = ctx();
    const { db, repos } = context;
    populate(context);
    const before = counts(db);
    const ids: unknown[] = ['st_nao_existe', '', '%', "' OR '1'='1", "x' OR 1=1 --", "'; DELETE FROM stores; --", null, undefined, 0, {}, []];
    for (const id of ids) expectBridgeError(() => repos.stores.delete(unsafe<string>(id)), 'store_not_found');
    assert.deepEqual(counts(db), before);
  });

  it('apagar duas vezes: a segunda dá store_not_found', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input());
    repos.stores.delete(store.id);
    expectBridgeError(() => repos.stores.delete(store.id), 'store_not_found');
  });

  it('é atômico: se a remoção da loja falha, rotas, catálogo e mapeamentos voltam', () => {
    const context = ctx();
    const { db, repos } = context;
    const { v1 } = populate(context);
    const before = counts(db);
    // A falha acontece no último passo, depois que as tabelas dependentes já foram limpas.
    db.exec("CREATE TRIGGER trava_loja BEFORE DELETE ON stores BEGIN SELECT RAISE(ABORT, 'travado'); END");
    assert.throws(() => repos.stores.delete(v1.id), /travado/);
    assert.deepEqual(counts(db), before);
    assert.ok(repos.stores.get(v1.id));
    assert.equal(repos.links.list({ vitrineStoreId: v1.id }).length, 2);

    db.exec('DROP TRIGGER trava_loja');
    repos.stores.delete(v1.id);
    assert.equal(repos.stores.get(v1.id), null);
  });

  it('remove tudo mesmo com o pragma foreign_keys desligado na conexão', () => {
    const context = ctx();
    const { db, repos } = context;
    const { c2 } = populate(context);
    db.exec('PRAGMA foreign_keys = OFF');
    repos.stores.delete(c2.id);
    assert.deepEqual(counts(db), { stores: 3, links: 2, catalog: 6, mappings: 4, sessions: 2, audit: 4 });
    assert.equal(tableCount(db, 'links'), repos.links.list().filter((l) => l.checkoutStoreId !== c2.id).length);
  });
});

describe('StoreRepo.markSynced', () => {
  it('grava o resultado da sincronização e normaliza a data', () => {
    const { clock, repos } = ctx();
    const store = repos.stores.create(input());
    clock.advance(2000);
    repos.stores.markSynced(store.id, { at: '2026-03-04T05:06:07Z', ok: true, detail: null });
    let read = repos.stores.get(store.id);
    assert.equal(read?.lastSyncAt, '2026-03-04T05:06:07.000Z');
    assert.equal(read?.lastSyncOk, true);
    assert.equal(read?.lastSyncDetail, null);
    assert.equal(read?.updatedAt, at(2000));
    assert.equal(read?.createdAt, T0);

    repos.stores.markSynced(store.id, { at: '2026-03-05T02:06:07-03:00', ok: false, detail: 'Falha: escopo ausente' });
    read = repos.stores.get(store.id);
    assert.equal(read?.lastSyncAt, '2026-03-05T05:06:07.000Z');
    assert.equal(read?.lastSyncOk, false);
    assert.equal(read?.lastSyncDetail, 'Falha: escopo ausente');
  });

  it('não mexe em status, segredos nem em outras lojas', () => {
    const { repos } = ctx();
    const a = repos.stores.create(input({ clientSecret: 'shpss_a' }));
    const b = repos.stores.create(input());
    repos.stores.update(a.id, { status: 'connected' });
    repos.stores.markSynced(a.id, { at: T0, ok: true, detail: 'ok' });
    assert.equal(repos.stores.get(a.id)?.status, 'connected');
    assert.equal(repos.stores.getSecrets(a.id).clientSecret, 'shpss_a');
    assert.deepEqual(repos.stores.get(b.id), b);
  });

  it('só o booleano true conta como sucesso; detalhe é cortado em 2000 caracteres', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input());
    for (const ok of ['true', 1, {}, null, undefined]) {
      repos.stores.markSynced(store.id, { at: T0, ok: unsafe<boolean>(ok), detail: 'd'.repeat(5000) });
      const read = repos.stores.get(store.id);
      assert.equal(read?.lastSyncOk, false);
      assert.equal(read?.lastSyncDetail?.length, 2000);
    }
  });

  it('data inválida ou resultado que não é objeto dão invalid_request e nada muda', () => {
    const { repos } = ctx();
    const store = repos.stores.create(input());
    for (const value of ['', 'ontem', '2026-13-45T00:00:00Z', "'; DROP TABLE stores; --", null, 1767225600000, {}]) {
      expectBridgeError(() => repos.stores.markSynced(store.id, { at: unsafe<string>(value), ok: true, detail: null }), 'invalid_request');
    }
    for (const result of [null, undefined, 'ok', 1, []]) {
      expectBridgeError(() => repos.stores.markSynced(store.id, unsafe<{ at: string; ok: boolean; detail: null }>(result)), 'invalid_request');
    }
    assert.deepEqual(repos.stores.get(store.id), store);
  });

  it('loja desconhecida (removida durante a sincronização) não é erro e não cria nada', () => {
    const { db, repos } = ctx();
    const store = repos.stores.create(input());
    for (const id of ['st_nao_existe', "' OR '1'='1", '%', unsafe<string>(null), unsafe<string>(undefined), unsafe<string>({})]) {
      repos.stores.markSynced(id, { at: T0, ok: true, detail: 'x' });
    }
    assert.equal(tableCount(db, 'stores'), 1);
    assert.deepEqual(repos.stores.get(store.id), store);
  });
});

describe('StoreRepo: injeção de SQL e entradas enormes', () => {
  it('texto com SQL é gravado e lido como texto, em todos os campos livres', () => {
    const { db, repos } = ctx();
    const c = makeStore(repos, 'checkout');
    for (const payload of INJECTIONS) {
      const store = repos.stores.create(
        input({ role: 'checkout', name: payload, clientId: payload, clientSecret: payload, storefrontToken: payload }),
      );
      assert.equal(store.name, payload);
      assert.equal(store.clientId, payload);
      assert.deepEqual(repos.stores.getSecrets(store.id), { clientSecret: payload, storefrontToken: payload });
      const updated = repos.stores.update(store.id, { name: `${payload}!`, clientId: `${payload}!`, statusDetail: payload, clientSecret: `${payload}!` });
      assert.equal(updated.name, `${payload}!`);
      assert.equal(updated.statusDetail, payload);
      repos.stores.markSynced(store.id, { at: T0, ok: false, detail: payload });
      assert.equal(repos.stores.get(store.id)?.lastSyncDetail, payload);
    }
    assert.equal(tableCount(db, 'stores'), INJECTIONS.length + 1);
    assert.deepEqual(repos.stores.get(c.id), c);
    assert.equal(repos.stores.list({ role: 'checkout' }).length, INJECTIONS.length + 1);
    assert.equal(tableCount(db, 'links'), 0);
  });

  it('SQL no lugar do id não acha, não altera e não apaga nenhuma loja', () => {
    const { db, repos } = ctx();
    const a = repos.stores.create(input({ clientSecret: 'shpss_a' }));
    const b = repos.stores.create(input({ role: 'checkout' }));
    for (const payload of [...INJECTIONS, `${a.id}' OR '1'='1`, `${a.id}' --`, `${a.id}%`]) {
      assert.equal(repos.stores.get(payload), null);
      assert.equal(repos.stores.getByShopDomain(payload), null);
      expectBridgeError(() => repos.stores.update(payload, { name: 'invadida' }), 'store_not_found');
      expectBridgeError(() => repos.stores.getSecrets(payload), 'store_not_found');
      expectBridgeError(() => repos.stores.delete(payload), 'store_not_found');
      repos.stores.markSynced(payload, { at: T0, ok: true, detail: 'invadida' });
    }
    assert.equal(tableCount(db, 'stores'), 2);
    assert.deepEqual(repos.stores.get(a.id), a);
    assert.deepEqual(repos.stores.get(b.id), b);
  });

  it('entradas enormes são recusadas (ou cortadas) sem derrubar nada', () => {
    const { db, repos } = ctx();
    const huge = 'x'.repeat(2_000_000);
    const fields: Array<keyof NewStore> = ['name', 'shopDomain', 'clientId', 'clientSecret', 'publicDomain', 'proxyPath', 'storefrontToken'];
    for (const field of fields) {
      expectBridgeError(() => repos.stores.create(input({ [field]: huge })), 'invalid_request');
    }
    assert.equal(tableCount(db, 'stores'), 0);

    const store = repos.stores.create(input());
    for (const field of ['name', 'clientId', 'clientSecret', 'publicDomain', 'proxyPath', 'storefrontToken', 'currency'] as const) {
      expectBridgeError(() => repos.stores.update(store.id, { [field]: huge }), 'invalid_request');
    }
    assert.equal(repos.stores.get(huge), null);
    assert.equal(repos.stores.getByShopDomain(huge), null);
    expectBridgeError(() => repos.stores.delete(huge), 'store_not_found');
    assert.deepEqual(repos.stores.get(store.id), store);
  });
});
