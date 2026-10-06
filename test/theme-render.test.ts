import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  DEFAULT_PROXY_PATH,
  defaultScriptConfig,
  isValidProxyPath,
  renderBridgeScript,
  renderInlineSnippet,
  renderLoaderSnippet,
  serializeForInlineScript,
} from '../src/theme/render.ts';
import type { BridgeScriptConfig } from '../src/theme/render.ts';
import type { Store } from '../src/types.ts';

function fakeStore(proxyPath: string | null): Store {
  return {
    id: 'st_1',
    role: 'vitrine',
    name: 'Vitrine',
    shopDomain: 'vitrine.myshopify.com',
    publicDomain: 'vitrine.example.com',
    proxyPath,
    clientId: 'client',
    currency: 'BRL',
    status: 'connected',
    statusDetail: null,
    storefrontAuthMode: 'tokenless',
    hasStorefrontToken: false,
    lastSyncAt: null,
    lastSyncOk: null,
    lastSyncDetail: null,
    variantCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function baseConfig(overrides: Partial<BridgeScriptConfig> = {}): BridgeScriptConfig {
  return {
    proxyPath: '/apps/checkout-bridge',
    checkoutHosts: ['checkout.example.com'],
    acceleratedButtons: 'hide',
    onError: 'message',
    extraSelectors: [],
    debug: false,
    ...overrides,
  };
}

/** Executa o script com um window mínimo e devolve a configuração que ele enxergou. */
function configSeenByScript(source: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    document: { nodeType: 9, head: null, documentElement: null, createElement: () => ({ setAttribute() {}, style: {} }) },
    location: { href: 'https://vitrine.example.com/', origin: 'https://vitrine.example.com', search: '' },
    addEventListener() {},
    URL,
    URLSearchParams,
  };
  sandbox['window'] = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  const api = sandbox['CheckoutBridge'] as { __test?: { config: Record<string, unknown> } };
  assert.ok(api.__test, 'gancho de teste ausente');
  // Cópia no realm do teste: arrays do contexto do vm não são deepEqual aos daqui.
  return JSON.parse(JSON.stringify(api.__test.config)) as Record<string, unknown>;
}

test('defaultScriptConfig usa o caminho do proxy da loja e os padrões seguros', () => {
  const config = defaultScriptConfig(fakeStore('/a/minha-ponte'), ['Checkout.Example.com', 'checkout.example.com', 'não válido', '']);
  assert.deepEqual(config, {
    proxyPath: '/a/minha-ponte',
    checkoutHosts: ['checkout.example.com'],
    acceleratedButtons: 'hide',
    onError: 'message',
    extraSelectors: [],
    debug: false,
  });
});

test('defaultScriptConfig cai no caminho padrão quando a loja não tem um válido', () => {
  assert.equal(defaultScriptConfig(fakeStore(null), []).proxyPath, DEFAULT_PROXY_PATH);
  assert.equal(defaultScriptConfig(fakeStore('/admin/x'), []).proxyPath, DEFAULT_PROXY_PATH);
  assert.equal(defaultScriptConfig(fakeStore('/apps/x/y'), []).proxyPath, DEFAULT_PROXY_PATH);
  assert.equal(defaultScriptConfig(fakeStore('https://evil.example/apps/x'), []).proxyPath, DEFAULT_PROXY_PATH);
  assert.equal(defaultScriptConfig(fakeStore('/tools/ponte_1'), []).proxyPath, '/tools/ponte_1');
});

test('isValidProxyPath aceita só os prefixos da Shopify e um subcaminho curto', () => {
  assert.equal(isValidProxyPath('/apps/checkout-bridge'), true);
  assert.equal(isValidProxyPath('/community/x'), true);
  assert.equal(isValidProxyPath('/apps/'), false);
  assert.equal(isValidProxyPath('/apps/' + 'a'.repeat(31)), false);
  assert.equal(isValidProxyPath('/apps/x?y=1'), false);
  assert.equal(isValidProxyPath(42), false);
});

test('renderBridgeScript substitui o marcador uma única vez e gera JavaScript válido', () => {
  const source = renderBridgeScript(baseConfig());
  assert.equal(source.includes('/*__CONFIG__*/'), false);
  assert.ok(source.includes('"proxyPath":"/apps/checkout-bridge"'));
  assert.doesNotThrow(() => new vm.Script(source));
  // Comentários de linha inteira saem; o que resta é só código.
  assert.equal(
    source.split('\n').some((line) => line.trim().startsWith('//') || line.trim() === ''),
    false,
  );
  // Sem gancho de teste em produção.
  assert.equal(source.includes('"__test"'), false);
  assert.equal(renderBridgeScript(baseConfig(), { test: true }).includes('"__test":true'), true);
});

test('valores da configuração não escapam do script inline nem do Liquid', () => {
  const separators = String.fromCharCode(0x2028) + 'meio' + String.fromCharCode(0x2029);
  const hostile = '</script><script>alert(1)</script><!-- {{ x }} {% y %} & $& $1 ' + separators + ' fim';
  const config = baseConfig({ extraSelectors: [hostile] });
  const source = renderBridgeScript(config, { test: true });
  const lower = source.toLowerCase();
  assert.equal(lower.includes('</script'), false);
  assert.equal(source.includes('<!--'), false);
  assert.equal(source.includes('{{'), false);
  assert.equal(source.includes('{%'), false);
  assert.equal(source.includes(String.fromCharCode(0x2028)), false);
  assert.equal(source.includes(String.fromCharCode(0x2029)), false);
  // O script, ao rodar, enxerga exatamente o valor original.
  const seen = configSeenByScript(source);
  assert.deepEqual(seen['extraSelectors'], [hostile]);
  assert.equal(seen['proxyPath'], '/apps/checkout-bridge');
});

test('serializeForInlineScript escapa só o que precisa e continua JSON válido', () => {
  const value = { a: '<b>&amp;</b>', b: '{{x}} {%y%} {z}', c: 'linha' + String.fromCharCode(0x2028) + 'outra' + String.fromCharCode(0x2029) };
  const text = serializeForInlineScript(value);
  assert.equal(text, '{"a":"\\u003cb\\u003e\\u0026amp;\\u003c/b\\u003e","b":"\\u007b{x}} \\u007b%y%} {z}","c":"linha\\u2028outra\\u2029"}');
  assert.deepEqual(JSON.parse(text), value);
});

test('renderBridgeScript sanitiza a configuração: chaves desconhecidas, hosts e seletores', () => {
  const dirty = {
    ...baseConfig({
      checkoutHosts: ['A.Example.com', 'a.example.com', 'http://b.example.com/x', '1.2.3.4', 'bad host'],
      extraSelectors: ['  .ok  ', '', 'x'.repeat(201), 'com\u0000controle', '.ok'],
    }),
    acceleratedButtons: 'outro',
    onError: 'qualquer',
    debug: 'sim',
    senha: 'nunca',
  } as unknown as BridgeScriptConfig;
  const seen = configSeenByScript(renderBridgeScript(dirty, { test: true }));
  assert.deepEqual(seen['extraSelectors'], ['.ok']);
  assert.deepEqual(seen['hosts'], ['a.example.com', 'b.example.com']);
  assert.equal(seen['accelerated'], 'hide');
  assert.equal(seen['onError'], 'message');
  assert.equal(seen['debug'], false);
  assert.equal('senha' in seen, false);
  assert.equal(renderBridgeScript(dirty).includes('nunca'), false);
});

test('renderBridgeScript recusa caminho de proxy inválido', () => {
  assert.throws(() => renderBridgeScript(baseConfig({ proxyPath: '/evil/../x' })), /App Proxy/);
  assert.throws(() => renderBridgeScript(baseConfig({ proxyPath: 'https://x.example/apps/a' })), /App Proxy/);
});

test('renderInlineSnippet envolve o script em comentários e num único elemento script', () => {
  const snippet = renderInlineSnippet(baseConfig({ extraSelectors: ['</script>'] }));
  const lines = snippet.split('\n');
  assert.ok(lines[0]?.startsWith('<!-- checkout-bridge'));
  assert.ok(lines[lines.length - 1]?.startsWith('<!-- checkout-bridge'));
  assert.equal(lines[1], '<script>');
  assert.equal(lines[lines.length - 2], '</script>');
  assert.equal(snippet.match(/<script>/g)?.length, 1);
  assert.equal(snippet.match(/<\/script>/gi)?.length, 1);
  assert.equal(snippet.includes('{{'), false);
  assert.equal(snippet.includes('{%'), false);
  // Entre as tags há o script renderizado, igual ao de renderBridgeScript.
  assert.equal(lines.slice(2, -2).join('\n'), renderBridgeScript(baseConfig({ extraSelectors: ['</script>'] })));
});

test('renderLoaderSnippet aponta para bridge.js no caminho do proxy, com defer', () => {
  assert.equal(renderLoaderSnippet('/apps/checkout-bridge'), '<script src="/apps/checkout-bridge/bridge.js" defer></script>');
  assert.throws(() => renderLoaderSnippet('/apps/x" onload="alert(1)'), /App Proxy/);
  assert.throws(() => renderLoaderSnippet(''), /App Proxy/);
});
