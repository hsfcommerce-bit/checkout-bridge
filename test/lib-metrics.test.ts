import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMetrics,
  DROPPED_METRIC,
  HISTOGRAM_BUCKETS_MS,
  MAX_METRICS,
  MAX_SERIES_PER_METRIC,
} from '../src/lib/metrics.ts';

const LABEL = '[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\\\\n]|\\\\\\\\|\\\\"|\\\\n)*"';
const SAMPLE_RE = new RegExp(
  `^[a-zA-Z_][a-zA-Z0-9_]*(?:\\{${LABEL}(?:,${LABEL})*\\})? (?:-?[0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?|\\+Inf|-Inf|NaN)$`,
);
const TYPE_RE = /^# TYPE [a-zA-Z_][a-zA-Z0-9_]* (counter|gauge|histogram)$/;

/** Valida a exposição inteira linha a linha e devolve as linhas (sem a final vazia). */
function assertValidExposition(text: string): string[] {
  assert.ok(text.endsWith('\n'), 'deve terminar com quebra de linha');
  const lines = text.slice(0, -1).split('\n');
  const typed = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('#')) {
      assert.match(line, TYPE_RE);
      const name = line.split(' ')[2] ?? '';
      assert.ok(!typed.has(name), `TYPE repetido para ${name}`);
      typed.add(name);
    } else {
      assert.match(line, SAMPLE_RE, `linha inválida: ${line}`);
      const sample = (line.match(/^[a-zA-Z_][a-zA-Z0-9_]*/) ?? [''])[0];
      const family = sample.replace(/_(bucket|sum|count)$/, '');
      assert.ok(typed.has(sample) || typed.has(family), `amostra sem TYPE antes: ${line}`);
    }
  }
  return lines;
}

