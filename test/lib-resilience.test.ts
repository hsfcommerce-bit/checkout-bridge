import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { fakeClock } from '../src/lib/clock.ts';
import type { BreakerState } from '../src/lib/resilience.ts';
import {
  CircuitBreaker,
  CircuitOpenError,
  createBreakerRegistry,
  fetchWithTimeout,
  HttpStatusError,
  isRetryableError,
  parseRetryAfterMs,
  retry,
  TimeoutError,
} from '../src/lib/resilience.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** fetch falso que nunca responde, mas respeita o sinal de aborto como o fetch real. */
function hangingFetch(seen: { signal?: AbortSignal } = {}): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      seen.signal = signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

const boom = (message = 'falha'): (() => Promise<never>) => () => Promise.reject(new Error(message));

// ---------------------------------------------------------------------------

describe('classes de erro', () => {
  it('TimeoutError', () => {
    const err = new TimeoutError();
    assert.ok(err instanceof Error && err instanceof TimeoutError);
    assert.equal(err.name, 'TimeoutError');
    assert.equal(new TimeoutError('mensagem própria').message, 'mensagem própria');
    assert.match(new TimeoutError(1500).message, /1500 ms/);
  });

  it('CircuitOpenError', () => {
    const err = new CircuitOpenError(2500);
    assert.ok(err instanceof Error && err instanceof CircuitOpenError);
    assert.equal(err.name, 'CircuitOpenError');
    assert.equal(err.retryAfterMs, 2500);
    assert.equal(new CircuitOpenError().retryAfterMs, 0);
    assert.equal(new CircuitOpenError(-5).retryAfterMs, 0);
    assert.equal(new CircuitOpenError(Number.NaN).retryAfterMs, 0);
  });

  it('HttpStatusError aceita os argumentos em qualquer das formas previstas', () => {
    const bare = new HttpStatusError(503);
    assert.ok(bare instanceof Error && bare instanceof HttpStatusError);
    assert.equal(bare.name, 'HttpStatusError');
    assert.deepEqual([bare.status, bare.retryAfterMs, bare.bodySnippet], [503, null, '']);
    assert.match(bare.message, /503/);

    const a = new HttpStatusError(429, 2000, 'devagar');
    assert.deepEqual([a.status, a.retryAfterMs, a.bodySnippet], [429, 2000, 'devagar']);

    const b = new HttpStatusError(429, 'devagar', 2000);
    assert.deepEqual([b.status, b.retryAfterMs, b.bodySnippet], [429, 2000, 'devagar']);

    const c = new HttpStatusError(500, { retryAfterMs: 10, bodySnippet: 'x', message: 'minha mensagem' });
    assert.deepEqual([c.status, c.retryAfterMs, c.bodySnippet, c.message], [500, 10, 'x', 'minha mensagem']);

    const d = new HttpStatusError(502, null, 'corpo');
    assert.deepEqual([d.retryAfterMs, d.bodySnippet], [null, 'corpo']);

    const e = new HttpStatusError(502, 'só o corpo');
    assert.deepEqual([e.retryAfterMs, e.bodySnippet], [null, 'só o corpo']);

    assert.equal(new HttpStatusError(500, {}).retryAfterMs, null);
    assert.equal(new HttpStatusError(500, 0).retryAfterMs, 0);
  });

  it('HttpStatusError descarta retryAfterMs inválido e trunca o corpo', () => {
    assert.equal(new HttpStatusError(500, Number.NaN).retryAfterMs, null);
    assert.equal(new HttpStatusError(500, -1).retryAfterMs, null);
    assert.equal(new HttpStatusError(500, Number.POSITIVE_INFINITY).retryAfterMs, null);
    const big = new HttpStatusError(500, null, 'x'.repeat(10_000));
    assert.equal(big.bodySnippet.length, 500);
    assert.ok(!big.message.includes('xxx'), 'o corpo não entra na mensagem');
  });

  it('HttpStatusError.fromResponse lê Retry-After e o corpo', async () => {
    const res = new Response('{"errors":"Throttled"}', { status: 429, headers: { 'Retry-After': '2.0' } });
    const err = await HttpStatusError.fromResponse(res);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 2000);
    assert.equal(err.bodySnippet, '{"errors":"Throttled"}');

    const plain = await HttpStatusError.fromResponse(new Response(null, { status: 503 }));
    assert.deepEqual([plain.status, plain.retryAfterMs, plain.bodySnippet], [503, null, '']);
  });
});

