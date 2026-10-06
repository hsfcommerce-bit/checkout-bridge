import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Partida do processo de verdade (src/server.ts), em processo filho: o comando do
 * `npm start` lê o .env do diretório atual, sobe e desliga limpo com SIGTERM; sem
 * variáveis o processo sai com código 1 e explica o que falta, sem imprimir valores.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'src', 'server.ts');
const VALID_KEY = Buffer.alloc(32, 2).toString('base64');
const PASSWORD = 'senha-propria-do-teste-de-partida';
const PROCESS_TIMEOUT_MS = 20_000;

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-boot-'));
  tempDirs.push(dir);
  return dir;
}

/** Porta livre: abre um servidor em 0, lê a porta e fecha. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('sem porta'));
      });
    });
  });
}

interface Run {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Executa o Node com `args` e devolve quando o processo sai. `onStdout` recebe o stdout
 * acumulado; devolver true manda SIGTERM (uma vez).
 */
function runNode(args: string[], opts: { cwd: string; onStdout?: (text: string) => boolean }): Promise<Run> {
  return new Promise((resolve, reject) => {
    // Ambiente mínimo: só o PATH, para o .env (ou a ausência dele) ser a única fonte das variáveis.
    const child = spawn(process.execPath, args, { cwd: opts.cwd, env: { PATH: process.env['PATH'] ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`processo não terminou em ${PROCESS_TIMEOUT_MS} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!signalled && opts.onStdout?.(stdout) === true) {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('partida do processo (src/server.ts)', () => {
  it('os comandos do npm leem o .env do diretório atual, se existir', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['start'] ?? '', /--env-file-if-exists=\.env/);
    assert.match(pkg.scripts['dev'] ?? '', /--env-file-if-exists=\.env/);
    // O Dockerfile não depende do .env (a imagem recebe as variáveis por --env-file ou pelo orquestrador).
    assert.match(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'), /CMD \["node", "src\/server\.ts"\]/);
  });

  it('com um .env preenchido no diretório atual, o comando do npm start sobe e desliga limpo com SIGTERM', async () => {
    const dir = tempDir();
    const port = await freePort();
    writeFileSync(
      join(dir, '.env'),
      [
        'NODE_ENV=development',
        'HOST=127.0.0.1',
        `PORT=${port}`,
        'PUBLIC_BASE_URL=http://127.0.0.1',
        'DATABASE_PATH=:memory:',
        `ENCRYPTION_KEY=${VALID_KEY}`,
        `ADMIN_PASSWORD=${PASSWORD}`,
        'CATALOG_RESYNC_MINUTES=0',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
    );
    const run = await runNode(['--env-file-if-exists=.env', SERVER], {
      cwd: dir,
      onStdout: (text) => text.includes('checkout-bridge no ar'),
    });
    assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.ok(run.stdout.includes(`"port":${port}`), run.stdout);
    assert.ok(run.stdout.includes('"desligado"'), run.stdout);
    // Nem a chave nem a senha aparecem na saída.
    assert.ok(!run.stdout.includes(VALID_KEY) && !run.stdout.includes(PASSWORD));
    assert.ok(!run.stderr.includes(VALID_KEY) && !run.stderr.includes(PASSWORD));
  });

  it('sem variáveis no ambiente (e sem o flag do .env) sai com código 1 listando o que falta, sem valores', async () => {
    const dir = tempDir();
    // O .env existe mas, sem o flag, não é lido: é exatamente o cenário que o npm start antigo produzia.
    writeFileSync(join(dir, '.env'), `PUBLIC_BASE_URL=https://ignorado.exemplo\nENCRYPTION_KEY=${VALID_KEY}\nADMIN_PASSWORD=${PASSWORD}\n`);
    const run = await runNode([SERVER], { cwd: dir });
    assert.equal(run.code, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stderr, /Configuração inválida/);
    for (const name of ['PUBLIC_BASE_URL', 'ENCRYPTION_KEY', 'ADMIN_PASSWORD']) assert.ok(run.stderr.includes(name), name);
    assert.ok(!run.stderr.includes(VALID_KEY) && !run.stderr.includes(PASSWORD));
  });
});
