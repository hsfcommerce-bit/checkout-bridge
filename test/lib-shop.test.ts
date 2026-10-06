import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fromGid,
  isCountryCode,
  isValidShopDomain,
  isValidVariantId,
  normalizeCountryCode,
  normalizeHost,
  normalizeShopDomain,
  toGid,
} from '../src/lib/shop.ts';

describe('normalizeShopDomain', () => {
  it('aceita o domínio canônico e as formas que um lojista costuma colar', () => {
    const cases: Array<[string, string]> = [
      ['loja.myshopify.com', 'loja.myshopify.com'],
      ['  Loja.MyShopify.com  ', 'loja.myshopify.com'],
      ['https://loja.myshopify.com', 'loja.myshopify.com'],
      ['http://loja.myshopify.com/', 'loja.myshopify.com'],
      ['HTTPS://LOJA.MYSHOPIFY.COM/', 'loja.myshopify.com'],
      ['https://loja.myshopify.com/admin/products?x=1#y', 'loja.myshopify.com'],
      ['A.MyShopify.com/admin', 'a.myshopify.com'],
      ['loja-1.myshopify.com', 'loja-1.myshopify.com'],
      ['1loja.myshopify.com///', '1loja.myshopify.com'],
      ['loja.myshopify.com?x=1', 'loja.myshopify.com'],
      ['loja.myshopify.com#frag', 'loja.myshopify.com'],
      ['\tloja.myshopify.com\n', 'loja.myshopify.com'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeShopDomain(input), expected, JSON.stringify(input));
    }
  });

  it('rejeita entradas hostis', () => {
    const hostile = [
      // O host de verdade é outro
      'evil.com/x.myshopify.com',
      'evil.com?x.myshopify.com',
      'evil.com#x.myshopify.com',
      'https://evil.com/a.myshopify.com',
      'https://evil.com?shop=a.myshopify.com',
      'a.myshopify.com.evil.com',
      'https://a.myshopify.com.evil.com/',
      'a.myshopify.com.br',
      // Subdomínio extra
      'a.b.myshopify.com',
      '.a.myshopify.com',
      // Userinfo
      'user@a.myshopify.com',
      'https://user:pass@a.myshopify.com',
      'https://evil.com@a.myshopify.com',
      'https://a.myshopify.com@evil.com',
      'a.myshopify.com@evil.com',
      // Porta
      'a.myshopify.com:443',
      'https://a.myshopify.com:443/admin',
      'a.myshopify.com:evil.com',
      // Barras invertidas, codificação e caracteres de controle
      'https://evil.com\\@a.myshopify.com',
      'a.myshopify.com\\.evil.com',
      'a.myshopify.com%2f.evil.com',
      'a%2emyshopify.com',
      'a.myshopify.com\n.evil.com',
      'a.myshopify.com\r\nHost: evil.com',
      'a.myshopify.com\u0000',
      'a.myshopify.com evil.com',
      'a .myshopify.com',
      // Unicode parecido com ASCII (U+212A vira "k" no toLowerCase)
      'K.myshopify.com',
      'ａ.myshopify.com',
      'a.myshopify.cоm',
      'a。myshopify。com',
      // Protocolos e formas estranhas
      'ftp://a.myshopify.com',
      'javascript://a.myshopify.com',
      '//a.myshopify.com',
      'https://https://a.myshopify.com',
      'https:/a.myshopify.com',
      'https:a.myshopify.com',
      // Quase certo
      'a.myshopify.com.',
      'myshopify.com',
      '.myshopify.com',
      '-a.myshopify.com',
      'a_b.myshopify.com',
      'a.myshopify.co',
      'a.myshopify.comm',
      'amyshopify.com',
      'a.myshopifyXcom',
      'a-myshopify.com',
      'a.shopify.com',
      'admin.shopify.com/store/a',
      'a',
      '',
      '   ',
      'https://',
    ];
    for (const input of hostile) {
      assert.equal(normalizeShopDomain(input), null, JSON.stringify(input));
    }
  });

  it('respeita o limite de 63 caracteres do rótulo', () => {
    assert.equal(normalizeShopDomain(`${'a'.repeat(63)}.myshopify.com`), `${'a'.repeat(63)}.myshopify.com`);
    assert.equal(normalizeShopDomain(`${'a'.repeat(64)}.myshopify.com`), null);
    assert.equal(normalizeShopDomain(`${'a'.repeat(5000)}.myshopify.com`), null);
  });

  it('rejeita o que não é string', () => {
    for (const input of [null, undefined, 123, {}, ['a.myshopify.com']]) {
      assert.equal(normalizeShopDomain(input as unknown as string), null);
    }
  });

  it('tudo o que devolve passa na checagem estrita', () => {
    for (const input of ['Loja.myshopify.com', 'https://x-1.myshopify.com/a/b', ' 9.myshopify.com ']) {
      const out = normalizeShopDomain(input);
      assert.ok(out !== null && isValidShopDomain(out), input);
    }
  });
});

