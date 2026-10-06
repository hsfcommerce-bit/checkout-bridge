import type { MetricLabels, Metrics } from '../types.ts';

/**
 * Registro de métricas em memória com exposição no formato de texto do Prometheus.
 *
 * Memória limitada por construção: cada métrica guarda no máximo MAX_SERIES_PER_METRIC
 * combinações de rótulos e o registro guarda no máximo MAX_METRICS nomes. O que passa do
 * limite é descartado e contado em DROPPED_METRIC, para que um rótulo de cardinalidade
 * alta (por engano ou por abuso) apareça no monitoramento em vez de consumir o processo.
 */

/** Limites superiores dos baldes dos histogramas, em milissegundos. */
export const HISTOGRAM_BUCKETS_MS: readonly number[] = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export const MAX_SERIES_PER_METRIC = 2000;
export const MAX_METRICS = 500;
export const DROPPED_METRIC = 'bridge_metrics_dropped_series_total';

type MetricKind = 'counter' | 'gauge' | 'histogram';

/** Sufixos das séries que um histograma expõe além do próprio nome. */
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'] as const;

interface ScalarSeries {
  labels: string;
  value: number;
}

interface HistogramSeries {
  labels: string;
  /**
   * Contagem por balde, NÃO cumulativa; o acumulado é calculado na exposição.
   * Observações acima do último limite só entram em `count` (o balde +Inf).
   */
  buckets: number[];
  sum: number;
  count: number;
}

interface Metric {
  kind: MetricKind;
  scalars: Map<string, ScalarSeries>;
  histograms: Map<string, HistogramSeries>;
}

function sanitizeName(name: string): string {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
  return cleaned === '' || /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Serializa os rótulos já saneados, escapados e ordenados por nome. O resultado serve
 * tanto de chave da série quanto de texto pronto para a exposição.
 */
function serializeLabels(labels: MetricLabels | undefined, reserved: string | null): string {
  if (!labels) return '';
  const pairs = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(labels)) {
    if (rawValue === undefined || rawValue === null) continue;
    let name = sanitizeName(rawName);
    // "le" pertence ao histograma; um rótulo repetido invalidaria a coleta inteira.
    if (name === reserved) name = `exported_${name}`;
    pairs.set(name, escapeLabelValue(String(rawValue)));
  }
  return [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}="${value}"`)
    .join(',');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function withBraces(labels: string): string {
  return labels === '' ? '' : `{${labels}}`;
}

function withLe(labels: string, le: string): string {
  return labels === '' ? `{le="${le}"}` : `{${labels},le="${le}"}`;
}

export function createMetrics(): Metrics {
  const metrics = new Map<string, Metric>();
  let dropped = 0;

  /**
   * Um histograma "x" expõe as séries x_bucket, x_sum e x_count. Um contador ou gauge com
   * um desses nomes (ou um histograma novo cujo sufixo já está em uso) geraria duas
   * amostras com o mesmo nome e tipos diferentes, e a coleta inteira seria recusada.
   */
  function collidesWithHistogram(name: string, kind: MetricKind): boolean {
    if (kind === 'histogram') return HISTOGRAM_SUFFIXES.some((suffix) => metrics.has(`${name}${suffix}`));
    return HISTOGRAM_SUFFIXES.some(
      (suffix) => name.endsWith(suffix) && metrics.get(name.slice(0, -suffix.length))?.kind === 'histogram',
    );
  }

  /**
   * Devolve a métrica com o tipo pedido, ou null quando o nome já está registrado com
   * outro tipo (o Prometheus não aceita o mesmo nome com dois tipos) ou quando o limite
   * de nomes foi atingido.
   */
  function metricFor(rawName: string, kind: MetricKind): { name: string; metric: Metric } | null {
    const name = sanitizeName(rawName);
    if (name === DROPPED_METRIC) return null;
    let metric = metrics.get(name);
    if (!metric) {
      if (metrics.size >= MAX_METRICS || collidesWithHistogram(name, kind)) {
        dropped += 1;
        return null;
      }
      metric = { kind, scalars: new Map(), histograms: new Map() };
      metrics.set(name, metric);
    }
    return metric.kind === kind ? { name, metric } : null;
  }

  function scalarFor(metric: Metric, labels: MetricLabels | undefined): ScalarSeries | null {
    const key = serializeLabels(labels, null);
    let series = metric.scalars.get(key);
    if (!series) {
      if (metric.scalars.size >= MAX_SERIES_PER_METRIC) {
        dropped += 1;
        return null;
      }
      series = { labels: key, value: 0 };
      metric.scalars.set(key, series);
    }
    return series;
  }

  return {
    inc(name, labels, value = 1) {
      // Contador só cresce; incremento negativo ou não finito é ignorado.
      if (!Number.isFinite(value) || value < 0) return;
      const found = metricFor(name, 'counter');
      if (!found) return;
      const series = scalarFor(found.metric, labels);
      if (series) series.value += value;
    },

    gauge(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const found = metricFor(name, 'gauge');
      if (!found) return;
      const series = scalarFor(found.metric, labels);
      if (series) series.value = value;
    },

    observe(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const found = metricFor(name, 'histogram');
      if (!found) return;
      const key = serializeLabels(labels, 'le');
      let series = found.metric.histograms.get(key);
      if (!series) {
        if (found.metric.histograms.size >= MAX_SERIES_PER_METRIC) {
          dropped += 1;
          return;
        }
        series = { labels: key, buckets: HISTOGRAM_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
        found.metric.histograms.set(key, series);
      }
      const index = HISTOGRAM_BUCKETS_MS.findIndex((upper) => value <= upper);
      if (index !== -1) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      series.sum += value;
      series.count += 1;
    },

    render() {
      const lines: string[] = [];
      for (const [name, metric] of metrics) {
        lines.push(`# TYPE ${name} ${metric.kind}`);
        if (metric.kind === 'histogram') {
          for (const series of metric.histograms.values()) {
            let cumulative = 0;
            HISTOGRAM_BUCKETS_MS.forEach((upper, i) => {
              cumulative += series.buckets[i] ?? 0;
              lines.push(`${name}_bucket${withLe(series.labels, String(upper))} ${cumulative}`);
            });
            lines.push(`${name}_bucket${withLe(series.labels, '+Inf')} ${series.count}`);
            lines.push(`${name}_sum${withBraces(series.labels)} ${formatNumber(series.sum)}`);
            lines.push(`${name}_count${withBraces(series.labels)} ${series.count}`);
          }
        } else {
          for (const series of metric.scalars.values()) {
            lines.push(`${name}${withBraces(series.labels)} ${formatNumber(series.value)}`);
          }
        }
      }
      // Sempre presente, mesmo em zero, para que um alerta sobre ela nunca fique sem dados.
      // Conta atualizações descartadas (não séries distintas: lembrar quais foram
      // descartadas exigiria justamente a memória que o limite protege).
      lines.push(`# TYPE ${DROPPED_METRIC} counter`);
      lines.push(`${DROPPED_METRIC} ${dropped}`);
      return `${lines.join('\n')}\n`;
    },
  };
}
