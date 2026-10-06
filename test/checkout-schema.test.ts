import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROPERTY_LIMITS } from '../src/checkout/limits.ts';
import { ATTRIBUTION_KEYS, parseCheckoutBody } from '../src/checkout/schema.ts';

function ok(body: unknown) {
  const parsed = parseCheckoutBody(body);
  assert.ok(parsed.ok, `esperava corpo válido, veio: ${parsed.ok ? '' : parsed.message}`);
  return parsed.value;
}

function fail(body: unknown): string {
  const parsed = parseCheckoutBody(body);
  assert.equal(parsed.ok, false, 'esperava corpo inválido');
  return parsed.ok ? '' : parsed.message;
}

describe('parseCheckoutBody: forma básica', () => {
  it('aceita o corpo mínimo e normaliza os campos', () => {
    const value = ok({ lines: [{ variantId: 44001, quantity: 2 }], country: 'br', cartToken: 'tok-1' });
    assert.deepEqual(value, { lines: [{ variantId: '44001', quantity: 2 }], cartToken: 'tok-1', country: 'BR' });
  });

  it('aceita todos os campos opcionais', () => {
    const value = ok({
      lines: [{ variantId: '1', quantity: 1, properties: { Gravação: 'Oi' }, hasSellingPlan: false }],
      language: 'pt-BR',
      discountCodes: [' PROMO10 ', 'promo10', 'OUTRO'],
      attribution: { utm_source: 'meta', fbclid: 'abc', ignorado: 'x' },
      consent: { analytics: true, marketing: false, preferences: true, saleOfData: false },
      source: 'buy_now',
    });
    assert.deepEqual(value.lines, [{ variantId: '1', quantity: 1, properties: { Gravação: 'Oi' } }]);
    assert.equal(value.language, 'pt-BR');
    assert.deepEqual(value.discountCodes, ['PROMO10', 'OUTRO']);
    assert.deepEqual(value.attribution, { utm_source: 'meta', fbclid: 'abc' });
    assert.deepEqual(value.consent, { analytics: true, marketing: false, preferences: true, saleOfData: false });
    assert.equal(value.source, 'buy_now');
  });

  it('trata null como ausente nos campos opcionais', () => {
    const value = ok({ lines: [{ variantId: '1', quantity: 1, properties: null }], country: null, cartToken: '', attribution: null });
    assert.deepEqual(value, { lines: [{ variantId: '1', quantity: 1 }] });
  });

  it('rejeita corpo que não é objeto, sem linhas ou com array vazio', () => {
    assert.equal(fail(null), 'Corpo da requisição inválido.');
    assert.equal(fail([]), 'Corpo da requisição inválido.');
    assert.equal(fail({}), 'Campo inválido: lines.');
    assert.equal(fail({ lines: [] }), 'Campo inválido: lines.');
    assert.equal(fail({ lines: 'x' }), 'Campo inválido: lines.');
  });

  it('rejeita mais de 250 linhas', () => {
    const lines = Array.from({ length: 251 }, (_, i) => ({ variantId: String(i + 1), quantity: 1 }));
    assert.equal(fail({ lines }), 'Campo inválido: lines.');
  });

  it('rejeita a chave "price" no topo sem repetir o valor', () => {
    const message = fail({ lines: [{ variantId: '1', quantity: 1 }], price: '0.01' });
    assert.equal(message, 'Campo não permitido: price.');
    assert.ok(!message.includes('0.01'));
  });

  it('rejeita "price" dentro da linha', () => {
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, price: 1 }] }), 'Campo não permitido: lines[0].price.');
  });

  it('não repete nome de chave desconhecida que não é identificador simples', () => {
    const message = fail({ lines: [{ variantId: '1', quantity: 1 }], '<script>alert(1)</script>': 1 });
    assert.equal(message, 'Campo não permitido na requisição.');
  });
});