function value(text: string, sample: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${sample} `));
  return line === undefined ? undefined : Number(line.slice(sample.length + 1));
}

describe('contadores', () => {
  it('incrementa em 1 por padrão e soma valores', () => {
    const metrics = createMetrics();
    metrics.inc('bridge_checkouts_total');
    metrics.inc('bridge_checkouts_total');
    metrics.inc('bridge_checkouts_total', undefined, 5);
    const text = metrics.render();
    assertValidExposition(text);
    assert.ok(text.includes('# TYPE bridge_checkouts_total counter\n'));
    assert.equal(value(text, 'bridge_checkouts_total'), 7);
  });

  it('separa as séries por rótulos, sem depender da ordem das chaves', () => {
    const metrics = createMetrics();
    metrics.inc('req_total', { method: 'POST', status: '200' });
    metrics.inc('req_total', { status: '200', method: 'POST' });
    metrics.inc('req_total', { method: 'POST', status: '500' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, 'req_total{method="POST",status="200"}'), 2);
    assert.equal(value(text, 'req_total{method="POST",status="500"}'), 1);
    assert.equal(text.match(/# TYPE req_total /g)?.length, 1);
  });

  it('ignora incrementos negativos e não finitos', () => {
    const metrics = createMetrics();
    metrics.inc('c_total', undefined, 2);
    metrics.inc('c_total', undefined, -1);
    metrics.inc('c_total', undefined, Number.NaN);
    metrics.inc('c_total', undefined, Number.POSITIVE_INFINITY);
    assert.equal(value(metrics.render(), 'c_total'), 2);
  });

  it('aceita incrementos fracionários', () => {
    const metrics = createMetrics();
    metrics.inc('c_total', undefined, 0.5);
    metrics.inc('c_total', undefined, 0.25);
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, 'c_total'), 0.75);
  });
});

describe('gauges', () => {
  it('guarda o último valor', () => {
    const metrics = createMetrics();
    metrics.gauge('bridge_breaker_state', 1, { store: 'st_1' });
    metrics.gauge('bridge_breaker_state', 0, { store: 'st_1' });
    metrics.gauge('bridge_breaker_state', -2.5, { store: 'st_2' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.ok(text.includes('# TYPE bridge_breaker_state gauge\n'));
    assert.equal(value(text, 'bridge_breaker_state{store="st_1"}'), 0);
    assert.equal(value(text, 'bridge_breaker_state{store="st_2"}'), -2.5);
  });

  it('ignora valores não finitos', () => {
    const metrics = createMetrics();
    metrics.gauge('g', 3);
    metrics.gauge('g', Number.NaN);
    metrics.gauge('g', Number.NEGATIVE_INFINITY);
    assert.equal(value(metrics.render(), 'g'), 3);
  });
});

describe('histogramas', () => {
  it('usa os limites de balde combinados', () => {
    assert.deepEqual([...HISTOGRAM_BUCKETS_MS], [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  });

  it('expõe baldes cumulativos, soma e contagem', () => {
    const metrics = createMetrics();
    for (const ms of [10, 25, 26, 100, 700, 9999, 10000, 10001, 60000]) {
      metrics.observe('upstream_ms', ms);
    }
    const text = metrics.render();
    assertValidExposition(text);
    assert.ok(text.includes('# TYPE upstream_ms histogram\n'));
    const expected: Array<[string, number]> = [
      ['25', 2],
      ['50', 3],
      ['100', 4],
      ['250', 4],
      ['500', 4],
      ['1000', 5],
      ['2500', 5],
      ['5000', 5],
      ['10000', 7],
      ['+Inf', 9],
    ];
    for (const [le, count] of expected) {
      assert.equal(value(text, `upstream_ms_bucket{le="${le}"}`), count, `le=${le}`);
    }
    assert.equal(value(text, 'upstream_ms_count'), 9);
    assert.equal(value(text, 'upstream_ms_sum'), 10 + 25 + 26 + 100 + 700 + 9999 + 10000 + 10001 + 60000);
  });

  it('mantém os baldes em ordem e não decrescentes', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 200; i += 1) metrics.observe('h', (i * 97) % 12000);
    const lines = metrics.render().split('\n').filter((line) => line.startsWith('h_bucket'));
    assert.equal(lines.length, 10);
    assert.deepEqual(
      lines.map((line) => /le="([^"]+)"/.exec(line)?.[1]),
      ['25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '+Inf'],
    );
    const counts = lines.map((line) => Number(line.split(' ').at(-1)));
    for (let i = 1; i < counts.length; i += 1) {
      assert.ok((counts[i] ?? 0) >= (counts[i - 1] ?? 0));
    }
    assert.equal(counts.at(-1), 200);
  });

  it('põe os rótulos do chamador antes de le', () => {
    const metrics = createMetrics();
    metrics.observe('h', 30, { route: 'checkout', shop: 'a' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, 'h_bucket{route="checkout",shop="a",le="25"}'), 0);
    assert.equal(value(text, 'h_bucket{route="checkout",shop="a",le="50"}'), 1);
    assert.equal(value(text, 'h_bucket{route="checkout",shop="a",le="+Inf"}'), 1);
    assert.equal(value(text, 'h_sum{route="checkout",shop="a"}'), 30);
    assert.equal(value(text, 'h_count{route="checkout",shop="a"}'), 1);
  });

  it('não deixa um rótulo "le" do chamador colidir com o do histograma', () => {
    const metrics = createMetrics();
    metrics.observe('h', 5, { le: 'x' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, 'h_bucket{exported_le="x",le="25"}'), 1);
  });

  it('ignora observações não finitas', () => {
    const metrics = createMetrics();
    metrics.observe('h', Number.NaN);
    metrics.observe('h', Number.POSITIVE_INFINITY);
    metrics.observe('h', 1);
    assert.equal(value(metrics.render(), 'h_count'), 1);
  });
});

describe('formato de exposição', () => {
  it('escapa barra invertida, aspas e quebra de linha nos valores de rótulo', () => {
    const metrics = createMetrics();
    metrics.inc('c_total', { detail: 'a\\b"c\nd' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.ok(text.includes('c_total{detail="a\\\\b\\"c\\nd"} 1\n'), text);
    // Uma quebra de linha crua criaria uma linha de amostra forjada.
    assert.equal(text.split('\n').filter((line) => line.startsWith('c_total')).length, 1);
  });

  it('não permite forjar amostras por meio de rótulos', () => {
    const metrics = createMetrics();
    metrics.inc('c_total', { shop: 'x"} 999\nfake_metric{a="b' });
    const lines = assertValidExposition(metrics.render());
    assert.ok(!lines.some((line) => line.startsWith('fake_metric')));
  });

  it('saneia nomes de métrica e de rótulo', () => {
    const metrics = createMetrics();
    metrics.inc('http.requests-total', { 'status-code': '200', 'a b': 'c', '9x': 'y' });
    metrics.gauge('9lives', 1);
    metrics.inc('', undefined, 1);
    metrics.inc('ns:sub', undefined, 1);
    metrics.inc('métrica', undefined, 1);
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, 'http_requests_total{_9x="y",a_b="c",status_code="200"}'), 1);
    assert.equal(value(text, '_9lives'), 1);
    assert.equal(value(text, '_'), 1);
    assert.equal(value(text, 'ns_sub'), 1);
    assert.equal(value(text, 'm_trica'), 1);
  });

  it('ignora o uso do mesmo nome com outro tipo', () => {
    const metrics = createMetrics();
    metrics.inc('x', undefined, 2);
    metrics.gauge('x', 99);
    metrics.observe('x', 10);
    const text = metrics.render();
    assertValidExposition(text);
    assert.ok(text.includes('# TYPE x counter\n'));
    assert.equal(value(text, 'x'), 2);
    assert.ok(!text.includes('x_bucket'));
  });

  it('expõe um registro vazio só com o contador de descartes', () => {
    const text = createMetrics().render();
    assert.equal(text, `# TYPE ${DROPPED_METRIC} counter\n${DROPPED_METRIC} 0\n`);
  });

  it('mantém a exposição válida com muitos tipos misturados', () => {
    const metrics = createMetrics();
    metrics.inc('a_total', { k: 'v' });
    metrics.gauge('b', 1e21);
    metrics.gauge('c', 1e-7);
    metrics.observe('d_ms', 12.5, { route: '/x' });
    metrics.observe('d_ms', 0.1, { route: '/y' });
    assertValidExposition(metrics.render());
  });

  it('instâncias são independentes', () => {
    const a = createMetrics();
    const b = createMetrics();
    a.inc('only_a');
    assert.ok(!b.render().includes('only_a'));
  });
});