describe('isValidShopDomain', () => {
  it('aceita só a forma canônica', () => {
    assert.equal(isValidShopDomain('a.myshopify.com'), true);
    assert.equal(isValidShopDomain('loja-teste-2.myshopify.com'), true);
    assert.equal(isValidShopDomain('0.myshopify.com'), true);
  });

  it('não normaliza nada', () => {
    const invalid = [
      'A.myshopify.com',
      'a.MYSHOPIFY.com',
      ' a.myshopify.com',
      'a.myshopify.com ',
      'a.myshopify.com\n',
      'https://a.myshopify.com',
      'a.myshopify.com/',
      'a.myshopify.com:443',
      'a.b.myshopify.com',
      'a.myshopify.com.evil.com',
      'user@a.myshopify.com',
      '-a.myshopify.com',
      'myshopify.com',
      '',
    ];
    for (const input of invalid) {
      assert.equal(isValidShopDomain(input), false, JSON.stringify(input));
    }
    assert.equal(isValidShopDomain(undefined as unknown as string), false);
  });
});

describe('normalizeHost', () => {
  it('devolve só o hostname em minúsculas', () => {
    const cases: Array<[string, string]> = [
      ['loja.com', 'loja.com'],
      ['www.Loja.com.br', 'www.loja.com.br'],
      ['  LOJA.COM  ', 'loja.com'],
      ['https://loja.com/', 'loja.com'],
      ['http://www.loja.com/produtos?x=1#y', 'www.loja.com'],
      ['loja.com:8443', 'loja.com'],
      ['https://loja.com:443/checkout', 'loja.com'],
      ['loja.com.', 'loja.com'],
      ['a.myshopify.com', 'a.myshopify.com'],
      ['sub-dominio.loja-1.com', 'sub-dominio.loja-1.com'],
      ['xn--espaol-zwa.com', 'xn--espaol-zwa.com'],
      ['bridge.test', 'bridge.test'],
      ['localhost', 'localhost'],
      ['http://LOCALHOST:8787/admin', 'localhost'],
      ['4you.com', '4you.com'],
      ['loja.c0m', 'loja.c0m'],
      [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeHost(input), expected, JSON.stringify(input));
    }
  });

  it('converte nomes internacionalizados para punycode', () => {
    assert.equal(normalizeHost('español.com'), 'xn--espaol-zwa.com');
    assert.equal(normalizeHost('https://Lojä.com.br/'), 'xn--loj-sla.com.br');
  });

  it('rejeita o que não é um hostname válido', () => {
    const invalid = [
      '',
      '   ',
      '.',
      // Endereços IP, em qualquer grafia que o navegador aceitaria
      '127.0.0.1',
      '10.0.0.1:8080',
      'http://192.168.0.1/',
      '2130706433',
      '0x7f.1',
      '1.2.3.0x4',
      '::1',
      '[::1]',
      '[2001:db8::1]:443',
      'user@loja.com',
      'https://user:pass@loja.com',
      'loja.com@evil.com',
      'loja..com',
      '.loja.com',
      '-loja.com',
      'loja-.com',
      'lo_ja.com',
      'loja.com:abc',
      'loja.com:999999',
      'loja .com',
      'loja.com\\@evil.com',
      'loja.com%2f.evil.com',
      '%6c%6f%6a%61.com',
      'ftp://loja.com',
      'javascript:alert(1)',
      '//loja.com',
      'loja.123',
      'https://',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(130)}com`,
    ];
    for (const input of invalid) {
      assert.equal(normalizeHost(input), null, JSON.stringify(input));
    }
    for (const input of [null, undefined, 42, {}]) {
      assert.equal(normalizeHost(input as unknown as string), null);
    }
  });

  it('não deixa o caminho ou a query virarem host', () => {
    assert.equal(normalizeHost('evil.com/loja.com'), 'evil.com');
    assert.equal(normalizeHost('evil.com?loja.com'), 'evil.com');
    assert.equal(normalizeHost('evil.com#loja.com'), 'evil.com');
  });
});

describe('isValidVariantId', () => {
  it('aceita de 1 a 20 dígitos sem zero à esquerda', () => {
    for (const id of ['1', '9', '42', '44556677889900', '12345678901234567890']) {
      assert.equal(isValidVariantId(id), true, id);
    }
  });

  it('rejeita o resto', () => {
    const invalid = ['', '0', '01', '123456789012345678901', '12a', 'a12', '-1', '+1', '1.0', ' 1', '1 ', '1\n', '١', '１', '1e3', 'gid://shopify/ProductVariant/1'];
    for (const id of invalid) {
      assert.equal(isValidVariantId(id), false, JSON.stringify(id));
    }
    for (const id of [1, null, undefined, 1n, {}]) {
      assert.equal(isValidVariantId(id as unknown as string), false);
    }
  });
});

describe('toGid e fromGid', () => {
  it('monta o GID', () => {
    assert.equal(toGid('ProductVariant', '123'), 'gid://shopify/ProductVariant/123');
    assert.equal(toGid('Product', '9'), 'gid://shopify/Product/9');
  });

  it('toGid rejeita id não numérico', () => {
    for (const id of ['', '0', 'abc', '1/2', '1?x=1', ' 1', 'gid://shopify/Product/1', '../1']) {
      assert.throws(() => toGid('Product', id), Error, JSON.stringify(id));
    }
  });

  it('extrai a parte numérica', () => {
    assert.equal(fromGid('gid://shopify/ProductVariant/123'), '123');
    assert.equal(fromGid('gid://shopify/Product/9'), '9');
    assert.equal(fromGid('gid://shopify/InventoryItem/5'), '5');
    assert.equal(fromGid('gid://shopify/ProductVariant/12345678901234567890'), '12345678901234567890');
  });

  it('fromGid lança em formato inesperado', () => {
    const malformed = [
      '',
      '123',
      'gid://shopify/ProductVariant/',
      'gid://shopify/ProductVariant/abc',
      'gid://shopify/ProductVariant/123?x=1',
      'gid://shopify/ProductVariant/123/456',
      'gid://shopify/ProductVariant/0',
      'gid://shopify/ProductVariant/01',
      'gid://shopify/ProductVariant/-1',
      'gid://shopify/ProductVariant/123456789012345678901',
      'gid://shopify//123',
      'gid://shopify/123',
      'gid://other/ProductVariant/123',
      'GID://shopify/ProductVariant/123',
      ' gid://shopify/Product/1',
      'gid://shopify/Product/1 ',
      'gid://shopify/Product/1\n',
      'xgid://shopify/Product/1',
      'gid://shopify/Pro duct/1',
    ];
    for (const gid of malformed) {
      assert.throws(() => fromGid(gid), Error, JSON.stringify(gid));
    }
    assert.throws(() => fromGid(null as unknown as string), Error);
  });

  it('ida e volta', () => {
    for (const id of ['1', '987654321', '12345678901234567890']) {
      assert.equal(fromGid(toGid('ProductVariant', id)), id);
      assert.equal(fromGid(toGid('Product', id)), id);
    }
  });
});

describe('códigos de país', () => {
  it('isCountryCode é estrito', () => {
    assert.equal(isCountryCode('BR'), true);
    assert.equal(isCountryCode('US'), true);
    for (const input of ['br', 'Br', 'B', 'BRA', 'B1', '', ' BR', 'BR ', 'BR\n', 'ÉÉ', '--']) {
      assert.equal(isCountryCode(input), false, JSON.stringify(input));
    }
    assert.equal(isCountryCode(null as unknown as string), false);
  });

  it('normalizeCountryCode põe em maiúsculas', () => {
    assert.equal(normalizeCountryCode('br'), 'BR');
    assert.equal(normalizeCountryCode('Us'), 'US');
    assert.equal(normalizeCountryCode(' pt '), 'PT');
    assert.equal(normalizeCountryCode('BR'), 'BR');
  });

  it('normalizeCountryCode devolve null quando inválido', () => {
    for (const input of [null, undefined, '', ' ', 'B', 'BRA', 'b1', '1b', 'b r', 'b-', '<b']) {
      assert.equal(normalizeCountryCode(input), null, JSON.stringify(input));
    }
    assert.equal(normalizeCountryCode(55 as unknown as string), null);
  });

  it('não é enganado por caracteres que mudam de tamanho ao trocar a caixa', () => {
    // "ß".toUpperCase() === "SS"; "ı" (i sem ponto) vira "I"; "ſ" (s longo) vira "S".
    assert.equal(normalizeCountryCode('ß'), null);
    assert.equal(normalizeCountryCode('ıd'), null);
    assert.equal(normalizeCountryCode('uſ'), null);
  });
});
