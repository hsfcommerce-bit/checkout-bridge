import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeClock } from '../src/lib/clock.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';

describe('balde de fichas', () => {
  it('permite até a capacidade e depois recusa com o tempo de espera', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, clock });
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(limiter.take('ip'), { allowed: true, retryAfterMs: 0 }, `tentativa ${i + 1}`);
    }
    assert.deepEqual(limiter.take('ip'), { allowed: false, retryAfterMs: 1000 });
  });

  it('recarrega de forma proporcional ao tempo', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, clock });
    for (let i = 0; i < 5; i += 1) limiter.take('ip');

    clock.advance(400);
    assert.deepEqual(limiter.take('ip'), { allowed: false, retryAfterMs: 600 });
    clock.advance(599);
    assert.deepEqual(limiter.take('ip'), { allowed: false, retryAfterMs: 1 });
    clock.advance(1);
    assert.deepEqual(limiter.take('ip'), { allowed: true, retryAfterMs: 0 });
    assert.equal(limiter.take('ip').allowed, false);

    clock.advance(2500);
    assert.equal(limiter.take('ip').allowed, true);
    assert.equal(limiter.take('ip').allowed, true);
    // Sobra meia ficha: falta meio segundo para a próxima.
    assert.deepEqual(limiter.take('ip'), { allowed: false, retryAfterMs: 500 });
  });

  it('lida com taxa fracionária (20 por minuto)', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 20, refillPerSecond: 20 / 60, clock });
    for (let i = 0; i < 20; i += 1) assert.equal(limiter.take('ip').allowed, true);
    assert.deepEqual(limiter.take('ip'), { allowed: false, retryAfterMs: 3000 });
    clock.advance(2999);
    assert.equal(limiter.take('ip').allowed, false);
    clock.advance(1);
    assert.equal(limiter.take('ip').allowed, true);
    assert.equal(limiter.take('ip').allowed, false);
    // Um minuto inteiro repõe exatamente 20, não mais.
    clock.advance(60_000);
    let allowed = 0;
    for (let i = 0; i < 30; i += 1) if (limiter.take('ip').allowed) allowed += 1;
    assert.equal(allowed, 20);
  });

  it('nunca acumula além da capacidade', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 10, clock });
    limiter.take('ip');
    clock.advance(24 * 60 * 60 * 1000);
    let allowed = 0;
    for (let i = 0; i < 10; i += 1) if (limiter.take('ip').allowed) allowed += 1;
    assert.equal(allowed, 3);
  });

  it('uma recusa não consome fichas', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, clock });
    limiter.take('ip');
    limiter.take('ip');
    for (let i = 0; i < 50; i += 1) assert.equal(limiter.take('ip').allowed, false);
    clock.advance(1000);
    assert.equal(limiter.take('ip').allowed, true);
  });

  it('o tempo de espera informado é suficiente e exato', () => {
    for (const refillPerSecond of [1, 0.1, 1 / 3, 7 / 13, 2.5, 600 / 60, 0.017]) {
      const clock = fakeClock();
      const limiter = createRateLimiter({ capacity: 4, refillPerSecond, clock });
      for (let i = 0; i < 4; i += 1) limiter.take('k');
      for (let round = 0; round < 25; round += 1) {
        const denied = limiter.take('k');
        assert.equal(denied.allowed, false, `taxa ${refillPerSecond}, rodada ${round}`);
        assert.ok(Number.isInteger(denied.retryAfterMs) && denied.retryAfterMs > 0);
        // Um milissegundo antes ainda não pode.
        clock.advance(denied.retryAfterMs - 1);
        assert.equal(limiter.take('k').allowed, false, `taxa ${refillPerSecond}: liberou cedo demais`);
        clock.advance(1);
        assert.equal(limiter.take('k').allowed, true, `taxa ${refillPerSecond}: não liberou no prazo`);
      }
    }
  });

  it('mantém as chaves independentes', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, clock });
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, false);
    assert.equal(limiter.take('b').allowed, true);
    assert.equal(limiter.take('').allowed, true);
    assert.equal(limiter.take('__proto__').allowed, true);
    assert.equal(limiter.take('__proto__').allowed, false);
  });
});

describe('custo', () => {
  it('desconta o custo informado', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, clock });
    assert.deepEqual(limiter.take('k', 3), { allowed: true, retryAfterMs: 0 });
    // Restam 2; faltam 1 ficha = 1 segundo.
    assert.deepEqual(limiter.take('k', 3), { allowed: false, retryAfterMs: 1000 });
    assert.deepEqual(limiter.take('k', 2), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(limiter.take('k', 5), { allowed: false, retryAfterMs: 5000 });
  });

  it('custo maior que a capacidade nunca passa, mas a espera é finita', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, clock });
    const decision = limiter.take('k', 6);
    assert.equal(decision.allowed, false);
    assert.ok(Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0);
    clock.advance(60_000);
    assert.equal(limiter.take('k', 6).allowed, false);
    // E não consumiu nada no caminho.
    assert.equal(limiter.take('k', 5).allowed, true);
  });

  it('custo zero passa sem consumir', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, clock });
    limiter.take('k');
    assert.deepEqual(limiter.take('k', 0), { allowed: true, retryAfterMs: 0 });
    assert.equal(limiter.take('k').allowed, false);
  });

  it('custo inválido conta como 1', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, clock });
    assert.equal(limiter.take('k', Number.NaN).allowed, true);
    assert.equal(limiter.take('k', -5).allowed, true);
    assert.equal(limiter.take('k', Number.POSITIVE_INFINITY).allowed, true);
    assert.equal(limiter.take('k').allowed, false);
  });
});

