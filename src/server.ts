import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';

/**
 * Ponto de entrada do processo: lê a configuração, monta a aplicação, liga o agendador e
 * escuta em HOST:PORT. Em SIGTERM/SIGINT para de aceitar conexões, para o agendador, espera
 * a fila de catálogo esvaziar (com teto) e fecha o banco.
 *
 * Erro de configuração imprime a mensagem (que não contém valores, só nomes de variáveis e
 * regras) e sai com código 1, sem rastro de pilha.
 */

/** Teto do desligamento gracioso; depois disso o processo sai mesmo com conexões abertas. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const instance = createApp({ config });
const { logger } = instance.deps;

const server = serve({ fetch: instance.app.fetch, hostname: config.host, port: config.port }, (info) => {
  // Linha única de partida, sem segredos: nada de chaves, senha ou URL de webhook de alertas.
  logger.info(
    {
      host: info.address,
      port: info.port,
      env: config.env,
      publicBaseUrl: config.publicBaseUrl,
      shopifyApiVersion: config.shopifyApiVersion,
      databasePath: config.databasePath,
      catalogResyncMinutes: config.catalogResyncMinutes,
    },
    'checkout-bridge no ar',
  );
});

// Porta ocupada (outra instância rodando) ou sem permissão: mensagem clara em vez de stack trace.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `A porta ${config.port} já está em uso em ${config.host}. Provavelmente outra instância do checkout-bridge está rodando ` +
        `(pare-a com Ctrl+C no terminal onde ela abriu) ou escolha outra porta com PORT=... no .env.\n`,
    );
  } else if (err.code === 'EACCES') {
    process.stderr.write(`Sem permissão para abrir a porta ${config.port}. Use uma porta acima de 1024 ou rode com privilégios.\n`);
  } else {
    process.stderr.write(`Falha ao abrir o servidor: ${err.message}\n`);
  }
  void instance.close().finally(() => process.exit(1));
});

instance.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'desligando');
  const forceExit = setTimeout(() => {
    logger.error('desligamento excedeu o tempo limite; saindo mesmo assim');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Para de aceitar conexões novas; as em andamento terminam.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await instance.close();
  logger.info('desligado');
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
