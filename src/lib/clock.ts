import type { Clock } from '../types.ts';

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Relógio controlável para testes. */
export function fakeClock(start: Date | string = '2026-01-01T00:00:00.000Z'): Clock & {
  set(date: Date | string): void;
  advance(ms: number): void;
} {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set(date) {
      current = new Date(date).getTime();
    },
    advance(ms) {
      current += ms;
    },
  };
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
