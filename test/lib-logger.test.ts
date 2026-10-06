import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../src/config.ts';
import { createLogger, REDACT_CENSOR, REDACT_PATHS, SENSITIVE_KEYS } from '../src/lib/logger.ts';

/** Logger escrevendo em memória, para inspecionar exatamente o que sairia no stdout. */
function capture(level: Config['logLevel'] = 'trace') {
  const lines: string[] = [];
  const logger = createLogger({ level, env: 'test', destination: { write: (line) => void lines.push(line) } });
  return {
    logger,
    lines,
    raw: () => lines.join(''),
    last: (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>,
  };
}

/** Chaves que o contrato exige, no mínimo. */
const REQUIRED_KEYS = [
  'clientSecret',
  'client_secret',
  'accessToken',
  'access_token',
  'storefrontToken',
  'token',
  'password',
  'adminPassword',
  'secret',
  'authorization',
  'cookie',
  'x-shopify-access-token',
  'set-cookie',
];

describe('createLogger', () => {
  it('emite uma linha JSON com os campos base', () => {
    const { logger, lines, last } = capture();
    logger.info({ shop: 'a.myshopify.com' }, 'olá');
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.endsWith('\n'));
    const entry = last();
    assert.equal(entry.service, 'checkout-bridge');
    assert.equal(entry.msg, 'olá');
    assert.equal(entry.shop, 'a.myshopify.com');
    assert.equal(entry.level, 'info');
    assert.equal(entry.pid, undefined);
    assert.equal(entry.hostname, undefined);
  });

  it('usa timestamp ISO 8601 em UTC', () => {
    const { logger, last } = capture();
    logger.warn('x');
    const time = last().time;
    assert.equal(typeof time, 'string');
    assert.match(time as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(time as string)));
  });

  it('respeita o nível configurado', () => {
    const warn = capture('warn');
    warn.logger.debug('a');
    warn.logger.info('b');
    warn.logger.warn('c');
    warn.logger.error('d');
    assert.deepEqual(
      warn.lines.map((line) => (JSON.parse(line) as { level: string }).level),
      ['warn', 'error'],
    );

    const silent = capture('silent');
    silent.logger.fatal({ token: 'x' }, 'nada');
    assert.equal(silent.lines.length, 0);
  });

  it('funciona sem destino explícito', () => {
    assert.doesNotThrow(() => createLogger({ level: 'silent', env: 'production' }).info('x'));
  });
});

