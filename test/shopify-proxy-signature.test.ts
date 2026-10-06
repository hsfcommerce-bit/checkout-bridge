import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  computeProxySignature,
  peekProxyShop,
  signAppProxyQuery,
  verifyAppProxySignature,
} from '../src/shopify/proxy-signature.ts';

const SECRET = 'shpss_segredo_de_teste';
const SHOP = 'vitrine-teste.myshopify.com';
/** 2026-10-05T12:00:00Z em segundos. */
const TS = Date.UTC(2026, 9, 5, 12, 0, 0) / 1000;
const NOW = new Date(TS * 1000);
const OPTS = { maxAgeSeconds: 90, now: NOW };

function baseParams(overrides: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  return {
    shop: SHOP,
    logged_in_customer_id: '',
    path_prefix: '/apps/checkout-bridge',
    timestamp: String(TS),
    ...overrides,
  };
}

function reasonOf(query: string, secret: string = SECRET, opts = OPTS): string {
  const result = verifyAppProxySignature(query, secret, opts);
  return result.ok ? 'ok' : result.reason;
}

describe('computeProxySignature: vetor documentado pela Shopify', () => {
  // A página publica a query com o marcador literal "{shop}.myshopify.com"; os dois digests
  // documentados (segredo "hush") fecham com shop-name.myshopify.com, o valor do exemplo
  // original. Os demais parâmetros são exatamente os documentados.
  const documented =
    'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1' +
    '&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555';

  it('reproduz o digest do comprador logado', () => {
    const expected = '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb';
    assert.equal(computeProxySignature(documented, 'hush'), expected);
    // A presença de signature na query não muda a conta.
    assert.equal(computeProxySignature(`${documented}&signature=${expected}`, 'hush'), expected);
  });

  it('reproduz o digest do comprador anônimo (valor vazio preservado)', () => {
    const anonymous = documented.replace('logged_in_customer_id=1', 'logged_in_customer_id=');
    assert.equal(
      computeProxySignature(anonymous, 'hush'),
      'e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb',
    );
  });

  it('verifica o vetor documentado de ponta a ponta', () => {
    const query = `${documented}&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb`;
    const result = verifyAppProxySignature(query, 'hush', { maxAgeSeconds: 90, now: new Date(1317327555 * 1000) });
    assert.deepEqual(result, {
      ok: true,
      shop: 'shop-name.myshopify.com',
      pathPrefix: '/apps/awesome_reviews',
      loggedInCustomerId: '1',
      timestamp: 1317327555,
    });
  });

  it('a ordem dos parâmetros na query não importa, a ordem dos valores repetidos sim', () => {
    const reordered =
      'timestamp=1317327555&path_prefix=%2Fapps%2Fawesome_reviews&extra=1&shop=shop-name.myshopify.com' +
      '&logged_in_customer_id=1&extra=2';
    assert.equal(computeProxySignature(reordered, 'hush'), computeProxySignature(documented, 'hush'));
    const swapped = documented.replace('extra=1&extra=2', 'extra=2&extra=1');
    assert.notEqual(computeProxySignature(swapped, 'hush'), computeProxySignature(documented, 'hush'));
  });

  it('devolve null para query malformada', () => {
    assert.equal(computeProxySignature('shop=%E0%A4%A', 'hush'), null);
    assert.equal(computeProxySignature('a=%', 'hush'), null);
    assert.equal(computeProxySignature('%zz=1', 'hush'), null);
  });
});

