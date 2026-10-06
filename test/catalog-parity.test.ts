import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ABSENT_VALUE,
  computeDivergences,
  hasBlockingDivergence,
  missingCheckoutDivergence,
  normalizedOptionsKey,
  normalizeText,
} from '../src/catalog/parity.ts';
import type { CatalogVariant, Divergence, DivergenceKind } from '../src/types.ts';
import { makeVariant } from './db-helpers.ts';

const V = 'st_vitrine';
const C = 'st_checkout';

function pair(
  vitrineOver: Partial<CatalogVariant> = {},
  checkoutOver: Partial<CatalogVariant> = {},
  priceToleranceBps = 0,
): Divergence[] {
  return computeDivergences(makeVariant(V, '1', vitrineOver), makeVariant(C, '91', checkoutOver), { priceToleranceBps });
}

function kinds(divergences: Divergence[]): DivergenceKind[] {
  return divergences.map((d) => d.kind);
}

describe('normalizeText', () => {
  test('minúsculas, pontas e espaços internos', () => {
    assert.equal(normalizeText('  Camiseta   AZUL \t\n Básica '), 'camiseta azul básica');
  });

  test('NFKC: largura total, ligaduras, espaço não separável e formas compostas', () => {
    assert.equal(normalizeText('ＡＢＣ　１２３'), 'abc 123');
    assert.equal(normalizeText('ﬁta'), 'fita');
    assert.equal(normalizeText('Café Preto'), 'café preto');
    // "é" pré-composto e "e" + acento combinante são o mesmo texto.
    assert.equal(normalizeText('Café'), normalizeText('Café'));
  });

  test('a caixa não desfaz a normalização', () => {
    assert.equal(normalizeText('İstanbul'), normalizeText('i̇STANBUL'));
  });

  test('vazio e só espaços viram texto vazio', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText('  \t'), '');
  });
});

describe('normalizedOptionsKey', () => {
  test('a ordem das opções não importa', () => {
    const a = normalizedOptionsKey([
      { name: 'Cor', value: 'Azul' },
      { name: 'Tamanho', value: 'M' },
    ]);
    const b = normalizedOptionsKey([
      { name: ' tamanho', value: 'm ' },
      { name: 'COR', value: 'azul' },
    ]);
    assert.equal(a, b);
  });

  test('valores diferentes dão chaves diferentes', () => {
    assert.notEqual(
      normalizedOptionsKey([{ name: 'Tamanho', value: 'M' }]),
      normalizedOptionsKey([{ name: 'Tamanho', value: 'G' }]),
    );
  });

  test('nome e valor não se confundem na junção', () => {
    assert.notEqual(
      normalizedOptionsKey([{ name: 'a=b', value: 'c' }]),
      normalizedOptionsKey([{ name: 'a', value: 'b=c' }]),
    );
  });

  test('"Title = Default Title" equivale a outro igual e à lista vazia', () => {
    const one = normalizedOptionsKey([{ name: 'Title', value: 'Default Title' }]);
    const other = normalizedOptionsKey([{ name: 'title', value: ' DEFAULT  TITLE ' }]);
    assert.equal(one, other);
    assert.equal(one, normalizedOptionsKey([]));
    // Só a opção única padrão é tratada assim; ao lado de outra opção ela conta.
    assert.notEqual(
      normalizedOptionsKey([
        { name: 'Title', value: 'Default Title' },
        { name: 'Cor', value: 'Azul' },
      ]),
      normalizedOptionsKey([{ name: 'Cor', value: 'Azul' }]),
    );
  });
});

