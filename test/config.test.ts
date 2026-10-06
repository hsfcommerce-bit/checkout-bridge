import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';

/**
 * loadConfig: o .env.example não pode subir sem edição, as senhas publicadas no
 * repositório são recusadas e TRUSTED_PROXY_HOPS tem os limites documentados.
 */

const ENV_EXAMPLE = new URL('../.env.example', import.meta.url);
const VALID_KEY = Buffer.alloc(32, 1).toString('base64');
const OWN_PASSWORD = 'uma-senha-propria-bem-longa';

/** Lê o .env.example como o Node faz com --env-file: linhas CHAVE=valor, comentários ignorados. */
function parseEnvExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function valid(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PUBLIC_BASE_URL: 'https://bridge.exemplo.com.br',
    ENCRYPTION_KEY: VALID_KEY,
    ADMIN_PASSWORD: OWN_PASSWORD,
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('o .env.example sem edição não sobe: as variáveis obrigatórias vêm vazias', () => {
    const env = parseEnvExample();
    assert.equal(env['ENCRYPTION_KEY'], '');
    assert.equal(env['ADMIN_PASSWORD'], '');
    assert.throws(
      () => loadConfig(env),
      (err: unknown) => err instanceof Error && /ENCRYPTION_KEY/.test(err.message) && /ADMIN_PASSWORD/.test(err.message),
    );
  });

  it('o .env.example só com a chave preenchida continua recusado por causa da senha', () => {
    const env = { ...parseEnvExample(), ENCRYPTION_KEY: VALID_KEY };
    assert.throws(() => loadConfig(env), /ADMIN_PASSWORD/);
    // Com a senha preenchida, o resto do arquivo é uma configuração válida de produção.
    const config = loadConfig({ ...env, ADMIN_PASSWORD: OWN_PASSWORD });
    assert.equal(config.env, 'production');
    assert.equal(config.trustedProxyHops, 1);
  });

  it('recusa as senhas publicadas no repositório, mesmo com tudo o mais válido', () => {
    for (const password of ['troque-por-uma-senha-longa', 'senha-de-teste-123']) {
      assert.throws(() => loadConfig(valid({ ADMIN_PASSWORD: password })), /ADMIN_PASSWORD[^\n]*exemplo/, password);
    }
    assert.throws(() => loadConfig(valid({ ADMIN_PASSWORD: 'curta' })), /12 caracteres/);
  });

  it('aceita uma senha própria de 12+ caracteres e aplica os padrões', () => {
    const config = loadConfig(valid());
    assert.equal(config.adminPassword, OWN_PASSWORD);
    assert.equal(config.encryptionKey.length, 32);
    assert.equal(config.env, 'development');
    assert.equal(config.trustedProxyHops, 1);
    assert.equal(config.catalogResyncMinutes, 360);
    assert.equal(config.retentionDays, 90);
  });

  it('TRUSTED_PROXY_HOPS aceita de 0 a 10', () => {
    assert.equal(loadConfig(valid({ TRUSTED_PROXY_HOPS: '0' })).trustedProxyHops, 0);
    assert.equal(loadConfig(valid({ TRUSTED_PROXY_HOPS: '2' })).trustedProxyHops, 2);
    assert.equal(loadConfig(valid({ TRUSTED_PROXY_HOPS: '' })).trustedProxyHops, 1);
    assert.throws(() => loadConfig(valid({ TRUSTED_PROXY_HOPS: '11' })), /TRUSTED_PROXY_HOPS/);
    assert.throws(() => loadConfig(valid({ TRUSTED_PROXY_HOPS: '-1' })), /TRUSTED_PROXY_HOPS/);
    assert.throws(() => loadConfig(valid({ TRUSTED_PROXY_HOPS: 'dois' })), /TRUSTED_PROXY_HOPS/);
  });

  it('em produção exige https em PUBLIC_BASE_URL', () => {
    assert.throws(() => loadConfig(valid({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://bridge.exemplo.com.br' })), /https/);
  });

  it('a mensagem de erro não leva valores, só nomes de variáveis e regras', () => {
    const err = (() => {
      try {
        loadConfig(valid({ ADMIN_PASSWORD: 'troque-por-uma-senha-longa', ENCRYPTION_KEY: 'chave-curta' }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    assert.ok(err !== null);
    assert.ok(!err.message.includes('chave-curta'));
    assert.match(err.message, /^Configuração inválida:/);
  });
});
