import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createAlerter } from '../src/lib/alerts.ts';
import { fakeClock } from '../src/lib/clock.ts';
import { createLogger } from '../src/lib/logger.ts';
import type { Alert, Logger } from '../src/types.ts';

const WEBHOOK_URL = 'https://hooks.example.test/services/T000/B000/SEGREDO-do-webhook';

type Level = 'debug' | 'info' | 'warn' | 'error';
interface LogEntry {
  level: Level;
  fields: Record<string, unknown>;
  msg: string;
}

/** Logger mínimo que só registra as chamadas. */
function fakeLogger() {
  const entries: LogEntry[] = [];
  const at =
    (level: Level) =>
    (first: unknown, second?: unknown): void => {
      if (typeof first === 'string') entries.push({ level, fields: {}, msg: first });
      else entries.push({ level, fields: first as Record<string, unknown>, msg: String(second ?? '') });
    };
  const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } as unknown as Logger;
  return { logger, entries, levels: () => entries.map((entry) => entry.level) };
}

interface WebhookCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** fetch falso do webhook; por padrão responde 200. */
function fakeWebhook(respond: () => Response | Promise<Response> = () => new Response('ok')) {
  const calls: WebhookCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** O envio é em segundo plano; isto deixa as promessas pendentes terminarem. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  key: 'store_down:st_1',
  severity: 'critical',
  title: 'Loja checkout indisponível',
  detail: { storeId: 'st_1' },
  ...overrides,
});

describe('registro em log', () => {
  it('usa o nível de log correspondente à severidade', () => {
    const { logger, entries } = fakeLogger();
    const alerter = createAlerter({ webhookUrl: null, logger, clock: fakeClock() });
    alerter.notify(alert({ key: 'a', severity: 'info', title: 'informativo' }));
    alerter.notify(alert({ key: 'b', severity: 'warning', title: 'atenção' }));
    alerter.notify(alert({ key: 'c', severity: 'critical', title: 'grave' }));
    assert.deepEqual(
      entries.map((entry) => [entry.level, entry.fields.alertKey, entry.fields.severity]),
      [
        ['info', 'a', 'info'],
        ['warn', 'b', 'warning'],
        ['error', 'c', 'critical'],
      ],
    );
    assert.ok(entries[0]?.msg.includes('informativo'));
    assert.deepEqual(entries[2]?.fields.detail, { storeId: 'st_1' });
  });

  it('sem webhook configurado não faz nenhuma chamada de rede', async () => {
    const { logger, entries } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: null, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(entries.length, 1);
  });

  it('notify devolve undefined (não uma promessa)', () => {
    const { logger } = fakeLogger();
    const { fetchImpl } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    assert.equal(alerter.notify(alert()), undefined);
  });
});