describe('verifyAppProxySignature', () => {
  it('aceita uma query assinada e devolve os campos verificados', () => {
    const query = signAppProxyQuery(baseParams({ logged_in_customer_id: '7001' }), SECRET);
    assert.deepEqual(verifyAppProxySignature(query, SECRET, OPTS), {
      ok: true,
      shop: SHOP,
      pathPrefix: '/apps/checkout-bridge',
      loggedInCustomerId: '7001',
      timestamp: TS,
    });
  });

  it('comprador anônimo: logged_in_customer_id vazio vira null', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    assert.match(query, /logged_in_customer_id=&/);
    const result = verifyAppProxySignature(query, SECRET, OPTS);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.loggedInCustomerId, null);
  });

  it('valores vazios entram na conta: remover o parâmetro vazio invalida', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    assert.equal(reasonOf(query.replace('logged_in_customer_id=&', '')), 'bad_signature');
    // Chave sem "=" equivale a valor vazio.
    assert.equal(reasonOf(query.replace('logged_in_customer_id=&', 'logged_in_customer_id&')), 'ok');
  });

  it('rejeita adulteração de qualquer parâmetro', () => {
    const query = signAppProxyQuery(baseParams({ logged_in_customer_id: '7001' }), SECRET);
    const tampered = [
      query.replace(SHOP, 'outra-loja.myshopify.com'),
      query.replace('logged_in_customer_id=7001', 'logged_in_customer_id=7002'),
      query.replace('checkout-bridge', 'outro-caminho'),
      query.replace(`timestamp=${TS}`, `timestamp=${TS + 1}`),
    ];
    for (const q of tampered) {
      assert.notEqual(q, query);
      assert.equal(reasonOf(q), 'bad_signature');
    }
  });

  it('rejeita assinatura adulterada, vazia, em maiúsculas ou feita com outro segredo', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    const signature = query.slice(query.indexOf('signature=') + 'signature='.length);
    assert.equal(signature.length, 64);
    const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    assert.equal(reasonOf(query.replace(signature, flipped)), 'bad_signature');
    assert.equal(reasonOf(query.replace(signature, '')), 'bad_signature');
    assert.equal(reasonOf(query.replace(signature, signature.slice(0, 63))), 'bad_signature');
    assert.equal(reasonOf(query.replace(signature, signature.toUpperCase())), 'bad_signature');
    assert.equal(reasonOf(query, 'outro-segredo'), 'bad_signature');
    assert.equal(reasonOf(query, ''), 'bad_signature');
    assert.equal(reasonOf(signAppProxyQuery(baseParams(), ''), ''), 'bad_signature');
  });

  it('parâmetro extra desconhecido é coberto pela assinatura', () => {
    const query = signAppProxyQuery(baseParams({ novo_parametro: 'abc', extra: ['1', '2'] }), SECRET);
    assert.equal(reasonOf(query), 'ok');
    assert.equal(reasonOf(query.replace('novo_parametro=abc', 'novo_parametro=abd')), 'bad_signature');
    assert.equal(reasonOf(query.replace('novo_parametro=abc&', '')), 'bad_signature');
    // Acrescentar um parâmetro depois de assinado também invalida.
    assert.equal(reasonOf(`${query}&injetado=1`), 'bad_signature');
    assert.equal(reasonOf(`injetado=&${query}`), 'bad_signature');
  });

  it('falta de signature, shop ou timestamp', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    assert.equal(reasonOf(query.replace(/&signature=[0-9a-f]+/, '')), 'missing_param');
    assert.equal(reasonOf(query.replace(`shop=${SHOP}&`, '')), 'missing_param');
    assert.equal(reasonOf(query.replace(`&timestamp=${TS}`, '')), 'missing_param');
    assert.equal(reasonOf(''), 'missing_param');
  });

  it('shop, timestamp ou signature repetidos são recusados mesmo com assinatura válida', () => {
    // signAppProxyQuery assina a forma "a,b", que é o que um verificador ingênuo aceitaria.
    const dupShop = signAppProxyQuery(baseParams({ shop: [SHOP, 'outra-loja.myshopify.com'] }), SECRET);
    assert.equal(reasonOf(dupShop), 'duplicate_param');
    const dupTimestamp = signAppProxyQuery(baseParams({ timestamp: [String(TS), String(TS)] }), SECRET);
    assert.equal(reasonOf(dupTimestamp), 'duplicate_param');
    const valid = signAppProxyQuery(baseParams(), SECRET);
    const signature = valid.slice(valid.indexOf('signature='));
    assert.equal(reasonOf(`${valid}&${signature}`), 'duplicate_param');
    assert.equal(reasonOf(`${valid}&signature=`), 'duplicate_param');
    // Segundo shop acrescentado pelo cliente a uma requisição legítima.
    assert.equal(reasonOf(`shop=outra-loja.myshopify.com&${valid}`), 'duplicate_param');
  });

  it('path_prefix e logged_in_customer_id repetidos também são recusados', () => {
    const dupPrefix = signAppProxyQuery(baseParams({ path_prefix: ['/apps/a', '/apps/b'] }), SECRET);
    assert.equal(reasonOf(dupPrefix), 'duplicate_param');
    const dupCustomer = signAppProxyQuery(baseParams({ logged_in_customer_id: ['1', '2'] }), SECRET);
    assert.equal(reasonOf(dupCustomer), 'duplicate_param');
    // Parâmetros comuns podem repetir (o exemplo oficial usa extra=1&extra=2).
    assert.equal(reasonOf(signAppProxyQuery(baseParams({ extra: ['1', '2'] }), SECRET)), 'ok');
  });

  it('timestamp no limite da janela, no passado e no futuro', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    const at = (offsetMs: number) => ({ maxAgeSeconds: 90, now: new Date(TS * 1000 + offsetMs) });
    assert.equal(reasonOf(query, SECRET, at(90_000)), 'ok');
    assert.equal(reasonOf(query, SECRET, at(90_001)), 'stale');
    assert.equal(reasonOf(query, SECRET, at(91_000)), 'stale');
    assert.equal(reasonOf(query, SECRET, at(-90_000)), 'ok');
    assert.equal(reasonOf(query, SECRET, at(-90_001)), 'stale');
    assert.equal(reasonOf(query, SECRET, at(-3_600_000)), 'stale');
    assert.equal(reasonOf(query, SECRET, { maxAgeSeconds: 10, now: new Date(TS * 1000 + 11_000) }), 'stale');
    assert.equal(reasonOf(query, SECRET, { maxAgeSeconds: Number.NaN, now: NOW }), 'stale');
    assert.equal(reasonOf(query, SECRET, { maxAgeSeconds: 90, now: new Date(Number.NaN) }), 'stale');
  });

  it('timestamp assinado que não é inteiro conta como vencido', () => {
    for (const timestamp of ['', 'abc', '12.5', '-5', '1e9', ` ${TS}`]) {
      assert.equal(reasonOf(signAppProxyQuery(baseParams({ timestamp }), SECRET)), 'stale', timestamp);
    }
  });

  it('shop assinado que não é <rótulo>.myshopify.com', () => {
    for (const shop of ['', 'loja.example.com', 'LOJA.myshopify.com', 'a.b.myshopify.com', 'loja.myshopify.com.evil.com']) {
      assert.equal(reasonOf(signAppProxyQuery(baseParams({ shop }), SECRET)), 'invalid_shop', shop);
    }
  });

  it('codificação por porcentagem malformada', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    assert.equal(reasonOf(`${query}&x=%`), 'malformed');
    assert.equal(reasonOf(`${query}&x=%zz`), 'malformed');
    assert.equal(reasonOf(`%E0%A4%A=1&${query}`), 'malformed');
    assert.equal(reasonOf(`${query}&x=%C3%28`), 'malformed');
    assert.equal(reasonOf(`${query}&x=${'a'.repeat(9000)}`), 'malformed');
  });

  it('decodifica "+" como espaço e %XX antes de assinar', () => {
    const query = signAppProxyQuery(baseParams({ 'chave com espaço': 'valor é/&=' }), SECRET);
    assert.equal(reasonOf(query), 'ok');
    assert.equal(reasonOf(query.replace(/%20/g, '+')), 'ok');
    assert.equal(reasonOf(query.replace('%2Fapps%2F', '/apps/')), 'ok');
  });

  it('trechos vazios entre "&" são ignorados', () => {
    const query = signAppProxyQuery(baseParams(), SECRET);
    assert.equal(reasonOf(`&${query.replace('&', '&&')}&`), 'ok');
  });

  it('ordena as strings "chave=valor" inteiras (regra do exemplo em Ruby)', () => {
    // "a1=x" vem antes de "a=y" porque "1" < "="; ordenar só pela chave daria o inverso.
    const query = signAppProxyQuery(baseParams({ a: 'y', a1: 'x' }), SECRET);
    assert.equal(reasonOf(query), 'ok');
    const rest = `logged_in_customer_id=path_prefix=/apps/checkout-bridgeshop=${SHOP}timestamp=${TS}`;
    const hmac = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('hex');
    const unsigned = query.replace(/&signature=[0-9a-f]+$/, '');
    assert.equal(computeProxySignature(unsigned, SECRET), hmac(`a1=xa=y${rest}`));
    assert.notEqual(computeProxySignature(unsigned, SECRET), hmac(`a=ya1=x${rest}`));
  });
});