describe('limite de memória', () => {
  it('descarta combinações de rótulos além do limite e conta os descartes', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_SERIES_PER_METRIC; i += 1) metrics.inc('c_total', { id: String(i) });
    assert.equal(value(metrics.render(), DROPPED_METRIC), 0);

    metrics.inc('c_total', { id: 'extra-1' });
    metrics.inc('c_total', { id: 'extra-1' });
    metrics.inc('c_total', { id: 'extra-2' });
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(text.split('\n').filter((line) => line.startsWith('c_total{')).length, MAX_SERIES_PER_METRIC);
    assert.ok(!text.includes('extra-1'));
    assert.equal(value(text, DROPPED_METRIC), 3);
  });

  it('continua atualizando as séries que já existem', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 10; i += 1) metrics.inc('c_total', { id: String(i) });
    metrics.inc('c_total', { id: '0' }, 4);
    assert.equal(value(metrics.render(), 'c_total{id="0"}'), 5);
  });

  it('o limite é por métrica', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 1; i += 1) metrics.inc('a_total', { id: String(i) });
    metrics.inc('b_total', { id: 'novo' });
    const text = metrics.render();
    assert.equal(value(text, 'b_total{id="novo"}'), 1);
    assert.equal(value(text, DROPPED_METRIC), 1);
  });

  it('vale também para gauges e histogramas', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 5; i += 1) {
      metrics.gauge('g', i, { id: String(i) });
      metrics.observe('h', i, { id: String(i) });
    }
    const text = metrics.render();
    assert.equal(text.split('\n').filter((line) => line.startsWith('g{')).length, MAX_SERIES_PER_METRIC);
    assert.equal(text.split('\n').filter((line) => line.startsWith('h_count{')).length, MAX_SERIES_PER_METRIC);
    assert.equal(value(text, DROPPED_METRIC), 10);
  });

  it('limita também a quantidade de nomes de métrica', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_METRICS + 3; i += 1) metrics.inc(`m_${i}_total`);
    const text = metrics.render();
    // +1 pelo próprio contador de descartes.
    assert.equal(text.split('\n').filter((line) => line.startsWith('# TYPE ')).length, MAX_METRICS + 1);
    assert.equal(value(text, DROPPED_METRIC), 3);
  });

  it('não deixa o chamador sobrescrever o contador de descartes', () => {
    const metrics = createMetrics();
    metrics.inc(DROPPED_METRIC, undefined, 50);
    metrics.gauge(DROPPED_METRIC, 50);
    const text = metrics.render();
    assertValidExposition(text);
    assert.equal(value(text, DROPPED_METRIC), 0);
    assert.equal(text.match(new RegExp(`# TYPE ${DROPPED_METRIC} `, 'g'))?.length, 1);
  });
});