describe('envio ao webhook', () => {
  it('faz POST JSON com os campos combinados', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const clock = fakeClock('2026-03-04T05:06:07.890Z');
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock });
    alerter.notify(alert({ detail: { storeId: 'st_1', attempts: 3 } }));
    await settle();

    assert.equal(calls.length, 1);
    const call = calls[0] as WebhookCall;
    assert.equal(call.url, WEBHOOK_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(new Headers(call.init.headers).get('content-type'), 'application/json');
    assert.deepEqual(Object.keys(call.body).sort(), ['at', 'content', 'detail', 'key', 'severity', 'text', 'title']);
    assert.equal(call.body.key, 'store_down:st_1');
    assert.equal(call.body.severity, 'critical');
    assert.equal(call.body.title, 'Loja checkout indisponível');
    assert.deepEqual(call.body.detail, { storeId: 'st_1', attempts: 3 });
    assert.equal(call.body.at, '2026-03-04T05:06:07.890Z');
  });

  it('text e content levam o mesmo resumo de uma linha', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert({ title: 'Linha um\nlinha dois\r\n  linha três', detail: { nota: 'a\nb' } }));
    await settle();
    const body = calls[0]?.body as { text: string; content: string; title: string };
    assert.equal(body.text, body.content);
    assert.ok(!/[\r\n]/.test(body.text), 'resumo em uma linha');
    assert.ok(body.text.includes('Linha um linha dois linha três'));
    assert.ok(body.text.includes('store_down:st_1'));
    assert.ok(body.text.includes('CRÍTICO'));
    assert.ok(body.text.length < 1800, 'cabe no limite de mensagem do Discord');
    assert.equal(body.title, 'Linha um linha dois linha três');
  });

  it('funciona sem detail', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify({ key: 'k', severity: 'info', title: 'sem detalhe' });
    await settle();
    assert.deepEqual(calls[0]?.body.detail, {});
    assert.equal(calls[0]?.body.text, '[checkout-bridge] INFO: sem detalhe (k)');
  });

  it('censura chaves sensíveis do detalhe antes de sair do processo', async () => {
    const { logger, entries } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(
      alert({
        detail: {
          storeId: 'st_1',
          clientSecret: 'VAZOU-1',
          nested: { deep: { deeper: { accessToken: 'VAZOU-2', Authorization: 'Bearer VAZOU-3' } } },
          list: [{ password: 'VAZOU-4' }],
          count: 10n,
          err: new Error('motivo'),
        },
      }),
    );
    await settle();
    const sent = String(calls[0]?.init.body);
    assert.ok(!sent.includes('VAZOU-'), sent);
    assert.ok(sent.includes('st_1'));
    assert.ok(sent.includes('"count":"10"'));
    assert.ok(sent.includes('motivo'));
    assert.ok(!JSON.stringify(entries).includes('VAZOU-'));
  });

  it('limita o tamanho do detalhe', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert({ detail: { blob: 'x'.repeat(200_000) } }));
    await settle();
    assert.ok(String(calls[0]?.init.body).length < 10_000);
    assert.equal((calls[0]?.body.detail as { truncated?: boolean }).truncated, true);
  });
});

describe('intervalo mínimo por chave', () => {
  it('suprime repetições dentro do intervalo: log em debug e nada enviado', async () => {
    const { logger, levels } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const clock = fakeClock();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock, cooldownMs: 60_000 });

    alerter.notify(alert());
    clock.advance(1);
    alerter.notify(alert());
    clock.advance(59_998);
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(levels(), ['error', 'debug', 'debug']);

    // Exatamente no fim do intervalo o alerta volta a ser emitido.
    clock.advance(1);
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 2);
    assert.deepEqual(levels(), ['error', 'debug', 'debug', 'error']);
  });

  it('o intervalo conta a partir do último alerta emitido, não do último suprimido', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const clock = fakeClock();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock, cooldownMs: 10_000 });
    alerter.notify(alert());
    for (let i = 0; i < 9; i += 1) {
      clock.advance(1000);
      alerter.notify(alert());
    }
    clock.advance(1000);
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 2, 'um problema contínuo ainda alerta uma vez por intervalo');
  });

  it('chaves diferentes não se suprimem', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert({ key: 'store_down:st_1' }));
    alerter.notify(alert({ key: 'store_down:st_2' }));
    alerter.notify(alert({ key: 'store_down:st_1' }));
    await settle();
    assert.deepEqual(calls.map((call) => call.body.key), ['store_down:st_1', 'store_down:st_2']);
  });

  it('o padrão é de 5 minutos', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const clock = fakeClock();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock });
    alerter.notify(alert());
    clock.advance(299_999);
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 1);
    clock.advance(1);
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 2);
  });

  it('vale também sem webhook', () => {
    const { logger, levels } = fakeLogger();
    const alerter = createAlerter({ webhookUrl: null, logger, clock: fakeClock() });
    alerter.notify(alert({ severity: 'warning' }));
    alerter.notify(alert({ severity: 'warning' }));
    assert.deepEqual(levels(), ['warn', 'debug']);
  });

  it('cooldownMs = 0 desliga a supressão', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock(), cooldownMs: 0 });
    alerter.notify(alert());
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 2);
  });

  it('o mapa de deduplicação tem tamanho limitado (5000 chaves)', () => {
    const { logger, entries } = fakeLogger();
    const alerter = createAlerter({ webhookUrl: null, logger, clock: fakeClock(), cooldownMs: 3_600_000 });
    for (let i = 0; i <= 5000; i += 1) alerter.notify(alert({ key: `k-${i}`, severity: 'info' }));
    entries.length = 0;

    // A chave mais antiga foi descartada para caber a 5001ª: volta a alertar.
    alerter.notify(alert({ key: 'k-0', severity: 'info' }));
    // Uma chave recente continua lembrada.
    alerter.notify(alert({ key: 'k-5000', severity: 'info' }));
    assert.deepEqual(entries.map((entry) => entry.level), ['info', 'debug']);
  });

  it('entradas vencidas são descartadas antes das ainda válidas', () => {
    const { logger, entries } = fakeLogger();
    const clock = fakeClock();
    const alerter = createAlerter({ webhookUrl: null, logger, clock, cooldownMs: 1000 });
    alerter.notify(alert({ key: 'antiga', severity: 'info' }));
    clock.advance(500);
    for (let i = 0; i < 4999; i += 1) alerter.notify(alert({ key: `k-${i}`, severity: 'info' }));
    clock.advance(600);
    // "antiga" venceu; as outras 4999 ainda valem e nenhuma precisa sair.
    alerter.notify(alert({ key: 'nova', severity: 'info' }));
    entries.length = 0;
    alerter.notify(alert({ key: 'k-0', severity: 'info' }));
    alerter.notify(alert({ key: 'k-4998', severity: 'info' }));
    assert.deepEqual(entries.map((entry) => entry.level), ['debug', 'debug']);
  });
});

