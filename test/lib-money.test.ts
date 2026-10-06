import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareMoney,
  formatMoney,
  fromMicros,
  moneyEquals,
  multiplyMoney,
  normalizeMoney,
  relativeDiffBps,
  toMicros,
  withinTolerance,
} from '../src/lib/money.ts';

/** O Intl usa espaços especiais (U+00A0, U+202F); para comparar, viram espaço comum. */
const plainSpaces = (value: string): string => value.replace(/\s/g, ' ');

describe('toMicros', () => {
  it('converte strings decimais válidas', () => {
    assert.equal(toMicros('39.99'), 39_990_000n);
    assert.equal(toMicros('0'), 0n);
    assert.equal(toMicros('5'), 5_000_000n);
    assert.equal(toMicros('0.000001'), 1n);
    assert.equal(toMicros('1.5'), 1_500_000n);
    assert.equal(toMicros('007.50'), 7_500_000n);
    assert.equal(toMicros('123456.123456'), 123_456_123_456n);
  });

  it('aceita sinal negativo e não produz zero negativo', () => {
    assert.equal(toMicros('-12.5'), -12_500_000n);
    assert.equal(toMicros('-0.000001'), -1n);
    assert.equal(toMicros('-0'), 0n);
    assert.equal(toMicros('-0.00'), 0n);
  });

  it('mantém a precisão em valores além do limite seguro de Number', () => {
    assert.equal(toMicros('9007199254740993.000001'), 9_007_199_254_740_993_000_001n);
    assert.equal(
      toMicros('123456789012345678901234567890.123456'),
      123_456_789_012_345_678_901_234_567_890_123_456n,
    );
  });

  it('rejeita qualquer coisa fora do formato', () => {
    const junk = [
      '1e3',
      '1E3',
      '1,00',
      '1.000,00',
      '',
      ' ',
      ' 1',
      '1 ',
      '1\n',
      '\t1',
      'abc',
      '1.1234567',
      '.5',
      '5.',
      '.',
      '-',
      '+5',
      '--5',
      '-+5',
      '1.2.3',
      '0x10',
      '1_000',
      'NaN',
      'Infinity',
      '-Infinity',
      '١٢',
      '１２',
      '12abc',
      'R$ 10',
      '10 BRL',
      '1-',
    ];
    for (const value of junk) {
      assert.throws(() => toMicros(value), Error, `deveria rejeitar ${JSON.stringify(value)}`);
    }
  });

  it('rejeita valores que não são string', () => {
    for (const value of [null, undefined, 10, 10.5, 10n, {}, [], true]) {
      assert.throws(() => toMicros(value as unknown as string), Error);
    }
  });

  it('não repete a entrada inválida na mensagem de erro', () => {
    assert.throws(
      () => toMicros('<script>alert(1)</script>'),
      (err: unknown) => err instanceof Error && !err.message.includes('script'),
    );
  });
});

describe('fromMicros', () => {
  it('devolve a forma canônica', () => {
    assert.equal(fromMicros(39_990_000n), '39.99');
    assert.equal(fromMicros(5_000_000n), '5.00');
    assert.equal(fromMicros(1n), '0.000001');
    assert.equal(fromMicros(-1_500_000n), '-1.50');
    assert.equal(fromMicros(0n), '0.00');
    assert.equal(fromMicros(1_234_000n), '1.234');
  });

  it('é o inverso de toMicros', () => {
    for (const value of ['0.00', '39.99', '-0.01', '1.234567', '1000000.10', '0.000001']) {
      assert.equal(fromMicros(toMicros(value)), value);
    }
  });
});

describe('compareMoney e moneyEquals', () => {
  it('compara pelo valor, não pelo texto', () => {
    assert.equal(compareMoney('1.10', '1.1'), 0);
    assert.equal(compareMoney('1', '2'), -1);
    assert.equal(compareMoney('2', '1'), 1);
    assert.equal(compareMoney('-1', '0'), -1);
    assert.equal(compareMoney('10', '9.999999'), 1);
    assert.equal(compareMoney('9', '10'), -1, 'comparação de texto diria que "9" > "10"');
    assert.equal(compareMoney('-0', '0.00'), 0);
  });

  it('não sofre com erro de ponto flutuante', () => {
    // 0.1 + 0.2 !== 0.3 em ponto flutuante.
    assert.equal(toMicros('0.1') + toMicros('0.2'), toMicros('0.3'));
    assert.equal(compareMoney('0.30', '0.3'), 0);
    assert.equal(compareMoney('9007199254740993', '9007199254740992'), 1);
  });

  it('moneyEquals', () => {
    assert.equal(moneyEquals('39.90', '39.9'), true);
    assert.equal(moneyEquals('39.99', '39.98'), false);
    assert.equal(moneyEquals('0', '-0.000000'), true);
    assert.equal(moneyEquals('1.000001', '1.000002'), false);
  });

  it('propaga o erro de entrada inválida', () => {
    assert.throws(() => compareMoney('1', 'x'));
    assert.throws(() => compareMoney('', '1'));
    assert.throws(() => moneyEquals('1,0', '1.0'));
  });
});