describe('censura de segredos', () => {
  it('REDACT_PATHS cobre cada chave exigida na raiz e a um e dois níveis', () => {
    for (const key of REQUIRED_KEYS) {
      assert.ok(SENSITIVE_KEYS.includes(key), `SENSITIVE_KEYS sem ${key}`);
      const simple = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
      const expected = simple
        ? [key, `*.${key}`, `*.*.${key}`]
        : [`["${key}"]`, `*["${key}"]`, `*.*["${key}"]`];
      for (const path of expected) {
        assert.ok(REDACT_PATHS.includes(path), `REDACT_PATHS sem ${path}`);
      }
    }
    assert.equal(new Set(REDACT_PATHS).size, REDACT_PATHS.length, 'caminhos duplicados');
  });

  it('censura cada chave sensível na raiz, a um nível e a dois níveis', () => {
    for (const key of SENSITIVE_KEYS) {
      const { logger, raw, last } = capture();
      const secret = `SEGREDO-${key}-9f3a`;
      logger.info({ [key]: `${secret}-0`, a: { [key]: `${secret}-1`, b: { [key]: `${secret}-2` } } }, 'teste');
      assert.ok(!raw().includes('SEGREDO-'), `vazou ${key}: ${raw()}`);
      const entry = last() as { a: { b: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;
      assert.equal(entry[key], REDACT_CENSOR);
      assert.equal(entry.a[key], REDACT_CENSOR);
      assert.equal(entry.a.b[key], REDACT_CENSOR);
    }
  });

  it('censura dentro de arrays', () => {
    const { logger, raw } = capture();
    logger.info({ stores: [{ name: 'A', clientSecret: 'SEGREDO-1' }, { name: 'B', clientSecret: 'SEGREDO-2' }] }, 'lista');
    assert.ok(!raw().includes('SEGREDO-'));
    assert.ok(raw().includes('"name":"A"'));
  });

  it('censura cabeçalhos de requisição e resposta nas duas grafias', () => {
    const { logger, raw, last } = capture();
    logger.info(
      {
        req: {
          method: 'POST',
          headers: {
            authorization: 'Bearer SEGREDO-a',
            cookie: 'sid=SEGREDO-b',
            'x-shopify-access-token': 'shpat_SEGREDO-c',
            'user-agent': 'navegador',
          },
        },
        res: { headers: { 'set-cookie': ['sid=SEGREDO-d; HttpOnly'], 'content-type': 'text/html' } },
        outgoing: {
          Authorization: 'Bearer SEGREDO-e',
          'X-Shopify-Access-Token': 'SEGREDO-f',
          'Shopify-Storefront-Private-Token': 'SEGREDO-g',
        },
      },
      'http',
    );
    assert.ok(!raw().includes('SEGREDO-'), raw());
    const entry = last() as { req: { method: string; headers: Record<string, unknown> }; res: { headers: Record<string, unknown> } };
    assert.equal(entry.req.method, 'POST');
    assert.equal(entry.req.headers['user-agent'], 'navegador');
    assert.equal(entry.req.headers.authorization, REDACT_CENSOR);
    assert.equal(entry.res.headers['set-cookie'], REDACT_CENSOR);
    assert.equal(entry.res.headers['content-type'], 'text/html');
  });

  it('censura um objeto de configuração logado por engano', () => {
    const { logger, raw } = capture();
    logger.info(
      {
        config: {
          port: 8787,
          adminPassword: 'SEGREDO-senha',
          encryptionKey: Buffer.from('SEGREDO-chave-de-32-bytes-000000'),
          metricsToken: 'SEGREDO-metricas',
          alertWebhookUrl: 'https://hooks.example/SEGREDO-webhook',
        },
      },
      'configuração carregada',
    );
    assert.ok(!raw().includes('SEGREDO-'), raw());
    // Um Buffer não censurado apareceria como {"type":"Buffer","data":[...]}.
    assert.ok(!raw().includes('"type":"Buffer"'), raw());
    assert.ok(raw().includes('"port":8787'));
  });

  it('censura o IP do comprador em claro', () => {
    const { logger, raw } = capture();
    logger.info({ ctx: { requestId: 'req_1', buyerIp: '203.0.113.77' } }, 'contexto');
    assert.ok(!raw().includes('203.0.113.77'));
    assert.ok(raw().includes('req_1'));
  });

  it('censura bindings de logger filho', () => {
    const { logger, raw } = capture();
    logger.child({ token: 'SEGREDO-filho', store: { clientSecret: 'SEGREDO-filho-2' }, requestId: 'req_9' }).info('filho');
    assert.ok(!raw().includes('SEGREDO-'), raw());
    assert.ok(raw().includes('req_9'));
  });

  it('censura propriedades de erros', () => {
    const { logger, raw, last } = capture();
    const err = Object.assign(new Error('falhou'), {
      token: 'SEGREDO-erro',
      details: { clientSecret: 'SEGREDO-erro-2', code: 'x1' },
    });
    logger.error({ err }, 'erro');
    assert.ok(!raw().includes('SEGREDO-'), raw());
    const entry = last() as { err: { message: string; details: { code: string } } };
    assert.equal(entry.err.message, 'falhou');
    assert.equal(entry.err.details.code, 'x1');
  });

  it('não altera o objeto original', () => {
    const { logger } = capture();
    const input = { clientSecret: 'valor-real', store: { token: 'outro-valor', nested: { password: 'p' } } };
    logger.info(input, 'x');
    logger.info({ input }, 'y');
    assert.deepEqual(input, { clientSecret: 'valor-real', store: { token: 'outro-valor', nested: { password: 'p' } } });
  });

  it('preserva campos que apenas se parecem com os sensíveis', () => {
    const { logger, last } = capture();
    logger.info({ cartToken: 'c1', tokenCount: 3, hasStorefrontToken: true, clientId: 'id-publico' }, 'x');
    const entry = last();
    assert.equal(entry.cartToken, 'c1');
    assert.equal(entry.tokenCount, 3);
    assert.equal(entry.hasStorefrontToken, true);
    assert.equal(entry.clientId, 'id-publico');
  });

  it('lida com valores não textuais nas chaves sensíveis', () => {
    const { logger, raw, last } = capture();
    logger.info({ token: null, password: 12345, secret: { inner: 'SEGREDO-x' }, a: { token: ['SEGREDO-y'] } }, 'x');
    assert.ok(!raw().includes('SEGREDO-'));
    assert.ok(!raw().includes('12345'));
    assert.equal(last().password, REDACT_CENSOR);
  });
});
