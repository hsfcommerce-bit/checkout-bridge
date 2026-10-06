import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { testConfig } from '../src/config.ts';
import { createLogger } from '../src/lib/logger.ts';

/**
 * Tratador de erro da aplicação (src/app.ts): a resposta é genérica, mas o log leva o
 * erro inteiro (nome, mensagem, pilha) e o requestId, senão uma exceção numa rota sem
 * onError próprio ficaria indiagnosticável.
 */

describe('erro não tratado na aplicação', () => {
  it('responde 500 genérico e loga mensagem, pilha e requestId', async () => {
    const logs: string[] = [];
    const logger = createLogger({
      level: 'error',
      env: 'test',
      destination: {
        write(chunk: string) {
          logs.push(chunk);
        },
      },
    });
    const instance = createApp({ config: testConfig(), logger });
    try {
      instance.app.get('/__boom', () => {
        throw new Error('kaboom-diagnostico');
      });
      const res = await instance.app.request('/__boom');
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal', message: 'Erro inesperado.' });

      const line = logs.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry['msg'] === 'erro não tratado');
      assert.ok(line !== undefined, `faltou a linha de log; linhas: ${logs.join('')}`);
      assert.equal(line['path'], '/__boom');
      assert.equal(line['errorName'], 'Error');
      assert.equal(line['requestId'], res.headers.get('x-request-id'));
      const err = line['err'] as Record<string, unknown>;
      assert.equal(err['message'], 'kaboom-diagnostico');
      assert.match(String(err['stack']), /app-errors\.test\.ts/);
    } finally {
      await instance.close();
    }
  });

  it('a censura por nome de campo continua valendo sobre o erro logado', async () => {
    const logs: string[] = [];
    const logger = createLogger({
      level: 'error',
      env: 'test',
      destination: {
        write(chunk: string) {
          logs.push(chunk);
        },
      },
    });
    const instance = createApp({ config: testConfig(), logger });
    try {
      instance.app.get('/__leak', () => {
        const err = new Error('falhou') as Error & { token: string };
        err.token = 'shpat_segredo';
        throw err;
      });
      const res = await instance.app.request('/__leak');
      assert.equal(res.status, 500);
      const text = logs.join('');
      assert.ok(text.includes('falhou'));
      assert.ok(!text.includes('shpat_segredo'), text);
    } finally {
      await instance.close();
    }
  });
});
