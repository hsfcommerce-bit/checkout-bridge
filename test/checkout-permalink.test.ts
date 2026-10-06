import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCartPermalink, MAX_PERMALINK_LENGTH } from '../src/checkout/permalink.ts';
import { isBridgeError } from '../src/types.ts';
import { expectBridgeError } from './db-helpers.ts';

describe('buildCartPermalink', () => {
  it('monta o caminho documentado', () => {
    const url = buildCartPermalink({ host: 'loja.myshopify.com', lines: [{ variantId: '70881412', quantity: 1 }, { variantId: '70881382', quantity: 2 }] });
    assert.equal(url, 'https://loja.myshopify.com/cart/70881412:1,70881382:2');
  });

  it('funde variantes repetidas somando as quantidades, na ordem da primeira ocorrência', () => {
    const url = buildCartPermalink({
      host: 'loja.com.br',
      lines: [
        { variantId: '1', quantity: 1 },
        { variantId: '2', quantity: 1 },
        { variantId: '1', quantity: 3 },
      ],
    });
    assert.equal(url, 'https://loja.com.br/cart/1:4,2:1');
  });

  it('codifica cupons e atributos corretamente', () => {
    const url = buildCartPermalink({
      host: 'loja.com.br',
      lines: [{ variantId: '1', quantity: 1 }],
      discountCodes: ['PROMO 10', 'ÇÃO&X'],
      attributes: [
        { key: 'bridge_session', value: 'cs_abc' },
        { key: 'utm_source', value: 'meta ads/&?' },
        { key: 'estranho]=x', value: 'a=b' },
      ],
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://loja.com.br');
    assert.equal(parsed.pathname, '/cart/1:1');
    assert.equal(parsed.searchParams.get('discount'), 'PROMO 10,ÇÃO&X');
    assert.equal(parsed.searchParams.get('attributes[bridge_session]'), 'cs_abc');
    assert.equal(parsed.searchParams.get('attributes[utm_source]'), 'meta ads/&?');
    assert.equal(parsed.searchParams.get('attributes[estranho]=x]'), 'a=b');
    assert.equal([...parsed.searchParams.keys()].length, 4);
    // A vírgula entre cupons fica literal, como no exemplo da documentação.
    assert.ok(url.includes('discount=PROMO%2010,%C3%87%C3%83O%26X'));
  });

  it('atributo com chave repetida: fica o primeiro', () => {
    const url = buildCartPermalink({
      host: 'loja.com.br',
      lines: [{ variantId: '1', quantity: 1 }],
      attributes: [
        { key: 'k', value: 'primeiro' },
        { key: 'k', value: 'segundo' },
      ],
    });
    assert.equal(new URL(url).searchParams.getAll('attributes[k]').join('|'), 'primeiro');
  });

  it('rejeita host inválido ou que não é um host puro', () => {
    for (const host of ['', 'https://loja.com.br/x', 'loja.com.br:8443', 'user@loja.com.br', '127.0.0.1', 'loja com.br', 'loja.com.br/', 'xn--']) {
      expectBridgeError(() => buildCartPermalink({ host, lines: [{ variantId: '1', quantity: 1 }] }), 'invalid_request');
    }
    // Só a caixa difere do host canônico: aceito e normalizado.
    assert.ok(buildCartPermalink({ host: 'Loja.COM.br', lines: [{ variantId: '1', quantity: 1 }] }).startsWith('https://loja.com.br/'));
  });

  it('rejeita linhas inválidas', () => {
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: 'abc', quantity: 1 }] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 0 }] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 1.5 }] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: -2 }] }), 'invalid_request');
  });

  it('rejeita cupom com vírgula ou vazio e atributo malformado', () => {
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 1 }], discountCodes: ['A,B'] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 1 }], discountCodes: [''] }), 'invalid_request');
    expectBridgeError(() => buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 1 }], attributes: [{ key: '', value: 'x' }] }), 'invalid_request');
  });

  it('rejeita URL acima do teto de tamanho com o motivo permalink_too_long', () => {
    const err = expectBridgeError(
      () =>
        buildCartPermalink({
          host: 'loja.com.br',
          lines: [{ variantId: '1', quantity: 1 }],
          attributes: [{ key: 'grande', value: 'x'.repeat(MAX_PERMALINK_LENGTH) }],
        }),
      'invalid_request',
    );
    assert.ok(isBridgeError(err));
    assert.equal(err.details['reason'], 'permalink_too_long');
  });

  it('não oferece nenhum caminho para dados pessoais (sem note, email ou endereço)', () => {
    const url = buildCartPermalink({ host: 'loja.com.br', lines: [{ variantId: '1', quantity: 1 }], attributes: [{ key: 'bridge_source', value: 'v.myshopify.com' }] });
    assert.ok(!url.includes('checkout['));
    assert.ok(!url.includes('note='));
  });
});