describe('relógio', () => {
  it('relógio andando para trás não quebra nem dá fichas extras', () => {
    const clock = fakeClock('2026-01-01T00:00:10.000Z');
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, clock });
    limiter.take('k');
    limiter.take('k');
    clock.set('2026-01-01T00:00:00.000Z');
    const decision = limiter.take('k');
    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterMs, 1000);
    clock.advance(1000);
    assert.equal(limiter.take('k').allowed, true);
  });

  it('usa o relógio do sistema por padrão', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 0.001 });
    assert.equal(limiter.take('k').allowed, true);
    assert.equal(limiter.take('k').allowed, true);
    const denied = limiter.take('k');
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0);
  });
});

describe('limite de chaves', () => {
  it('remove primeiro os baldes cheios (ociosos), mesmo que não sejam os mais antigos', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, clock, maxKeys: 3 });
    // "a" é a chave mais antiga e fica com 0 fichas; "b" e "c" ficam com 1.
    limiter.take('a');
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    // Depois de 1 s: "a" tem 1 ficha (não está cheia); "b" e "c" voltaram a 2 (cheias).
    clock.advance(1000);
    limiter.take('d');
    // Se "a" tivesse sido removida, voltaria com 2 fichas e passaria duas vezes.
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, false);
  });

  it('sem baldes ociosos, remove o usado há mais tempo', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, clock, maxKeys: 3 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    for (const key of ['a', 'b', 'c']) assert.equal(limiter.take(key).allowed, false);
    // Ordem de uso agora: a, b, c. A chave nova expulsa "a".
    limiter.take('d');
    // "b" continua lá (recusada); consultar "b" a move para o fim.
    assert.equal(limiter.take('b').allowed, false);
    // "a" foi removida: volta como chave nova, com o balde cheio (e expulsa "c").
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('d').allowed, false);
    assert.equal(limiter.take('b').allowed, false);
  });

  it('usar uma chave, mesmo recusada, renova a posição dela', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, clock, maxKeys: 3 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    // "a" é martelada: passa a ser a mais recente. A mais antiga vira "b".
    assert.equal(limiter.take('a').allowed, false);
    limiter.take('d');
    assert.equal(limiter.take('a').allowed, false, '"a" não pode voltar com o balde cheio');
    assert.equal(limiter.take('c').allowed, false);
    assert.equal(limiter.take('b').allowed, true, '"b" era a mais antiga e foi removida');
  });

  it('a memória fica limitada sob uma enxurrada de chaves distintas', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, clock, maxKeys: 50 });
    for (let i = 0; i < 5000; i += 1) assert.equal(limiter.take(`ip-${i}`).allowed, true);
    // As 50 mais recentes continuam guardadas (recusadas) ...
    for (let i = 4950; i < 5000; i += 1) assert.equal(limiter.take(`ip-${i}`).allowed, false, `ip-${i}`);
    // ... e as antigas foram esquecidas.
    assert.equal(limiter.take('ip-0').allowed, true);
    assert.equal(limiter.take('ip-2500').allowed, true);
  });

  it('funciona com maxKeys = 1', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, clock, maxKeys: 1 });
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, false);
    assert.equal(limiter.take('b').allowed, true);
    assert.equal(limiter.take('a').allowed, true);
  });

  it('maxKeys inválido cai no padrão', () => {
    const clock = fakeClock();
    for (const maxKeys of [0, -1, Number.NaN]) {
      const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, clock, maxKeys });
      limiter.take('a');
      limiter.take('b');
      assert.equal(limiter.take('a').allowed, false, `maxKeys ${maxKeys}`);
    }
  });
});

describe('opções inválidas', () => {
  it('lança na criação', () => {
    const invalid = [
      { capacity: 0, refillPerSecond: 1 },
      { capacity: -1, refillPerSecond: 1 },
      { capacity: Number.NaN, refillPerSecond: 1 },
      { capacity: Number.POSITIVE_INFINITY, refillPerSecond: 1 },
      { capacity: 1, refillPerSecond: 0 },
      { capacity: 1, refillPerSecond: -1 },
      { capacity: 1, refillPerSecond: Number.NaN },
    ];
    for (const opts of invalid) {
      assert.throws(() => createRateLimiter(opts), Error, JSON.stringify(opts));
    }
  });
});