describe('falhas do webhook', () => {
  afterEach(() => mock.timers.reset());

  /** Logger real escrevendo em memória: o que importa é o texto final que iria para o log. */
  function realLogger() {
    const lines: string[] = [];
    const logger = createLogger({ level: 'trace', env: 'test', destination: { write: (line) => void lines.push(line) } });
    return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
  }

  function assertNoUrl(lines: string[]): void {
    const text = lines.join('');
    assert.ok(!text.includes('SEGREDO-do-webhook'), text);
    assert.ok(!text.includes('hooks.example.test'), text);
  }

  it('falha de rede: log em warn, sem a URL, e notify não lança', async () => {
    const { logger, lines, parsed } = realLogger();
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(`getaddrinfo ENOTFOUND hooks.example.test`), { code: 'ENOTFOUND' }),
      });
    }) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    assert.doesNotThrow(() => alerter.notify(alert()));
    await settle();

    const entries = parsed();
    assert.deepEqual(entries.map((entry) => entry.level), ['error', 'warn']);
    assert.equal(entries[1]?.alertKey, 'store_down:st_1');
    assert.equal(entries[1]?.reason, 'TypeError (ENOTFOUND)');
    assertNoUrl(lines);
  });

  it('erro cuja mensagem contém a URL não vaza para o log', async () => {
    const { logger, lines, parsed } = realLogger();
    const fetchImpl = (async () => {
      throw new TypeError(`Failed to parse URL from ${WEBHOOK_URL}`);
    }) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert());
    await settle();
    assert.equal(parsed().at(-1)?.level, 'warn');
    assertNoUrl(lines);
  });

  it('resposta de erro HTTP: log em warn com o status', async () => {
    const { logger, lines, parsed } = realLogger();
    const { fetchImpl, calls } = fakeWebhook(() => new Response(`no such hook ${WEBHOOK_URL}`, { status: 404 }));
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert());
    await settle();
    assert.equal(calls.length, 1);
    const last = parsed().at(-1);
    assert.equal(last?.level, 'warn');
    assert.equal(last?.status, 404);
    assertNoUrl(lines);
  });

  it('respostas 2xx não geram aviso', async () => {
    for (const status of [200, 204]) {
      const { logger, parsed } = realLogger();
      const { fetchImpl } = fakeWebhook(() => new Response(null, { status }));
      const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
      alerter.notify(alert({ severity: 'info' }));
      await settle();
      assert.deepEqual(parsed().map((entry) => entry.level), ['info'], `status ${status}`);
    }
  });

  it('webhook que não responde: desiste no tempo limite (padrão de 3 s)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { logger, lines, parsed } = realLogger();
    let aborted = false;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert());
    await settle();
    mock.timers.tick(2999);
    await settle();
    assert.equal(parsed().length, 1, 'ainda esperando');
    mock.timers.tick(1);
    await settle();
    const last = parsed().at(-1);
    assert.equal(last?.level, 'warn');
    assert.equal(last?.reason, 'timeout');
    assert.equal(aborted, true);
    assertNoUrl(lines);
  });

  it('respeita timeoutMs', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { logger, parsed } = realLogger();
    const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock(), timeoutMs: 250 });
    alerter.notify(alert());
    await settle();
    mock.timers.tick(250);
    await settle();
    assert.equal(parsed().at(-1)?.reason, 'timeout');
  });

  it('fetch que lança de forma síncrona não escapa de notify', async () => {
    const { logger, lines, parsed } = realLogger();
    const fetchImpl = (() => {
      throw new Error(`boom ${WEBHOOK_URL}`);
    }) as unknown as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    assert.doesNotThrow(() => alerter.notify(alert()));
    await settle();
    assert.equal(parsed().at(-1)?.level, 'warn');
    assertNoUrl(lines);
  });

  it('a falha de envio não libera o intervalo (sem rajada de tentativas)', async () => {
    const { logger } = fakeLogger();
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    for (let i = 0; i < 50; i += 1) alerter.notify(alert());
    await settle();
    assert.equal(attempts, 1);
  });

  it('limita os envios simultâneos quando o webhook está travado', async () => {
    const { logger, entries } = fakeLogger();
    let started = 0;
    const fetchImpl = (() => {
      started += 1;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    // Tempo limite longo e nunca atingido: os envios ficam pendurados durante o teste.
    mock.timers.enable({ apis: ['setTimeout'] });
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    for (let i = 0; i < 30; i += 1) alerter.notify(alert({ key: `k-${i}`, severity: 'info' }));
    await settle();
    assert.equal(started, 20);
    assert.equal(entries.filter((entry) => entry.level === 'info').length, 30, 'todos foram para o log');
    assert.equal(entries.filter((entry) => entry.level === 'warn').length, 10);
  });

  it('logger que lança não faz notify lançar', async () => {
    const broken = {
      debug: () => {
        throw new Error('log quebrado');
      },
      info: () => {
        throw new Error('log quebrado');
      },
      warn: () => {
        throw new Error('log quebrado');
      },
      error: () => {
        throw new Error('log quebrado');
      },
    } as unknown as Logger;
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger: broken, fetchImpl, clock: fakeClock() });
    assert.doesNotThrow(() => alerter.notify(alert()));
    assert.doesNotThrow(() => alerter.notify(alert()));
    await settle();
  });

  it('alerta malformado não faz notify lançar', async () => {
    const { logger } = fakeLogger();
    const { fetchImpl } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock(), cooldownMs: 0 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const malformed = [
      null,
      undefined,
      {},
      { key: null, severity: 'desconhecida', title: undefined },
      { key: 'k', severity: 'info', title: 't', detail: circular },
      { key: 'k', severity: 'info', title: 't', detail: 'texto' },
    ];
    for (const value of malformed) {
      assert.doesNotThrow(() => alerter.notify(value as unknown as Alert));
    }
    await settle();
  });
});