describe('peekProxyShop', () => {
  it('devolve o shop normalizado sem verificar a assinatura', () => {
    assert.equal(peekProxyShop(`shop=${SHOP}&signature=qualquer`), SHOP);
    assert.equal(peekProxyShop('timestamp=1&shop=Vitrine-Teste.MyShopify.com'), SHOP);
    assert.equal(peekProxyShop('shop=vitrine%2Dteste.myshopify.com'), SHOP);
  });

  it('null quando ausente, repetido, inválido ou malformado', () => {
    assert.equal(peekProxyShop(''), null);
    assert.equal(peekProxyShop('timestamp=1'), null);
    assert.equal(peekProxyShop('shop='), null);
    assert.equal(peekProxyShop(`shop=${SHOP}&shop=${SHOP}`), null);
    assert.equal(peekProxyShop('shop=loja.example.com'), null);
    assert.equal(peekProxyShop('shop=loja.myshopify.com.evil.com'), null);
    assert.equal(peekProxyShop(`shop=${SHOP}&x=%`), null);
  });
});

describe('signAppProxyQuery', () => {
  it('ignora uma signature informada e põe a válida no fim', () => {
    const query = signAppProxyQuery({ ...baseParams(), signature: 'lixo' }, SECRET);
    assert.equal(query.match(/signature=/g)?.length, 1);
    assert.equal(reasonOf(query), 'ok');
    const unsigned = query.replace(/&signature=[0-9a-f]+$/, '');
    assert.equal(query, `${unsigned}&signature=${computeProxySignature(unsigned, SECRET)}`);
  });
});
