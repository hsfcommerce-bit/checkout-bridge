/**
 * Aritmética monetária exata sobre strings decimais ("39.99"), como a Shopify devolve.
 *
 * Nada aqui passa por ponto flutuante: os valores viram inteiros em micros (10^-6) com
 * BigInt. Seis casas cobrem todas as moedas da Shopify e ainda deixam folga para preços
 * unitários com mais de duas casas.
 */

const SCALE_DIGITS = 6;
const SCALE = 1_000_000n;

/**
 * Formato aceito: sinal "-" opcional, pelo menos um dígito inteiro e até 6 casas decimais.
 * Sem "+", sem expoente, sem separador de milhar, sem espaços, sem ".5" nem "5.".
 */
const MONEY_RE = /^(-?)([0-9]+)(?:\.([0-9]{1,6}))?$/;

/** "39.99" -> 39990000n. Lança Error para qualquer coisa fora do formato aceito. */
export function toMicros(amount: string): bigint {
  const match = typeof amount === 'string' ? MONEY_RE.exec(amount) : null;
  if (!match) {
    // O valor recebido não entra na mensagem: pode ser lixo arbitrário vindo de fora.
    throw new Error('Valor monetário inválido');
  }
  const negative = match[1] === '-';
  const integerPart = match[2] ?? '0';
  const fractionPart = (match[3] ?? '').padEnd(SCALE_DIGITS, '0');
  const micros = BigInt(integerPart) * SCALE + BigInt(fractionPart);
  return negative ? -micros : micros;
}

/**
 * Inverso de toMicros, já na forma canônica: no mínimo 2 casas, sem zeros à direita além
 * da segunda casa e sem zero negativo.
 */
export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const integerPart = (abs / SCALE).toString();
  let fractionPart = (abs % SCALE).toString().padStart(SCALE_DIGITS, '0');
  fractionPart = fractionPart.replace(/0+$/, '');
  if (fractionPart.length < 2) fractionPart = fractionPart.padEnd(2, '0');
  return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
}

export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const ma = toMicros(a);
  const mb = toMicros(b);
  if (ma < mb) return -1;
  if (ma > mb) return 1;
  return 0;
}

export function moneyEquals(a: string, b: string): boolean {
  return toMicros(a) === toMicros(b);
}

/**
 * Diferença relativa |other - base| / |base| em pontos-base, arredondada PARA CIMA.
 *
 * Arredondar para cima é o lado seguro: uma diferença de 0,01 ponto-base nunca vira 0 e,
 * portanto, nunca passa por uma tolerância de 0 ("preço idêntico").
 * Base e other zero -> 0. Base zero e other diferente de zero -> +Infinity.
 */
export function relativeDiffBps(base: string, other: string): number {
  const mb = toMicros(base);
  const mo = toMicros(other);
  const diff = mo > mb ? mo - mb : mb - mo;
  if (diff === 0n) return 0;
  const absBase = mb < 0n ? -mb : mb;
  if (absBase === 0n) return Number.POSITIVE_INFINITY;
  const scaled = diff * 10_000n;
  // Teto de divisão inteira com operandos positivos.
  return Number((scaled + absBase - 1n) / absBase);
}

/**
 * true quando a diferença relativa cabe na tolerância (em pontos-base).
 * Tolerância inválida (NaN ou negativa) é tratada como 0, o valor mais restritivo.
 */
export function withinTolerance(base: string, other: string, toleranceBps: number): boolean {
  const tolerance =
    typeof toleranceBps === 'number' && !Number.isNaN(toleranceBps) && toleranceBps > 0 ? toleranceBps : 0;
  return relativeDiffBps(base, other) <= tolerance;
}

/** Multiplicação exata por uma quantidade inteira. Devolve o valor na forma canônica. */
export function multiplyMoney(amount: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity)) {
    throw new Error('Quantidade inválida: deve ser um número inteiro');
  }
  return fromMicros(toMicros(amount) * BigInt(quantity));
}

/** Forma canônica: "39.9" -> "39.90", "5" -> "5.00", "1.2340" -> "1.234", "-0" -> "0.00". */
export function normalizeMoney(amount: string): string {
  return fromMicros(toMicros(amount));
}

/**
 * Formata para exibição com Intl.NumberFormat. Nunca lança: valor, moeda ou locale
 * inválidos caem no formato simples "<valor> <moeda>".
 */
export function formatMoney(amount: string, currency: string, locale = 'pt-BR'): string {
  try {
    // A string canônica vai direto para o Intl (aceita decimal em string desde o ES2023),
    // sem passar por Number, para não perder precisão em valores grandes.
    const canonical = normalizeMoney(amount) as `${number}`;
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(canonical);
  } catch {
    return `${amount} ${currency}`;
  }
}
