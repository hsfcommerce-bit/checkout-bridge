import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeClock, isoNow, systemClock } from '../src/lib/clock.ts';

describe('systemClock', () => {
  it('devolve a hora atual', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    assert.ok(now instanceof Date);
    assert.ok(now.getTime() >= before && now.getTime() <= after);
  });
});

describe('fakeClock', () => {
  it('começa em uma data fixa por padrão', () => {
    assert.equal(fakeClock().now().toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('aceita string ou Date como início', () => {
    assert.equal(fakeClock('2026-05-06T07:08:09.123Z').now().toISOString(), '2026-05-06T07:08:09.123Z');
    assert.equal(fakeClock(new Date('2030-01-01T00:00:00.000Z')).now().getTime(), Date.UTC(2030, 0, 1));
  });

  it('fica parado até alguém mexer', async () => {
    const clock = fakeClock();
    const first = clock.now().getTime();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.now().getTime(), first);
  });

  it('advance soma milissegundos (e aceita valores negativos)', () => {
    const clock = fakeClock('2026-01-01T00:00:00.000Z');
    clock.advance(1500);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:00:01.500Z');
    clock.advance(60_000);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:01:01.500Z');
    clock.advance(-1500);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:01:00.000Z');
  });

  it('set troca a data', () => {
    const clock = fakeClock();
    clock.set('2027-02-03T04:05:06.000Z');
    assert.equal(clock.now().toISOString(), '2027-02-03T04:05:06.000Z');
    clock.set(new Date(0));
    assert.equal(clock.now().getTime(), 0);
    clock.advance(10);
    assert.equal(clock.now().getTime(), 10);
  });

  it('devolve um Date novo a cada chamada', () => {
    const clock = fakeClock();
    const a = clock.now();
    a.setFullYear(1999);
    assert.notEqual(clock.now(), a);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('não guarda referência ao Date de início', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const clock = fakeClock(start);
    start.setFullYear(1999);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('relógios são independentes', () => {
    const a = fakeClock();
    const b = fakeClock();
    a.advance(1000);
    assert.equal(b.now().toISOString(), '2026-01-01T00:00:00.000Z');
  });
});

describe('isoNow', () => {
  it('formata o instante do relógio em ISO 8601 UTC', () => {
    const clock = fakeClock('2026-12-31T23:59:59.999Z');
    assert.equal(isoNow(clock), '2026-12-31T23:59:59.999Z');
    clock.advance(1);
    assert.equal(isoNow(clock), '2027-01-01T00:00:00.000Z');
  });

  it('funciona com o relógio do sistema', () => {
    assert.match(isoNow(systemClock), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