describe('parseCheckoutBody: linhas', () => {
  it('rejeita variantId inválido e aponta a linha', () => {
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1 }, { variantId: 'abc', quantity: 1 }] }), 'Campo inválido: lines[1].variantId.');
    assert.equal(fail({ lines: [{ variantId: '0123', quantity: 1 }] }), 'Campo inválido: lines[0].variantId.');
    assert.equal(fail({ lines: [{ variantId: 1.5, quantity: 1 }] }), 'Campo inválido: lines[0].variantId.');
    assert.equal(fail({ lines: [{ variantId: 2 ** 60, quantity: 1 }] }), 'Campo inválido: lines[0].variantId.');
    assert.equal(fail({ lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }] }), 'Campo inválido: lines[0].variantId.');
    assert.equal(fail({ lines: [{ quantity: 1 }] }), 'Campo inválido: lines[0].variantId.');
  });

  it('rejeita quantidade fora de 1..1000000 ou não inteira', () => {
    for (const quantity of [0, -1, 1.5, 1_000_001, '2', null]) {
      assert.equal(fail({ lines: [{ variantId: '1', quantity }] }), 'Campo inválido: lines[0].quantity.');
    }
    assert.equal(ok({ lines: [{ variantId: '1', quantity: 1_000_000 }] }).lines[0]?.quantity, 1_000_000);
  });

  it('saneia propriedades: coerção, chaves privadas e vazios', () => {
    const value = ok({
      lines: [{ variantId: '1', quantity: 1, properties: { a: 1, b: true, __private: 'x', vazio: '', nulo: null, c: 'texto' } }],
    });
    assert.deepEqual(value.lines[0]?.properties, { a: '1', b: 'true', c: 'texto' });
  });

  it('rejeita propriedades fora dos limites sem repetir a chave do comprador', () => {
    // Os limites são os de src/checkout/limits.ts, compartilhados com o script do tema.
    const many = Object.fromEntries(Array.from({ length: PROPERTY_LIMITS.maxProperties + 1 }, (_, i) => [`k${i}`, 'v']));
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, properties: many }] }), 'Campo inválido: lines[0].properties.');
    const longKey = { ['x'.repeat(PROPERTY_LIMITS.maxKeyLength + 1)]: 'v' };
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, properties: longKey }] }), 'Campo inválido: lines[0].properties.');
    const longValue = { chave: 'v'.repeat(PROPERTY_LIMITS.maxValueLength + 1) };
    const message = fail({ lines: [{ variantId: '1', quantity: 1, properties: longValue }] });
    assert.equal(message, 'Campo inválido: lines[0].properties.');
    // No limite exato passa: é o mesmo número que o script usa para não enviar o que seria recusado.
    const atLimit = {
      ...Object.fromEntries(Array.from({ length: PROPERTY_LIMITS.maxProperties - 1 }, (_, i) => [`k${i}`, 'v'])),
      ['x'.repeat(PROPERTY_LIMITS.maxKeyLength)]: 'v'.repeat(PROPERTY_LIMITS.maxValueLength),
    };
    assert.equal(Object.keys(ok({ lines: [{ variantId: '1', quantity: 1, properties: atLimit }] }).lines[0]?.properties ?? {}).length, PROPERTY_LIMITS.maxProperties);
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, properties: { obj: { a: 1 } } }] }), 'Campo inválido: lines[0].properties.');
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, properties: ['a'] }] }), 'Campo inválido: lines[0].properties.');
  });

  it('só marca hasSellingPlan quando true', () => {
    assert.equal(ok({ lines: [{ variantId: '1', quantity: 1, hasSellingPlan: true }] }).lines[0]?.hasSellingPlan, true);
    assert.equal(ok({ lines: [{ variantId: '1', quantity: 1, hasSellingPlan: false }] }).lines[0]?.hasSellingPlan, undefined);
    assert.equal(fail({ lines: [{ variantId: '1', quantity: 1, hasSellingPlan: 'sim' }] }), 'Campo inválido: lines[0].hasSellingPlan.');
  });
});

