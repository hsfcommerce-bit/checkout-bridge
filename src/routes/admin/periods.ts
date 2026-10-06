/**
 * Períodos do painel de vendas, sempre em UTC. O servidor não conhece o fuso de quem olha;
 * o cabeçalho da página mostra os limites exatos para não haver dúvida.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type PeriodKey = 'hoje' | 'ontem' | '7d' | '30d' | 'mes';

export const PERIODS: ReadonlyArray<{ key: PeriodKey; label: string }> = [
  { key: 'hoje', label: 'Hoje' },
  { key: 'ontem', label: 'Ontem' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
  { key: 'mes', label: 'Este mês' },
];

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Limites do período. "Até" é o fim do dia corrente (ou do dia de ontem). */
export function periodRange(key: PeriodKey, nowMs: number): { since: string; until: string } {
  const today = startOfUtcDay(nowMs);
  const endOfToday = today + DAY_MS - 1;
  switch (key) {
    case 'hoje':
      return { since: new Date(today).toISOString(), until: new Date(endOfToday).toISOString() };
    case 'ontem':
      return { since: new Date(today - DAY_MS).toISOString(), until: new Date(today - 1).toISOString() };
    case '30d':
      return { since: new Date(today - 29 * DAY_MS).toISOString(), until: new Date(endOfToday).toISOString() };
    case 'mes': {
      const d = new Date(nowMs);
      return {
        since: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
        until: new Date(endOfToday).toISOString(),
      };
    }
    default:
      return { since: new Date(today - 6 * DAY_MS).toISOString(), until: new Date(endOfToday).toISOString() };
  }
}

export function parsePeriod(raw: string | undefined): PeriodKey {
  return PERIODS.some((p) => p.key === raw) ? (raw as PeriodKey) : '7d';
}