// ---------------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  afterEach(() => mock.timers.reset());

  it('devolve a resposta e repassa url e opções', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      });
    }) as typeof fetch;

    const res = await fetchWithTimeout(
      fetchImpl,
      'https://loja.test/api',
      { method: 'POST', headers: { 'x-a': '1' }, body: 'corpo' },
      1000,
    );
    assert.equal(res.status, 201);
    assert.equal(res.statusText, 'Created');
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('x-request-id'), 'abc');
    assert.deepEqual(await res.json(), { ok: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://loja.test/api');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(calls[0]?.init?.body, 'corpo');
    assert.deepEqual(calls[0]?.init?.headers, { 'x-a': '1' });
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  });

  it('preserva respostas de erro e sem corpo', async () => {
    const error = await fetchWithTimeout((async () => new Response('nada', { status: 503 })) as typeof fetch, 'https://x.test', {}, 1000);
    assert.equal(error.status, 503);
    assert.equal(await error.text(), 'nada');

    const empty = await fetchWithTimeout((async () => new Response(null, { status: 204 })) as typeof fetch, 'https://x.test', {}, 1000);
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');
  });

  it('preserva vários Set-Cookie', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const res = await fetchWithTimeout((async () => new Response('x', { headers })) as typeof fetch, 'https://x.test', {}, 1000);
    assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
  });

  it('rejeita com TimeoutError quando o prazo estoura e aborta a chamada', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const seen: { signal?: AbortSignal } = {};
    let settled = false;
    const pending = fetchWithTimeout(hangingFetch(seen), 'https://x.test/caminho-secreto', {}, 1000);
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    mock.timers.tick(999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(seen.signal?.aborted, false);

    mock.timers.tick(1);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.ok(!err.message.includes('caminho-secreto'), 'a URL não entra na mensagem');
      return true;
    });
    assert.equal(seen.signal?.aborted, true);
  });

  it('estoura o prazo mesmo que o fetch ignore o sinal de aborto', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const deaf = (() => new Promise<Response>(() => {})) as typeof fetch;
    const pending = fetchWithTimeout(deaf, 'https://x.test', {}, 50);
    mock.timers.tick(50);
    await assert.rejects(pending, TimeoutError);
  });

  it('o prazo cobre também a leitura do corpo', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    // Cabeçalhos chegam na hora; o corpo começa e nunca termina.
    const stalled = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('parcial'));
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const pending = fetchWithTimeout(stalled, 'https://x.test', {}, 200);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(200);
    await assert.rejects(pending, TimeoutError);
  });

  it('limpa o timer depois do sucesso', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response('ok');
    }) as typeof fetch;
    await fetchWithTimeout(fetchImpl, 'https://x.test', {}, 1000);
    // Se o timer ainda existisse, avançar o tempo abortaria o sinal.
    mock.timers.tick(60_000);
    assert.equal(signal?.aborted, false);
  });

  it('limpa o timer depois de uma falha e repassa o erro original', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | undefined;
    const failure = new TypeError('fetch failed');
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw failure;
    }) as typeof fetch;
    await assert.rejects(fetchWithTimeout(fetchImpl, 'https://x.test', {}, 1000), (err: unknown) => err === failure);
    mock.timers.tick(60_000);
    assert.equal(signal?.aborted, false);
  });

  it('trata fetch que lança de forma síncrona', async () => {
    const failure = new TypeError('Invalid URL');
    const fetchImpl = (() => {
      throw failure;
    }) as unknown as typeof fetch;
    await assert.rejects(fetchWithTimeout(fetchImpl, 'nada', {}, 1000), (err: unknown) => err === failure);
  });

  it('respeita o sinal de quem chamou, sem transformar em TimeoutError', async () => {
    const outer = new AbortController();
    const reason = new Error('cancelado por quem chamou');
    const pending = fetchWithTimeout(hangingFetch(), 'https://x.test', { signal: outer.signal }, 60_000);
    outer.abort(reason);
    await assert.rejects(pending, (err: unknown) => err === reason);

    const already = fetchWithTimeout(hangingFetch(), 'https://x.test', { signal: AbortSignal.abort(reason) }, 60_000);
    await assert.rejects(already, (err: unknown) => err === reason);
  });

  it('devolve intacto o que não é uma Response de verdade', async () => {
    const fake = { status: 200, ok: true, json: async () => ({ a: 1 }) } as unknown as Response;
    const res = await fetchWithTimeout((async () => fake) as typeof fetch, 'https://x.test', {}, 1000);
    assert.equal(res, fake);
  });
});

