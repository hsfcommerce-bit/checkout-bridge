import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hmacSha256Hex } from '../src/lib/crypto.ts';
import { clientIpFromHeaders, hashIp, newRequestId, safeJsonParse, truncate } from '../src/lib/http.ts';

describe('newRequestId', () => {
  it('tem o formato req_ + 16 hex', () => {
    for (let i = 0; i < 50; i += 1) assert.match(newRequestId(), /^req_[0-9a-f]{16}$/);
  });

  it('não se repete', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newRequestId()));
    assert.equal(ids.size, 2000);
  });
});

describe('clientIpFromHeaders', () => {
  const ip = (headers: Record<string, string>, hops?: number): string | null => clientIpFromHeaders(new Headers(headers), hops);

  it('conta os proxies confiáveis a partir da DIREITA de X-Forwarded-For (padrão: 1)', () => {
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5' }), '203.0.113.5');
    // O item da esquerda foi escrito pelo cliente; o da direita, pelo proxy reverso.
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }, 1), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }, 2), '10.0.0.9');
    assert.equal(ip({ 'x-forwarded-for': '1.1.1.1, 10.0.0.9, 203.0.113.5, 172.16.0.9' }, 2), '203.0.113.5');
    assert.equal(ip({ 'X-Forwarded-For': '10.0.0.1 ,  203.0.113.5  ' }), '203.0.113.5');
  });

  it('ignora tudo à esquerda do item escolhido, mesmo IPs válidos, e nunca varre da esquerda para a direita', () => {
    // Forjado pelo cliente e preservado pelo proxy: nunca é usado, nem quando o item certo é inválido.
    assert.equal(ip({ 'x-forwarded-for': '198.51.100.7, unknown' }), null);
    assert.equal(ip({ 'x-forwarded-for': '198.51.100.7, unknown', 'x-real-ip': '203.0.113.5' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '<script>alert(1)</script>, 999.1.1.1, 203.0.113.5' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5, 1.2.3' }, 1), null);
    assert.equal(ip({ 'x-forwarded-for': ', ,_hidden, 198.51.100.7, 203.0.113.5' }, 2), '198.51.100.7');
  });

  it('cabeçalho mais curto que os saltos esperados cai para X-Real-IP, senão null', () => {
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5' }, 2), null);
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '198.51.100.1' }, 2), '198.51.100.1');
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5', 'x-real-ip': '198.51.100.1' }, 1), '203.0.113.5');
  });

  it('zero saltos: X-Forwarded-For é ignorado por inteiro', () => {
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5' }, 0), null);
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '198.51.100.1' }, 0), '198.51.100.1');
  });

  it('saltos inválidos valem 1', () => {
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }, -1), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }, 1.5), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '10.0.0.9, 203.0.113.5' }, Number.NaN), '203.0.113.5');
  });

  it('remove porta e colchetes', () => {
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5:4321' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '[2001:db8::1]:443' }), '2001:db8::1');
    assert.equal(ip({ 'x-forwarded-for': '[2001:db8::1]' }), '2001:db8::1');
    assert.equal(ip({ 'x-forwarded-for': '"203.0.113.9"' }), '203.0.113.9');
    assert.equal(ip({ 'x-forwarded-for': '"[2001:db8::2]:8080"' }), '2001:db8::2');
  });

  it('aceita IPv6 e o devolve na forma canônica', () => {
    assert.equal(ip({ 'x-forwarded-for': '2001:db8::1' }), '2001:db8::1');
    assert.equal(ip({ 'x-forwarded-for': '2001:DB8:0:0:0:0:0:1' }), '2001:db8::1');
    assert.equal(ip({ 'x-forwarded-for': '::1' }), '::1');
    assert.equal(ip({ 'x-forwarded-for': 'fe80::1%eth0' }), 'fe80::1');
  });

  it('converte IPv4 mapeado em IPv6 para IPv4', () => {
    assert.equal(ip({ 'x-forwarded-for': '::ffff:203.0.113.5' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '[::FFFF:203.0.113.5]:80' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '::ffff:cb00:7105' }), '203.0.113.5');
    assert.equal(ip({ 'x-forwarded-for': '0:0:0:0:0:ffff:203.0.113.5' }), '203.0.113.5');
    // Um prefixo parecido que não é o de IPv4 mapeado continua sendo IPv6.
    assert.equal(ip({ 'x-forwarded-for': '::fffe:cb00:7105' }), '::fffe:cb00:7105');
  });

  it('rejeita formas quebradas', () => {
    for (const value of ['[2001:db8::1', '[2001:db8::1]x', '[2001:db8::1]:porta', '2001:db8::1]:80', '1.2.3.4:', ':80', '1.2.3.4:999999', 'a'.repeat(500)]) {
      assert.equal(ip({ 'x-forwarded-for': value }), null, value);
    }
  });

  it('cai para X-Real-IP quando X-Forwarded-For não tem IP válido', () => {
    assert.equal(ip({ 'x-real-ip': '198.51.100.20' }), '198.51.100.20');
    assert.equal(ip({ 'x-forwarded-for': 'unknown', 'x-real-ip': '198.51.100.20' }), '198.51.100.20');
    assert.equal(ip({ 'x-forwarded-for': '', 'x-real-ip': ' [2001:db8::9]:1234 ' }), '2001:db8::9');
    assert.equal(ip({ 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '198.51.100.20' }), '203.0.113.5');
  });

  it('devolve null quando não há IP utilizável', () => {
    assert.equal(ip({}), null);
    assert.equal(ip({ 'x-forwarded-for': '' }), null);
    assert.equal(ip({ 'x-forwarded-for': 'unknown, , nada' }), null);
    assert.equal(ip({ 'x-real-ip': 'não é ip' }), null);
    assert.equal(ip({ 'x-forwarded-for': 'x', 'x-real-ip': 'y' }), null);
    assert.equal(ip({ forwarded: 'for=203.0.113.5', 'cf-connecting-ip': '203.0.113.5' }), null);
  });
});