describe('URL do webhook', () => {
  it('URL inválida: avisa uma vez, sem expor o valor, e segue só com o log', async () => {
    for (const badUrl of ['isto não é uma URL SEGREDO-x', 'file:///etc/SEGREDO-x', 'javascript:SEGREDO-x']) {
      const { logger, entries } = fakeLogger();
      const { fetchImpl, calls } = fakeWebhook();
      const alerter = createAlerter({ webhookUrl: badUrl, logger, fetchImpl, clock: fakeClock() });
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.level, 'warn');
      alerter.notify(alert());
      await settle();
      assert.equal(calls.length, 0);
      assert.deepEqual(entries.map((entry) => entry.level), ['warn', 'error']);
      assert.ok(!JSON.stringify(entries).includes('SEGREDO-x'));
    }
  });

  it('a URL não aparece no log nem no corpo enviado em um envio normal', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'trace', env: 'test', destination: { write: (line) => void lines.push(line) } });
    const { fetchImpl, calls } = fakeWebhook();
    const alerter = createAlerter({ webhookUrl: WEBHOOK_URL, logger, fetchImpl, clock: fakeClock() });
    alerter.notify(alert());
    alerter.notify(alert());
    await settle();
    assert.ok(!lines.join('').includes('SEGREDO-do-webhook'));
    assert.ok(!String(calls[0]?.init.body).includes('SEGREDO-do-webhook'));
    assert.equal(lines.length, 2);
  });
});