describe('relativeDiffBps', () => {
  it('calcula diferenças exatas', () => {
    assert.equal(relativeDiffBps('100', '101'), 100);
    assert.equal(relativeDiffBps('100', '99'), 100);
    assert.equal(relativeDiffBps('200', '201'), 50);
    assert.equal(relativeDiffBps('100.00', '100.01'), 1);
    assert.equal(relativeDiffBps('1', '2'), 10_000);
    assert.equal(relativeDiffBps('1', '0'), 10_000);
    assert.equal(relativeDiffBps('50', '200'), 30_000);
  });

  it('é zero para valores iguais, mesmo escritos de formas diferentes', () => {
    assert.equal(relativeDiffBps('39.99', '39.99'), 0);
    assert.equal(relativeDiffBps('39.9', '39.90'), 0);
    assert.equal(relativeDiffBps('5', '5.000000'), 0);
  });

  it('arredonda para cima', () => {
    // 0.01 / 39.99 = 2,5006 pontos-base
    assert.equal(relativeDiffBps('39.99', '40.00'), 3);
    // 0.01 / 40.00 = 2,5 pontos-base
    assert.equal(relativeDiffBps('40.00', '39.99'), 3);
    // 0,1 ponto-base
    assert.equal(relativeDiffBps('100.00', '100.001'), 1);
    // 1,0001 ponto-base
    assert.equal(relativeDiffBps('100.00', '100.010001'), 2);
    // A menor diferença representável nunca vira zero.
    assert.equal(relativeDiffBps('1000000', '1000000.000001'), 1);
    assert.equal(relativeDiffBps('999999999999', '999999999999.000001'), 1);
  });

  it('trata os casos com zero', () => {
    assert.equal(relativeDiffBps('0', '0'), 0);
    assert.equal(relativeDiffBps('0.00', '-0'), 0);
    assert.equal(relativeDiffBps('0', '1'), Number.POSITIVE_INFINITY);
    assert.equal(relativeDiffBps('0.00', '0.000001'), Number.POSITIVE_INFINITY);
    assert.equal(relativeDiffBps('0', '-1'), Number.POSITIVE_INFINITY);
    assert.equal(relativeDiffBps('0.000001', '0'), 10_000);
  });

  it('usa o módulo da base com valores negativos', () => {
    assert.equal(relativeDiffBps('-100', '-101'), 100);
    assert.equal(relativeDiffBps('-100', '100'), 20_000);
    assert.equal(relativeDiffBps('100', '-100'), 20_000);
  });

  it('devolve sempre um inteiro não negativo ou +Infinity', () => {
    const samples = ['0', '0.01', '0.99', '1', '19.9', '39.99', '40', '1234.5678', '99999.999999'];
    for (const base of samples) {
      for (const other of samples) {
        const bps = relativeDiffBps(base, other);
        assert.ok(bps === Number.POSITIVE_INFINITY || (Number.isInteger(bps) && bps >= 0), `${base} x ${other}`);
      }
    }
  });

  it('rejeita entrada inválida', () => {
    assert.throws(() => relativeDiffBps('abc', '1'));
    assert.throws(() => relativeDiffBps('1', '1e3'));
  });
});

describe('withinTolerance', () => {
  it('compara com a tolerância em pontos-base', () => {
    assert.equal(withinTolerance('100', '101', 100), true);
    assert.equal(withinTolerance('100', '101', 99), false);
    assert.equal(withinTolerance('100', '99', 100), true);
    assert.equal(withinTolerance('39.99', '40.00', 3), true);
    assert.equal(withinTolerance('39.99', '40.00', 2), false);
  });

  it('tolerância zero exige preço idêntico', () => {
    assert.equal(withinTolerance('100', '100.00', 0), true);
    assert.equal(withinTolerance('100', '100.000001', 0), false);
    assert.equal(withinTolerance('100', '100.001', 0), false);
    assert.equal(withinTolerance('0', '0', 0), true);
  });

  it('base zero com outro valor só passa com tolerância infinita', () => {
    assert.equal(withinTolerance('0', '1', 1_000_000_000), false);
    assert.equal(withinTolerance('0', '1', Number.POSITIVE_INFINITY), true);
  });

  it('tolerância fracionária não ganha o arredondamento', () => {
    // A diferença real é 2,5006 pontos-base (arredondada para 3).
    assert.equal(withinTolerance('39.99', '40.00', 2.9), false);
  });

  it('tolerância inválida equivale a zero', () => {
    for (const tolerance of [Number.NaN, -1, Number.NEGATIVE_INFINITY, undefined as unknown as number]) {
      assert.equal(withinTolerance('100', '100', tolerance), true);
      assert.equal(withinTolerance('100', '100.01', tolerance), false);
    }
  });
});

