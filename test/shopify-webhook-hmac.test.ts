import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { signWebhookBody, verifyWebhookHmac } from '../src/shopify/webhook-hmac.ts';

const SECRET = 'shpss_segredo_de_teste';

/** Cálculo independente, direto no node:crypto, sem passar pelo código testado. */
function independentDigest(body: Uint8Array | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('signWebhookBody', () => {
  it('bate com o HMAC-SHA256 em base64 calculado pelo node:crypto', () => {
    const body = '{"id":788032119674292922,"title":"Camiseta"}';
    assert.equal(signWebhookBody(body, SECRET), independentDigest(body, SECRET));
    assert.equal(signWebhookBody(bytes(body), SECRET), independentDigest(body, SECRET));
  });

  it('bate com um vetor conhecido (RFC 4231, caso 2)', () => {
    // Chave "Jefe", dado "what do ya want for nothing?".
    const expectedHex = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    const expected = Buffer.from(expectedHex, 'hex').toString('base64');
    assert.equal(signWebhookBody('what do ya want for nothing?', 'Jefe'), expected);
  });

  it('assina os bytes como vieram, inclusive os que não são UTF-8 válido', () => {
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0x7d]);
    assert.equal(signWebhookBody(raw, SECRET), independentDigest(raw, SECRET));
  });

  it('respeita o trecho de uma visão sobre um buffer maior', () => {
    const big = bytes('xxxx{"id":1}yyyy');
    const view = big.subarray(4, 12);
    assert.equal(new TextDecoder().decode(view), '{"id":1}');
    assert.equal(signWebhookBody(view, SECRET), independentDigest('{"id":1}', SECRET));
  });
});

describe('verifyWebhookHmac', () => {
  const body = bytes('{"id":1234567890,"admin_graphql_api_id":"gid://shopify/Product/1234567890"}');
  const valid = independentDigest(body, SECRET);

  it('aceita a assinatura correta', () => {
    assert.equal(verifyWebhookHmac(body, valid, SECRET), true);
  });

  it('tolera espaços em volta do valor do cabeçalho', () => {
    assert.equal(verifyWebhookHmac(body, `  ${valid} `, SECRET), true);
  });

  it('aceita corpo vazio assinado', () => {
    const empty = new Uint8Array(0);
    assert.equal(verifyWebhookHmac(empty, independentDigest(empty, SECRET), SECRET), true);
  });

  it('recusa cabeçalho ausente ou vazio', () => {
    assert.equal(verifyWebhookHmac(body, null, SECRET), false);
    assert.equal(verifyWebhookHmac(body, undefined, SECRET), false);
    assert.equal(verifyWebhookHmac(body, '', SECRET), false);
    assert.equal(verifyWebhookHmac(body, '   ', SECRET), false);
  });

  it('recusa corpo adulterado, mesmo em um único byte', () => {
    const tampered = Uint8Array.from(body);
    tampered[6] = (tampered[6] ?? 0) ^ 1;
    assert.equal(verifyWebhookHmac(tampered, valid, SECRET), false);
    // Espaço a mais muda os bytes: é por isso que o corpo não pode ser reserializado.
    assert.equal(verifyWebhookHmac(bytes(`${new TextDecoder().decode(body)} `), valid, SECRET), false);
  });

  it('recusa assinatura feita com outro segredo', () => {
    assert.equal(verifyWebhookHmac(body, independentDigest(body, 'outro-segredo'), SECRET), false);
  });

  it('recusa o digest certo em outra codificação ou cortado', () => {
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifyWebhookHmac(body, hex, SECRET), false);
    assert.equal(verifyWebhookHmac(body, valid.slice(0, -2), SECRET), false);
    assert.equal(verifyWebhookHmac(body, valid.toLowerCase(), SECRET), valid === valid.toLowerCase());
  });

  it('recusa segredo vazio, ainda que a assinatura confira com a chave vazia', () => {
    assert.equal(verifyWebhookHmac(body, independentDigest(body, ''), ''), false);
  });
});