// ---------------------------------------------------------------------------

describe('parseRetryAfterMs', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('interpreta segundos', () => {
    assert.equal(parseRetryAfterMs('2', now), 2000);
    assert.equal(parseRetryAfterMs('2.0', now), 2000);
    assert.equal(parseRetryAfterMs('1.5', now), 1500);
    assert.equal(parseRetryAfterMs('0', now), 0);
    assert.equal(parseRetryAfterMs(' 3 ', now), 3000);
    assert.equal(parseRetryAfterMs('0.0004', now), 1);
    assert.equal(parseRetryAfterMs('120', now), 120_000);
  });

  it('interpreta data HTTP', () => {
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000);
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
    assert.equal(parseRetryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now), 0, 'data no passado vira 0');
  });

  it('devolve null quando ausente ou ilegível', () => {
    for (const value of [null, '', '   ', 'abc', '-5', '+5', '1e3', '1,5', '5s', 'soon', 'Foo, 99 Bar 2026', '2026-01-01T00:00:10Z', `${'9'.repeat(400)}`]) {
      assert.equal(parseRetryAfterMs(value, now), null, JSON.stringify(value));
    }
    assert.equal(parseRetryAfterMs(undefined as unknown as null, now), null);
    assert.equal(parseRetryAfterMs(5 as unknown as string, now), null);
  });

  it('usa o relógio real quando now não é informado', () => {
    assert.equal(parseRetryAfterMs('1'), 1000);
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms !== null && ms > 3_500_000 && ms <= 3_600_000);
  });
});

// ---------------------------------------------------------------------------