describe('parseCheckoutBody: demais campos', () => {
  const lines = [{ variantId: '1', quantity: 1 }];

  it('cartToken até 200 caracteres', () => {
    assert.equal(ok({ lines, cartToken: 'a'.repeat(200) }).cartToken?.length, 200);
    assert.equal(fail({ lines, cartToken: 'a'.repeat(201) }), 'Campo inválido: cartToken.');
    assert.equal(fail({ lines, cartToken: 5 }), 'Campo inválido: cartToken.');
  });

  it('país com duas letras, em maiúsculas', () => {
    assert.equal(ok({ lines, country: 'us' }).country, 'US');
    assert.equal(fail({ lines, country: 'BRA' }), 'Campo inválido: country.');
    assert.equal(fail({ lines, country: 'ß1' }), 'Campo inválido: country.');
  });

  it('idioma curto no formato BCP 47', () => {
    assert.equal(ok({ lines, language: 'pt' }).language, 'pt');
    assert.equal(ok({ lines, language: 'zh-Hant-TW' }).language, 'zh-Hant-TW');
    assert.equal(fail({ lines, language: 'portugues-do-brasil' }), 'Campo inválido: language.');
    assert.equal(fail({ lines, language: 'pt_BR' }), 'Campo inválido: language.');
  });

  it('cupons: até 5, de 1 a 64 caracteres, sem vírgula nem controle', () => {
    assert.equal(fail({ lines, discountCodes: ['a', 'b', 'c', 'd', 'e', 'f'] }), 'Campo inválido: discountCodes.');
    assert.equal(fail({ lines, discountCodes: ['A,B'] }), 'Campo inválido: discountCodes[0].');
    assert.equal(fail({ lines, discountCodes: ['A\nB'] }), 'Campo inválido: discountCodes[0].');
    assert.equal(fail({ lines, discountCodes: ['   '] }), 'Campo inválido: discountCodes[0].');
    assert.equal(fail({ lines, discountCodes: ['x'.repeat(65)] }), 'Campo inválido: discountCodes[0].');
    assert.equal(fail({ lines, discountCodes: 'PROMO' }), 'Campo inválido: discountCodes.');
    assert.equal(ok({ lines, discountCodes: [] }).discountCodes, undefined);
  });

  it('atribuição: só chaves permitidas, sem controle, truncada em 500', () => {
    const value = ok({
      lines,
      attribution: {
        utm_source: ' meta\u0000\n ',
        gclid: 'g'.repeat(600),
        email: 'pessoa@exemplo.com',
        utm_medium: 42,
        fbp: '',
      },
    });
    assert.deepEqual(value.attribution, { utm_source: 'meta', gclid: 'g'.repeat(500) });
    assert.equal(fail({ lines, attribution: ['utm_source'] }), 'Campo inválido: attribution.');
    assert.equal(fail({ lines, attribution: 'utm_source=x' }), 'Campo inválido: attribution.');
    assert.equal(ok({ lines, attribution: { outra: 'x' } }).attribution, undefined);
  });

  it('lista de atribuição contém as chaves esperadas', () => {
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid', 'fbp', 'fbc', 'ga', 'ttp']) {
      assert.ok(ATTRIBUTION_KEYS.includes(key), key);
    }
    assert.equal(ATTRIBUTION_KEYS.length, 16);
  });

  it('consentimento exige os quatro booleanos', () => {
    assert.equal(fail({ lines, consent: { analytics: true } }), 'Campo inválido: consent.marketing.');
    assert.equal(fail({ lines, consent: { analytics: 'sim', marketing: true, preferences: true, saleOfData: true } }), 'Campo inválido: consent.analytics.');
  });

  it('source só aceita cart ou buy_now', () => {
    assert.equal(ok({ lines, source: 'cart' }).source, 'cart');
    assert.equal(fail({ lines, source: 'api' }), 'Campo inválido: source.');
  });

  it('clientNonce: 8 a 64 caracteres de [A-Za-z0-9_-]; ausente ou null fica de fora', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(ok({ lines, clientNonce: uuid }).clientNonce, uuid);
    assert.equal(ok({ lines, clientNonce: 'a-b_C8' + 'x'.repeat(58) }).clientNonce?.length, 64);
    assert.equal(ok({ lines, clientNonce: 'abcdefgh' }).clientNonce, 'abcdefgh');
    assert.equal(ok({ lines }).clientNonce, undefined);
    assert.equal(ok({ lines, clientNonce: null }).clientNonce, undefined);
    assert.equal(fail({ lines, clientNonce: 'abcdefg' }), 'Campo inválido: clientNonce.');
    assert.equal(fail({ lines, clientNonce: 'x'.repeat(65) }), 'Campo inválido: clientNonce.');
    assert.equal(fail({ lines, clientNonce: 'abc def ghi' }), 'Campo inválido: clientNonce.');
    assert.equal(fail({ lines, clientNonce: 'abcdefgh\n' }), 'Campo inválido: clientNonce.');
    assert.equal(fail({ lines, clientNonce: 12345678 }), 'Campo inválido: clientNonce.');
    assert.equal(fail({ lines, clientNonce: 'abcdefgh', nonce: 'x' }), 'Campo não permitido: nonce.');
  });
});
