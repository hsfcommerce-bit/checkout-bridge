import { Hono } from 'hono';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { timingSafeEqualStr } from '../lib/crypto.ts';
import type { Metrics } from '../types.ts';

/**
 * Rotas de operação: vida, prontidão e métricas.
 *
 * /healthz responde sem tocar em nada (serve para o orquestrador saber que o processo
 * está de pé). /readyz confere o banco, que é a única dependência sem a qual nenhuma
 * requisição pode ser atendida. A Shopify fica de fora de propósito: uma loja fora do ar
 * não pode tirar o serviço inteiro do balanceador.
 */

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Token de "Authorization: Bearer <token>". O nome do esquema não diferencia maiúsculas. */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createHealthRoutes(deps: { db: Db; metrics: Metrics; config: Pick<Config, 'metricsToken'> }): Hono {
  const { db, metrics, config } = deps;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/readyz', (c) => {
    try {
      const row = db.get<{ ok: number }>('SELECT 1 AS ok');
      if (row !== undefined && Number(row.ok) === 1) return c.json({ ok: true });
    } catch {
      // O motivo não vai na resposta: esta rota é pública e a mensagem do SQLite pode
      // trazer o caminho do arquivo do banco.
    }
    return c.json({ ok: false }, 503);
  });

  app.get('/metrics', (c) => {
    const expected = config.metricsToken;
    // Sem token configurado a rota fica aberta; quem publica o serviço deve então
    // restringi-la na rede. Token vazio conta como "não configurado" (ver config.ts).
    if (expected !== null && expected !== '') {
      const received = bearerToken(c.req.header('authorization'));
      if (received === null || !timingSafeEqualStr(received, expected)) {
        c.header('WWW-Authenticate', 'Bearer');
        c.header('Cache-Control', 'no-store');
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    c.header('Content-Type', PROMETHEUS_CONTENT_TYPE);
    c.header('Cache-Control', 'no-store');
    return c.body(metrics.render());
  });

  return app;
}