describe('retry', () => {
  /** sleep falso que só registra as esperas pedidas. */
  function recorder() {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => void delays.push(ms) };
  }
  const always = (): boolean => true;

  it('não espera nem repete quando dá certo de primeira', async () => {
    const { delays, sleep } = recorder();
    const attempts: number[] = [];
    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        return 'ok';
      },
      { retries: 3, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: always, sleep },
    );
    assert.equal(result, 'ok');
    assert.deepEqual(attempts, [0]);
    assert.deepEqual(delays, []);
  });

  it('repete até dar certo, com attempt começando em 0', async () => {
    const { delays, sleep } = recorder();
    const attempts: number[] = [];
    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) throw new Error(`falha ${attempt}`);
        return 'na terceira';
      },
      { retries: 5, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: always, sleep, random: () => 0.5 },
    );
    assert.equal(result, 'na terceira');
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.deepEqual(delays, [50, 100]);
  });

  it('fn roda no máximo retries + 1 vezes e o último erro é propagado', async () => {
    for (const retries of [0, 1, 3, 7]) {
      const { delays, sleep } = recorder();
      let calls = 0;
      await assert.rejects(
        retry(
          async () => {
            calls += 1;
            throw new Error(`falha ${calls}`);
          },
          { retries, baseDelayMs: 1, maxDelayMs: 10, shouldRetry: always, sleep },
        ),
        new RegExp(`falha ${retries + 1}$`),
      );
      assert.equal(calls, retries + 1, `retries = ${retries}`);
      assert.equal(delays.length, retries);
    }
  });

  it('retries inválido equivale a zero', async () => {
    for (const retries of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      let calls = 0;
      await assert.rejects(
        retry(
          async () => {
            calls += 1;
            throw new Error('x');
          },
          { retries, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: always, sleep: async () => {} },
        ),
      );
      assert.equal(calls, 1);
    }
  });

  it('o teto da espera dobra a cada tentativa até maxDelayMs', async () => {
    const { delays, sleep } = recorder();
    await assert.rejects(
      retry(boom(), { retries: 6, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: always, sleep, random: () => 1 }),
    );
    assert.deepEqual(delays, [100, 200, 400, 800, 1000, 1000]);
  });

  it('jitter total: a espera fica entre 0 e o teto', async () => {
    const zero = recorder();
    await assert.rejects(
      retry(boom(), { retries: 4, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: always, sleep: zero.sleep, random: () => 0 }),
    );
    assert.deepEqual(zero.delays, [0, 0, 0, 0]);

    // Sequência pseudoaleatória fixa, para o teste ser determinístico.
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const many = recorder();
    await assert.rejects(
      retry(boom(), { retries: 12, baseDelayMs: 50, maxDelayMs: 2000, shouldRetry: always, sleep: many.sleep, random }),
    );
    assert.equal(many.delays.length, 12);
    many.delays.forEach((delay, attempt) => {
      const ceiling = Math.min(2000, 50 * 2 ** attempt);
      assert.ok(delay >= 0 && delay <= ceiling, `tentativa ${attempt}: ${delay} fora de [0, ${ceiling}]`);
    });
    assert.ok(new Set(many.delays).size > 6, 'as esperas devem variar');
  });

  it('não repete quando shouldRetry diz que não', async () => {
    const { delays, sleep } = recorder();
    const seen: unknown[] = [];
    const failure = new Error('definitivo');
    let calls = 0;
    await assert.rejects(
      retry(
        async () => {
          calls += 1;
          throw failure;
        },
        {
          retries: 5,
          baseDelayMs: 1,
          maxDelayMs: 1,
          sleep,
          shouldRetry: (err) => {
            seen.push(err);
            return false;
          },
        },
      ),
      (err: unknown) => err === failure,
    );
    assert.equal(calls, 1);
    assert.deepEqual(seen, [failure]);
    assert.deepEqual(delays, []);
  });

  it('para de repetir quando o erro muda para um não repetível', async () => {
    let calls = 0;
    await assert.rejects(
      retry(
        async () => {
          calls += 1;
          throw calls < 3 ? new HttpStatusError(503) : new HttpStatusError(400);
        },
        { retries: 10, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: isRetryableError, sleep: async () => {} },
      ),
      (err: unknown) => err instanceof HttpStatusError && err.status === 400,
    );
    assert.equal(calls, 3);
  });

  it('respeita retryAfterMs do erro como espera mínima', async () => {
    const { delays, sleep } = recorder();
    let calls = 0;
    await assert.rejects(
      retry(
        async () => {
          calls += 1;
          throw new HttpStatusError(429, 300);
        },
        { retries: 2, baseDelayMs: 100, maxDelayMs: 1000, shouldRetry: always, sleep, random: () => 0.5 },
      ),
    );
    // Jitter daria 50 e 100; o Retry-After de 300 ms prevalece.
    assert.deepEqual(delays, [300, 300]);
  });

  it('não reduz a espera quando o jitter já é maior que retryAfterMs', async () => {
    const { delays, sleep } = recorder();
    await assert.rejects(
      retry(() => Promise.reject(new HttpStatusError(429, 10)), {
        retries: 1,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        shouldRetry: always,
        sleep,
        random: () => 0.9,
      }),
    );
    assert.deepEqual(delays, [90]);
  });

  it('limita retryAfterMs a 4 x maxDelayMs', async () => {
    const { delays, sleep } = recorder();
    await assert.rejects(
      retry(() => Promise.reject(new HttpStatusError(429, 3_600_000)), {
        retries: 1,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        shouldRetry: always,
        sleep,
        random: () => 0.5,
      }),
    );
    assert.deepEqual(delays, [4000]);
  });

  it('ignora retryAfterMs que não é número válido', async () => {
    const { delays, sleep } = recorder();
    const weird = [{ retryAfterMs: '500' }, { retryAfterMs: Number.NaN }, { retryAfterMs: -1 }, { retryAfterMs: null }, 'texto', null];
    let index = 0;
    await assert.rejects(
      retry(() => Promise.reject(weird[index++]), {
        retries: weird.length - 1,
        baseDelayMs: 8,
        maxDelayMs: 8,
        shouldRetry: always,
        sleep,
        random: () => 0.5,
      }),
    );
    assert.deepEqual(delays, [4, 4, 4, 4, 4]);
  });

  it('chama onRetry com erro, tentativa e espera', async () => {
    const events: Array<[string, number, number]> = [];
    await assert.rejects(
      retry(
        async (attempt) => {
          throw new Error(`e${attempt}`);
        },
        {
          retries: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          shouldRetry: always,
          sleep: async () => {},
          random: () => 0.5,
          onRetry: (err, attempt, delayMs) => void events.push([(err as Error).message, attempt, delayMs]),
        },
      ),
    );
    // Não há onRetry depois da última tentativa: nada mais será repetido.
    assert.deepEqual(events, [
      ['e0', 0, 50],
      ['e1', 1, 100],
    ]);
  });

  it('uma falha em onRetry não interrompe as tentativas', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('x');
        return calls;
      },
      {
        retries: 5,
        baseDelayMs: 1,
        maxDelayMs: 1,
        shouldRetry: always,
        sleep: async () => {},
        onRetry: () => {
          throw new Error('observador quebrado');
        },
      },
    );
    assert.equal(result, 3);
  });

  it('funciona com sleep e random padrão', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('x');
        return 'ok';
      },
      { retries: 1, baseDelayMs: 1, maxDelayMs: 2, shouldRetry: always },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });
});

// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  it('timeout e falha de rede valem nova tentativa', () => {
    assert.equal(isRetryableError(new TimeoutError()), true);
    assert.equal(isRetryableError(new TypeError('fetch failed')), true);
    assert.equal(isRetryableError(new TypeError('terminated')), true);
    assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
    assert.equal(isRetryableError(new TypeError('network error')), true);
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    assert.equal(isRetryableError(new TypeError('fetch failed', { cause })), true);
    assert.equal(
      isRetryableError(new TypeError('algo deu errado', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
      true,
    );
  });

  it('HTTP 429 e 5xx valem nova tentativa; os outros não', () => {
    for (const status of [429, 500, 502, 503, 504, 599]) {
      assert.equal(isRetryableError(new HttpStatusError(status)), true, String(status));
    }
    for (const status of [200, 301, 400, 401, 403, 404, 409, 422, 428, 430, 499, 600]) {
      assert.equal(isRetryableError(new HttpStatusError(status)), false, String(status));
    }
  });

  it('circuito aberto NÃO vale nova tentativa', () => {
    assert.equal(isRetryableError(new CircuitOpenError(1000)), false);
  });

  it('erros de programação e valores estranhos não valem nova tentativa', () => {
    const cases: unknown[] = [
      new Error('fetch failed'),
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new TypeError('x is not a function'),
      new TypeError('Invalid URL', { cause: { code: 'ERR_INVALID_URL' } }),
      new RangeError('fora do intervalo'),
      new DOMException('This operation was aborted', 'AbortError'),
      { status: 503 },
      { name: 'TimeoutError' },
      'fetch failed',
      503,
      null,
      undefined,
    ];
    for (const value of cases) {
      assert.equal(isRetryableError(value), false, String(value));
    }
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  function setup(failureThreshold = 3, openMs = 10_000) {
    const clock = fakeClock();
    const changes: BreakerState[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold,
      openMs,
      clock,
      onStateChange: (state) => void changes.push(state),
    });
    const fail = (message = 'falha'): Promise<void> => assert.rejects(breaker.exec(boom(message)), new RegExp(message));
    const succeed = (): Promise<string> => breaker.exec(async () => 'ok');
    return { clock, changes, breaker, fail, succeed };
  }

  it('começa fechado e devolve o resultado de fn', async () => {
    const { breaker, changes } = setup();
    assert.equal(breaker.state, 'closed');
    assert.equal(await breaker.exec(async () => 42), 42);
    assert.equal(breaker.state, 'closed');
    assert.deepEqual(changes, []);
  });

  it('repassa o erro original de fn', async () => {
    const { breaker } = setup();
    const failure = new HttpStatusError(503);
    await assert.rejects(breaker.exec(() => Promise.reject(failure)), (err: unknown) => err === failure);
  });

  it('closed -> open depois de N falhas CONSECUTIVAS', async () => {
    const { breaker, changes, fail } = setup(3);
    await fail();
    await fail();
    assert.equal(breaker.state, 'closed');
    await fail();
    assert.equal(breaker.state, 'open');
    assert.deepEqual(changes, ['open']);
  });

  it('um sucesso zera a sequência de falhas', async () => {
    const { breaker, changes, fail, succeed } = setup(3);
    for (let round = 0; round < 5; round += 1) {
      await fail();
      await fail();
      await succeed();
    }
    assert.equal(breaker.state, 'closed');
    assert.deepEqual(changes, []);
  });

  it('aberto: recusa na hora, sem chamar fn, e informa quanto falta', async () => {
    const { breaker, clock, fail } = setup(2, 10_000);
    await fail();
    await fail();
    let called = 0;
    const attempt = (): Promise<string> =>
      breaker.exec(async () => {
        called += 1;
        return 'x';
      });

    await assert.rejects(attempt(), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs === 10_000);
    clock.advance(4000);
    await assert.rejects(attempt(), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs === 6000);
    clock.advance(5999);
    await assert.rejects(attempt(), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs === 1);
    assert.equal(called, 0);
    assert.equal(breaker.state, 'open');
  });

  it('chamadas recusadas com o circuito aberto não renovam o prazo', async () => {
    const { breaker, clock, fail } = setup(1, 10_000);
    await fail();
    for (let i = 0; i < 9; i += 1) {
      clock.advance(1000);
      await assert.rejects(breaker.exec(boom()), CircuitOpenError);
    }
    clock.advance(1000);
    assert.equal(breaker.state, 'half_open');
  });

  it('open -> half_open quando openMs passa', async () => {
    const { breaker, clock, changes, fail } = setup(1, 10_000);
    await fail();
    clock.advance(9999);
    assert.equal(breaker.state, 'open');
    clock.advance(1);
    assert.equal(breaker.state, 'half_open');
    assert.deepEqual(changes, ['open', 'half_open']);
    // Ler o estado várias vezes não gera novas notificações.
    assert.equal(breaker.state, 'half_open');
    assert.deepEqual(changes, ['open', 'half_open']);
  });

  it('half_open -> closed quando a chamada de teste dá certo', async () => {
    const { breaker, clock, changes, fail, succeed } = setup(1, 10_000);
    await fail();
    clock.advance(10_000);
    assert.equal(await succeed(), 'ok');
    assert.equal(breaker.state, 'closed');
    assert.deepEqual(changes, ['open', 'half_open', 'closed']);
    // De volta ao normal: várias chamadas passam.
    assert.deepEqual(await Promise.all([succeed(), succeed(), succeed()]), ['ok', 'ok', 'ok']);
  });

  it('half_open -> open quando a chamada de teste falha, com prazo novo', async () => {
    const { breaker, clock, changes, fail } = setup(3, 10_000);
    await fail();
    await fail();
    await fail();
    clock.advance(10_000);
    // Uma única falha reabre, independentemente do limite de 3.
    await fail('ainda fora');
    assert.equal(breaker.state, 'open');
    assert.deepEqual(changes, ['open', 'half_open', 'open']);
    await assert.rejects(breaker.exec(boom()), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs === 10_000);
    clock.advance(9999);
    assert.equal(breaker.state, 'open');
    clock.advance(1);
    assert.equal(breaker.state, 'half_open');
  });

  it('half_open deixa passar exatamente UMA chamada de teste', async () => {
    const { breaker, clock, fail } = setup(1, 10_000);
    await fail();
    clock.advance(10_000);

    const trial = deferred<string>();
    let trialCalls = 0;
    const first = breaker.exec(() => {
      trialCalls += 1;
      return trial.promise;
    });

    let concurrentCalls = 0;
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        breaker.exec(async () => {
          concurrentCalls += 1;
          return 'não deveria rodar';
        }),
        (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs > 0,
      );
    }
    assert.equal(concurrentCalls, 0);
    assert.equal(trialCalls, 1);
    assert.equal(breaker.state, 'half_open');

    trial.resolve('voltou');
    assert.equal(await first, 'voltou');
    assert.equal(breaker.state, 'closed');
  });

  it('depois de fechar, a contagem de falhas recomeça do zero', async () => {
    const { breaker, clock, fail, succeed } = setup(3, 1000);
    await fail();
    await fail();
    await fail();
    clock.advance(1000);
    await succeed();
    await fail();
    await fail();
    assert.equal(breaker.state, 'closed');
    await fail();
    assert.equal(breaker.state, 'open');
  });

  it('ciclo completo de transições', async () => {
    const { breaker, clock, changes, fail, succeed } = setup(2, 5000);
    await fail();
    await fail(); // closed -> open
    clock.advance(5000); // open -> half_open (na próxima chamada)
    await fail(); // half_open -> open
    clock.advance(5000);
    await succeed(); // open -> half_open -> closed
    await fail();
    await fail(); // closed -> open
    assert.deepEqual(changes, ['open', 'half_open', 'open', 'half_open', 'closed', 'open']);
    assert.equal(breaker.state, 'open');
  });

  it('erros que isFailure descarta não contam e são relançados', async () => {
    const { breaker, changes } = setup(2);
    const validation = new Error('validação do destino');
    const isFailure = (err: unknown): boolean => err !== validation;
    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(breaker.exec(() => Promise.reject(validation), isFailure), (err: unknown) => err === validation);
    }
    assert.equal(breaker.state, 'closed');
    assert.deepEqual(changes, []);
  });

  it('erro descartado é neutro: não zera a sequência de falhas', async () => {
    const { breaker, fail } = setup(2);
    await fail();
    await assert.rejects(breaker.exec(boom('neutro'), () => false));
    await fail();
    assert.equal(breaker.state, 'open');
  });

  it('erro descartado na chamada de teste mantém half_open e libera a vaga', async () => {
    const { breaker, clock, changes, fail, succeed } = setup(1, 1000);
    await fail();
    clock.advance(1000);
    await assert.rejects(breaker.exec(boom('neutro'), () => false), /neutro/);
    assert.equal(breaker.state, 'half_open');
    // A próxima chamada é o novo teste.
    assert.equal(await succeed(), 'ok');
    assert.equal(breaker.state, 'closed');
    assert.deepEqual(changes, ['open', 'half_open', 'closed']);
  });

  it('isFailure que lança conta como falha', async () => {
    const { breaker } = setup(1);
    await assert.rejects(
      breaker.exec(boom('original'), () => {
        throw new Error('classificador quebrado');
      }),
      /original/,
    );
    assert.equal(breaker.state, 'open');
  });

  it('resultado atrasado de antes da abertura não fecha o circuito', async () => {
    const { breaker, fail } = setup(2);
    const slow = deferred<string>();
    const early = breaker.exec(() => slow.promise);
    await fail();
    await fail();
    assert.equal(breaker.state, 'open');
    slow.resolve('atrasado');
    assert.equal(await early, 'atrasado');
    assert.equal(breaker.state, 'open');
  });

  it('falha atrasada não interfere na chamada de teste nem na contagem nova', async () => {
    const { breaker, clock, changes, fail, succeed } = setup(2, 1000);
    const slow = deferred<string>();
    const early = breaker.exec(() => slow.promise);
    await fail();
    await fail();
    clock.advance(1000);
    assert.equal(breaker.state, 'half_open');

    slow.reject(new Error('atrasada'));
    await assert.rejects(early, /atrasada/);
    assert.equal(breaker.state, 'half_open', 'a falha atrasada não é a chamada de teste');

    await succeed();
    assert.equal(breaker.state, 'closed');
    await fail();
    assert.equal(breaker.state, 'closed', 'a contagem nova tem só 1 falha');
    assert.deepEqual(changes, ['open', 'half_open', 'closed']);
  });

  it('falhas concorrentes além do limite abrem uma única vez', async () => {
    const { breaker, changes } = setup(2);
    const pending = Array.from({ length: 6 }, () => deferred<string>());
    const calls = pending.map((d) => breaker.exec(() => d.promise));
    pending.forEach((d, i) => d.reject(new Error(`f${i}`)));
    await Promise.allSettled(calls);
    assert.equal(breaker.state, 'open');
    assert.deepEqual(changes, ['open']);
  });

  it('trata fn que lança de forma síncrona', async () => {
    const { breaker } = setup(1);
    const fn = (() => {
      throw new Error('síncrono');
    }) as unknown as () => Promise<string>;
    await assert.rejects(breaker.exec(fn), /síncrono/);
    assert.equal(breaker.state, 'open');
  });

  it('uma falha em onStateChange não derruba a chamada', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openMs: 1000,
      clock,
      onStateChange: () => {
        throw new Error('observador quebrado');
      },
    });
    await assert.rejects(breaker.exec(boom('original')), /original/);
    assert.equal(breaker.state, 'open');
    clock.advance(1000);
    assert.equal(await breaker.exec(async () => 'ok'), 'ok');
    assert.equal(breaker.state, 'closed');
  });

  it('relógio que volta no tempo não prende o circuito aberto além de openMs', async () => {
    const { breaker, clock, fail } = setup(1, 10_000);
    clock.set('2026-06-01T12:00:00.000Z');
    await fail();
    clock.set('2026-06-01T11:00:00.000Z');
    await assert.rejects(breaker.exec(boom()), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs === 10_000);
    clock.advance(10_000);
    assert.equal(breaker.state, 'half_open');
  });

  it('usa o relógio do sistema e limites mínimos quando as opções são estranhas', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 0, openMs: 60_000 });
    await assert.rejects(breaker.exec(boom()));
    assert.equal(breaker.state, 'open', 'failureThreshold mínimo é 1');
    await assert.rejects(breaker.exec(boom()), (err: unknown) => err instanceof CircuitOpenError && err.retryAfterMs > 59_000);
  });
});