describe('computeDivergences', () => {
  test('variantes equivalentes não divergem', () => {
    assert.deepEqual(pair(), []);
    assert.deepEqual(pair({ price: '39.9' }, { price: '39.90' }), []);
  });

  test('preço: limites da tolerância com a vitrine como base', () => {
    // 100.00 -> 101.00 é exatamente 100 pontos-base.
    assert.deepEqual(pair({ price: '100.00' }, { price: '101.00' }, 100), []);
    assert.deepEqual(pair({ price: '100.00' }, { price: '99.00' }, 100), []);
    assert.deepEqual(kinds(pair({ price: '100.00' }, { price: '101.01' }, 100)), ['price']);
    assert.deepEqual(kinds(pair({ price: '100.00' }, { price: '101.00' }, 99)), ['price']);
    // Tolerância 0: um centavo já diverge.
    assert.deepEqual(pair({ price: '100.00' }, { price: '100.01' }, 0), [
      { kind: 'price', vitrine: '100.00', checkout: '100.01' },
    ]);
  });

  test('preço: a base é a vitrine, não o checkout', () => {
    // 200 -> 100 é 5000 bps sobre a vitrine; sobre o checkout seria 10000.
    assert.deepEqual(pair({ price: '200.00' }, { price: '100.00' }, 5000), []);
    assert.deepEqual(kinds(pair({ price: '100.00' }, { price: '200.00' }, 5000)), ['price']);
  });

  test('preço: vitrine zerada com checkout cobrando sempre diverge', () => {
    assert.deepEqual(kinds(pair({ price: '0.00' }, { price: '0.01' }, 10_000)), ['price']);
    assert.deepEqual(pair({ price: '0.00' }, { price: '0' }, 0), []);
  });

  test('preço ilegível vira divergência em vez de erro', () => {
    assert.deepEqual(kinds(pair({ price: 'abc' }, { price: '10.00' }, 100)), ['price']);
    assert.deepEqual(kinds(pair({ price: '10.00' }, { price: '' }, 100)), ['price']);
  });

  test('moeda diferente: marca a moeda e não compara preço', () => {
    const result = pair({ currency: 'BRL', price: '100.00' }, { currency: 'USD', price: '20.00' });
    assert.deepEqual(result, [{ kind: 'currency', vitrine: 'BRL', checkout: 'USD' }]);
    assert.deepEqual(pair({ currency: 'brl' }, { currency: 'BRL ' }), []);
  });

  test('preço "de": só de um lado, fora e dentro da tolerância', () => {
    assert.deepEqual(pair({ compareAtPrice: '59.90' }, { compareAtPrice: null }), [
      { kind: 'compare_at_price', vitrine: '59.90', checkout: ABSENT_VALUE },
    ]);
    assert.deepEqual(pair({ compareAtPrice: null }, { compareAtPrice: '59.90' }), [
      { kind: 'compare_at_price', vitrine: ABSENT_VALUE, checkout: '59.90' },
    ]);
    assert.deepEqual(kinds(pair({ compareAtPrice: '100.00' }, { compareAtPrice: '102.00' }, 100)), ['compare_at_price']);
    assert.deepEqual(pair({ compareAtPrice: '100.00' }, { compareAtPrice: '101.00' }, 100), []);
    assert.deepEqual(pair({ compareAtPrice: '59.9' }, { compareAtPrice: '59.90' }), []);
  });

  test('preço "de" em moedas diferentes: só a presença é comparada', () => {
    const both = pair({ currency: 'BRL', compareAtPrice: '100.00' }, { currency: 'USD', compareAtPrice: '20.00' });
    assert.deepEqual(kinds(both), ['currency']);
    const oneSide = pair({ currency: 'BRL', compareAtPrice: '100.00' }, { currency: 'USD' });
    assert.deepEqual(kinds(oneSide), ['currency', 'compare_at_price']);
  });

  test('título: compara a forma normalizada e devolve o texto original', () => {
    assert.deepEqual(pair({ productTitle: 'Camiseta  Básica' }, { productTitle: ' camiseta básica' }), []);
    assert.deepEqual(pair({ productTitle: 'Camiseta' }, { productTitle: 'Camisa' }), [
      { kind: 'title', vitrine: 'Camiseta', checkout: 'Camisa' },
    ]);
  });

  test('opções: ordem e caixa não contam; valor diferente conta', () => {
    const cor = { name: 'Cor', value: 'Azul' };
    assert.deepEqual(
      pair({ options: [cor, { name: 'Tamanho', value: 'M' }] }, { options: [{ name: 'TAMANHO', value: 'm' }, cor] }),
      [],
    );
    assert.deepEqual(pair({ options: [{ name: 'Tamanho', value: 'M' }] }, { options: [{ name: 'Tamanho', value: 'G' }] }), [
      { kind: 'options', vitrine: 'Tamanho=M', checkout: 'Tamanho=G' },
    ]);
  });

  test('disponibilidade: só quando a vitrine vende e o checkout não', () => {
    assert.deepEqual(kinds(pair({ availableForSale: true }, { availableForSale: false })), ['availability']);
    assert.deepEqual(pair({ availableForSale: false }, { availableForSale: true }), []);
    assert.deepEqual(pair({ availableForSale: false }, { availableForSale: false }), []);
  });

  test('status do produto no checkout: ACTIVE e UNLISTED passam', () => {
    assert.deepEqual(pair({}, { productStatus: 'UNLISTED' }), []);
    assert.deepEqual(pair({}, { productStatus: 'DRAFT' }), [{ kind: 'product_status', vitrine: 'ACTIVE', checkout: 'DRAFT' }]);
    assert.deepEqual(kinds(pair({}, { productStatus: 'ARCHIVED' })), ['product_status']);
    // O status da vitrine não gera divergência por si só.
    assert.deepEqual(pair({ productStatus: 'DRAFT' }, { productStatus: 'ACTIVE' }), []);
  });

  test('ordem estável com tudo divergindo', () => {
    const all = pair(
      { price: '10.00', compareAtPrice: '20.00', productTitle: 'A', options: [{ name: 'Cor', value: 'Azul' }] },
      {
        price: '11.00',
        compareAtPrice: null,
        productTitle: 'B',
        options: [{ name: 'Cor', value: 'Verde' }],
        availableForSale: false,
        productStatus: 'ARCHIVED',
      },
    );
    assert.deepEqual(kinds(all), ['price', 'compare_at_price', 'title', 'options', 'availability', 'product_status']);
    const withCurrency = pair({ currency: 'BRL' }, { currency: 'EUR', productTitle: 'B', productStatus: 'DRAFT' });
    assert.deepEqual(kinds(withCurrency), ['currency', 'title', 'product_status']);
  });

  test('não altera as variantes recebidas', () => {
    const vitrine = makeVariant(V, '1', { options: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }] });
    const checkout = makeVariant(C, '91', { options: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] });
    const before = JSON.stringify([vitrine, checkout]);
    assert.deepEqual(computeDivergences(vitrine, checkout, { priceToleranceBps: 0 }), []);
    assert.equal(JSON.stringify([vitrine, checkout]), before);
  });
});

describe('hasBlockingDivergence', () => {
  test('preço e moeda bloqueiam; o resto só avisa', () => {
    assert.equal(hasBlockingDivergence([]), false);
    assert.equal(hasBlockingDivergence([{ kind: 'price', vitrine: '1.00', checkout: '2.00' }]), true);
    assert.equal(hasBlockingDivergence([{ kind: 'currency', vitrine: 'BRL', checkout: 'USD' }]), true);
    const soft: DivergenceKind[] = ['compare_at_price', 'title', 'options', 'availability', 'product_status'];
    assert.equal(hasBlockingDivergence(soft.map((kind) => ({ kind, vitrine: 'a', checkout: 'b' }))), false);
    assert.equal(
      hasBlockingDivergence([
        { kind: 'title', vitrine: 'a', checkout: 'b' },
        { kind: 'price', vitrine: '1.00', checkout: '2.00' },
      ]),
      true,
    );
  });

  test('destino ausente não é divergência de preço', () => {
    const missing = missingCheckoutDivergence(makeVariant(V, '1'));
    assert.deepEqual(missing, { kind: 'product_status', vitrine: 'ACTIVE', checkout: 'ausente' });
    assert.equal(hasBlockingDivergence([missing]), false);
  });
});