describe('hashIp', () => {
  const key = Buffer.alloc(32, 9);

  it('null entra, null sai', () => {
    assert.equal(hashIp(null, key), null);
    assert.equal(hashIp(undefined as unknown as null, key), null);
  });

  it('devolve os 32 primeiros hex do HMAC-SHA256', () => {
    const hash = hashIp('203.0.113.5', key);
    assert.match(hash ?? '', /^[0-9a-f]{32}$/);
    assert.equal(hash, hmacSha256Hex(key, '203.0.113.5').slice(0, 32));
  });

  it('é determinístico e depende do IP e da chave', () => {
    assert.equal(hashIp('203.0.113.5', key), hashIp('203.0.113.5', key));
    assert.notEqual(hashIp('203.0.113.5', key), hashIp('203.0.113.6', key));
    assert.notEqual(hashIp('203.0.113.5', key), hashIp('203.0.113.5', Buffer.alloc(32, 8)));
  });

  it('não contém o IP', () => {
    assert.ok(!(hashIp('203.0.113.5', key) ?? '').includes('203'));
    assert.ok(!(hashIp('2001:db8::1', key) ?? '').includes(':'));
  });
});

describe('safeJsonParse', () => {
  it('devolve o valor quando o JSON é válido', () => {
    assert.deepEqual(safeJsonParse('{"a":[1,2,{"b":null}]}'), { ok: true, value: { a: [1, 2, { b: null }] } });
    assert.deepEqual(safeJsonParse('null'), { ok: true, value: null });
    assert.deepEqual(safeJsonParse('0'), { ok: true, value: 0 });
    assert.deepEqual(safeJsonParse('"texto"'), { ok: true, value: 'texto' });
    assert.deepEqual(safeJsonParse(' [] '), { ok: true, value: [] });
  });

  it('nunca lança', () => {
    for (const text of ['', ' ', '{', '{"a":}', "{'a':1}", 'undefined', 'NaN', '{"a":1}x', '\u0000']) {
      assert.deepEqual(safeJsonParse(text), { ok: false }, JSON.stringify(text));
    }
    for (const value of [undefined, null, 5, {}, Buffer.from('{}')]) {
      assert.deepEqual(safeJsonParse(value as unknown as string), { ok: false });
    }
  });

  it('permite tipar o resultado', () => {
    const parsed = safeJsonParse<{ shop: string }>('{"shop":"a.myshopify.com"}');
    assert.ok(parsed.ok);
    assert.equal(parsed.value.shop, 'a.myshopify.com');
  });

  it('não polui protótipos', () => {
    const parsed = safeJsonParse<Record<string, unknown>>('{"__proto__":{"polluted":true}}');
    assert.ok(parsed.ok);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('truncate', () => {
  it('devolve o original quando cabe', () => {
    assert.equal(truncate('abc', 3), 'abc');
    assert.equal(truncate('abc', 10), 'abc');
    assert.equal(truncate('', 5), '');
    assert.equal(truncate('abc', Number.POSITIVE_INFINITY), 'abc');
  });

  it('corta no limite, sem reticências', () => {
    assert.equal(truncate('abcdef', 3), 'abc');
    assert.equal(truncate('abcdef', 1), 'a');
    assert.equal(truncate('abcdef', 5.9), 'abcde');
    assert.equal(truncate('x'.repeat(1000), 255).length, 255);
  });

  it('limite zero, negativo ou inválido devolve vazio', () => {
    assert.equal(truncate('abc', 0), '');
    assert.equal(truncate('abc', -1), '');
    assert.equal(truncate('abc', Number.NaN), '');
    assert.equal(truncate('abc', undefined as unknown as number), '');
  });

  it('não parte um par substituto ao meio', () => {
    // "😀" ocupa duas unidades UTF-16.
    assert.equal(truncate('a😀b', 2), 'a');
    assert.equal(truncate('a😀b', 3), 'a😀');
    assert.equal(truncate('😀😀', 1), '');
    assert.equal(truncate('😀😀', 3), '😀');
    for (let max = 0; max <= 8; max += 1) {
      const out = truncate('😀a😀b😀', max);
      assert.ok(out.length <= max);
      assert.ok(out.isWellFormed(), `max ${max}`);
    }
  });

  it('o resultado é sempre um prefixo do original', () => {
    const text = 'Olá, mundo! こんにちは 🌍';
    for (let max = 0; max <= text.length + 2; max += 1) {
      assert.ok(text.startsWith(truncate(text, max)));
    }
  });
});