// ---------------------------------------------------------------------------

describe('createBreakerRegistry', () => {
  it('devolve sempre o mesmo circuito para a mesma chave', () => {
    const registry = createBreakerRegistry({ failureThreshold: 1, openMs: 1000, clock: fakeClock() });
    assert.equal(registry.get('st_1'), registry.get('st_1'));
    assert.notEqual(registry.get('st_1'), registry.get('st_2'));
    assert.ok(registry.get('st_1') instanceof CircuitBreaker);
  });

  it('circuitos são independentes: uma loja fora do ar não afeta a outra', async () => {
    const clock = fakeClock();
    const changes: Array<[string, BreakerState]> = [];
    const registry = createBreakerRegistry({
      failureThreshold: 2,
      openMs: 1000,
      clock,
      onStateChange: (key, state) => void changes.push([key, state]),
    });
    await assert.rejects(registry.get('st_a').exec(boom()));
    await assert.rejects(registry.get('st_a').exec(boom()));
    assert.equal(registry.get('st_a').state, 'open');
    assert.equal(registry.get('st_b').state, 'closed');
    assert.equal(await registry.get('st_b').exec(async () => 'ok'), 'ok');
    await assert.rejects(registry.get('st_a').exec(async () => 'x'), CircuitOpenError);

    clock.advance(1000);
    assert.equal(await registry.get('st_a').exec(async () => 'voltou'), 'voltou');
    assert.deepEqual(changes, [
      ['st_a', 'open'],
      ['st_a', 'half_open'],
      ['st_a', 'closed'],
    ]);
  });

  it('funciona sem onStateChange e sem relógio', async () => {
    const registry = createBreakerRegistry({ failureThreshold: 1, openMs: 60_000 });
    await assert.rejects(registry.get('k').exec(boom()));
    assert.equal(registry.get('k').state, 'open');
  });

  it('não cresce sem limite e preserva circuitos abertos ao descartar', async () => {
    const registry = createBreakerRegistry({ failureThreshold: 1, openMs: 60_000, clock: fakeClock() });
    const open = registry.get('aberto');
    await assert.rejects(open.exec(boom()));
    const firstClosed = registry.get('k-0');
    for (let i = 1; i < 3000; i += 1) registry.get(`k-${i}`);
    assert.equal(registry.get('aberto'), open, 'o circuito aberto não foi descartado');
    assert.equal(registry.get('aberto').state, 'open');
    // O fechado mais antigo saiu para dar lugar: pedir a chave de novo cria outro circuito.
    assert.notEqual(registry.get('k-0'), firstClosed);
  });
});
