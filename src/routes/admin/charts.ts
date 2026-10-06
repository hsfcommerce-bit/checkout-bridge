import { html, raw } from 'hono/html';
import { formatMoney, toMicros } from '../../lib/money.ts';
import type { Markup } from './layout.ts';

/**
 * Gráficos renderizados no servidor como SVG embutido (marcação, não script), compatíveis
 * com a CSP do painel. Todos os textos passam pelo escape de hono/html; só números e
 * coordenadas calculados aqui entram em raw().
 */

export interface BarPoint {
  /** Rótulo curto do eixo (dia). */
  label: string;
  /** Valor decimal ("39.99") quando é dinheiro, ou inteiro quando é contagem. */
  value: string;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Valor "redondo" acima do máximo para o topo do eixo (1, 2, 5 × 10^n). */
function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (max <= m * base) return m * base;
  return 10 * base;
}

function fmtAxis(value: number, currency: string | null): string {
  if (currency === null) return String(Math.round(value));
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace('.', ',')} mil`;
  return value.toFixed(value < 10 ? 2 : 0).replace('.', ',');
}

/**
 * Barras verticais. `currency` nula significa contagem (pedidos); com moeda, os valores são
 * decimais e as dicas mostram o valor formatado.
 */
export function barChart(opts: { title: string; points: BarPoint[]; currency: string | null }): Markup {
  const points = opts.points.slice(0, 120);
  if (points.length === 0) {
    return html`<div class="chart-empty">Sem dados no período.</div>`;
  }
  const values = points.map((p) => {
    try {
      return Number(toMicros(p.value)) / 1_000_000;
    } catch {
      return 0;
    }
  });
  const max = niceMax(Math.max(...values, 0));
  const W = 720;
  const H = 220;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const slot = innerW / points.length;
  const barW = Math.max(2, Math.min(28, slot * 0.62));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // Rótulos do eixo X: no máximo ~10, para não se sobreporem.
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));

  const grid = ticks
    .map((t) => {
      const y = padT + innerH - innerH * t;
      return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="chart-grid"/>` +
        `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="chart-axis">${esc(fmtAxis(max * t, opts.currency))}</text>`;
    })
    .join('');

  const bars = points
    .map((p, i) => {
      const v = values[i] ?? 0;
      const h = max > 0 ? (v / max) * innerH : 0;
      const x = padL + slot * i + (slot - barW) / 2;
      const y = padT + innerH - h;
      const tip = opts.currency === null ? `${p.label}: ${Math.round(v)}` : `${p.label}: ${formatMoney(p.value, opts.currency)}`;
      const label =
        i % labelEvery === 0
          ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="chart-axis">${esc(p.label)}</text>`
          : '';
      return `<g><title>${esc(tip)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, v > 0 ? 2 : 0).toFixed(1)}" rx="3" class="chart-bar"/></g>${label}`;
    })
    .join('');

  const svg =
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title-${esc(opts.title).replace(/[^a-z0-9]/gi, '')}">` +
    `<title id="chart-title-${esc(opts.title).replace(/[^a-z0-9]/gi, '')}">${esc(opts.title)}</title>${grid}${bars}</svg>`;
  return raw(svg);
}