describe('multiplyMoney', () => {
  it('multiplica de forma exata', () => {
    assert.equal(multiplyMoney('39.99', 3), '119.97');
    assert.equal(multiplyMoney('0.1', 3), '0.30');
    assert.equal(multiplyMoney('19.999', 2), '39.998');
    assert.equal(multiplyMoney('1.005', 1000), '1005.00');
    assert.equal(multiplyMoney('5', 1), '5.00');
    assert.equal(multiplyMoney('5', 0), '0.00');
    assert.equal(multiplyMoney('-2.50', 2), '-5.00');
    assert.equal(multiplyMoney('2.50', -2), '-5.00');
    assert.equal(multiplyMoney('0.000001', 999999), '0.999999');
  });

  it('não perde precisão em valores grandes', () => {
    assert.equal(multiplyMoney('9007199254740993.01', 3), '27021597764222979.03');
  });

  it('rejeita quantidade não inteira', () => {
    for (const quantity of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '2' as unknown as number]) {
      assert.throws(() => multiplyMoney('1.00', quantity), Error);
    }
  });

  it('rejeita valor inválido', () => {
    assert.throws(() => multiplyMoney('1,00', 2));
  });
});

describe('normalizeMoney', () => {
  it('produz a forma canônica', () => {
    assert.equal(normalizeMoney('39.9'), '39.90');
    assert.equal(normalizeMoney('5'), '5.00');
    assert.equal(normalizeMoney('1.2340'), '1.234');
    assert.equal(normalizeMoney('39.99'), '39.99');
    assert.equal(normalizeMoney('0.100000'), '0.10');
    assert.equal(normalizeMoney('1.000001'), '1.000001');
    assert.equal(normalizeMoney('007'), '7.00');
    assert.equal(normalizeMoney('000.5'), '0.50');
    assert.equal(normalizeMoney('-1.5'), '-1.50');
    assert.equal(normalizeMoney('0'), '0.00');
  });

  it('não devolve zero negativo', () => {
    assert.equal(normalizeMoney('-0'), '0.00');
    assert.equal(normalizeMoney('-0.000'), '0.00');
  });

  it('é idempotente', () => {
    for (const value of ['39.9', '5', '1.2340', '-0', '123456789.000100']) {
      const once = normalizeMoney(value);
      assert.equal(normalizeMoney(once), once);
    }
  });

  it('rejeita entrada inválida', () => {
    for (const value of ['', 'abc', '1e3', '1,00', ' 1', '1.1234567']) {
      assert.throws(() => normalizeMoney(value), Error);
    }
  });
});

describe('formatMoney', () => {
  it('usa pt-BR por padrão', () => {
    assert.equal(plainSpaces(formatMoney('39.99', 'BRL')), 'R$ 39,99');
    assert.equal(plainSpaces(formatMoney('1234.5', 'BRL')), 'R$ 1.234,50');
    assert.equal(plainSpaces(formatMoney('5', 'BRL')), 'R$ 5,00');
  });

  it('aceita outro locale e outra moeda', () => {
    assert.equal(formatMoney('1234.5', 'USD', 'en-US'), '$1,234.50');
    assert.equal(formatMoney('-3', 'USD', 'en-US'), '-$3.00');
  });

  it('não passa por ponto flutuante', () => {
    assert.equal(formatMoney('9007199254740993.25', 'USD', 'en-US'), '$9,007,199,254,740,993.25');
  });

  it('nunca lança e cai no formato simples', () => {
    assert.equal(formatMoney('abc', 'BRL'), 'abc BRL');
    assert.equal(formatMoney('', 'BRL'), ' BRL');
    assert.equal(formatMoney('10', 'XX'), '10 XX');
    assert.equal(formatMoney('10', ''), '10 ');
    assert.equal(formatMoney('10', 'BRL', 'isto não é um locale'), '10 BRL');
    assert.equal(formatMoney('1e3', 'USD', 'en-US'), '1e3 USD');
    assert.doesNotThrow(() => formatMoney(undefined as unknown as string, undefined as unknown as string));
  });
});
