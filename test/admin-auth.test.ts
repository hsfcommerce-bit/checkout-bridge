import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN_COOKIE, createAdminAuth } from '../src/admin/auth.ts';
import type { AdminAuth } from '../src/admin/auth.ts';
import { hmacSha256Hex, sha256Hex } from '../src/lib/crypto.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import { setup } from './db-helpers.ts';
import type { TestContext } from './db-helpers.ts';

const PASSWORD = 'senha-de-teste-123';
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function build(opts: { publicBaseUrl?: string; capacity?: number } = {}): TestContext & { auth: AdminAuth } {
  const ctx = setup();
  const auth = createAdminAuth({
    adminSessions: ctx.repos.adminSessions,
    audit: ctx.repos.audit,
    config: { adminPassword: PASSWORD, publicBaseUrl: opts.publicBaseUrl ?? 'https://bridge.test' },
    loginLimiter: createRateLimiter({ capacity: opts.capacity ?? 5, refillPerSecond: 1 / 60, clock: ctx.clock }),
    logger: createLogger({ level: 'silent', env: 'test' }),
    clock: ctx.clock,
  });
  return { ...ctx, auth };
}

/** Valor do cookie de sessão a partir do cabeçalho Set-Cookie. */
function tokenOf(setCookie: string): string {
  const match = new RegExp(`^${ADMIN_COOKIE}=([^;]*)`).exec(setCookie);
  assert.ok(match?.[1] !== undefined, `Set-Cookie inesperado: ${setCookie}`);
  return match[1];
}

function cookieHeader(setCookie: string): string {
  return `${ADMIN_COOKIE}=${tokenOf(setCookie)}`;
}

function loginOk(auth: AdminAuth, ip: string | null = '203.0.113.9'): string {
  const result = auth.login(PASSWORD, ip);
  assert.ok(result.ok, 'login deveria ter sucesso');
  return result.setCookie;
}

describe('createAdminAuth.login', () => {
  it('cria a sessão e devolve o cookie com os atributos exigidos', () => {
    const { auth, db } = build();
    const setCookie = loginOk(auth);
    const token = tokenOf(setCookie);
    assert.ok(token.length >= 40, 'token curto demais');
    for (const attr of ['Path=/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=43200', 'Secure']) {
      assert.ok(setCookie.includes(attr), `faltou ${attr} em ${setCookie}`);
    }
    // O banco guarda só um HMAC do token, com chave derivada da senha: nem o token nem o
    // SHA-256 puro dele (que valeria para sempre, mesmo depois de trocar a senha).
    const row = db.get<{ token_hash: string }>('SELECT token_hash FROM admin_sessions');
    assert.ok(row !== undefined && /^[0-9a-f]{64}$/.test(row.token_hash));
    assert.notEqual(row?.token_hash, token);
    assert.notEqual(row?.token_hash, sha256Hex(token));
    assert.equal(row?.token_hash, hmacSha256Hex(sha256Hex(`checkout-bridge/admin-session\n${PASSWORD}`), token));
  });

  it('não marca Secure quando a URL pública é http', () => {
    const { auth } = build({ publicBaseUrl: 'http://localhost:8787' });
    assert.ok(!loginOk(auth).includes('Secure'));
  });

  it('recusa senha errada e audita sem gravar a senha', () => {
    const { auth, repos } = build();
    const result = auth.login('senha-errada-xyz', '203.0.113.9');
    assert.deepEqual(result, { ok: false, reason: 'invalid' });
    const entries = repos.audit.list({ limit: 10, offset: 0 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.action, 'admin.login_failed');
    assert.ok(!JSON.stringify(entries).includes('senha-errada-xyz'));
  });

  it('recusa senha vazia e enorme sem comparar', () => {
    const { auth } = build();
    assert.deepEqual(auth.login('', null), { ok: false, reason: 'invalid' });
    assert.deepEqual(auth.login(`${PASSWORD}${'x'.repeat(5000)}`, null), { ok: false, reason: 'invalid' });
  });

  it('audita o login bem-sucedido com o id da sessão', () => {
    const { auth, repos } = build();
    const session = auth.authenticate(cookieHeader(loginOk(auth)));
    const entries = repos.audit.list({ limit: 10, offset: 0 });
    assert.equal(entries[0]?.action, 'admin.login');
    assert.equal(entries[0]?.actor, 'admin');
    assert.equal(entries[0]?.targetId, session?.id);
  });

  it('aplica o limitador por IP antes de testar a senha', () => {
    const { auth, repos } = build({ capacity: 2 });
    assert.equal(auth.login('errada-1234567', '198.51.100.1').ok, false);
    assert.equal(auth.login('errada-1234567', '198.51.100.1').ok, false);
    const blocked = auth.login(PASSWORD, '198.51.100.1');
    assert.deepEqual(blocked, { ok: false, reason: 'rate_limited' });
    // Outro IP tem o próprio balde.
    assert.equal(auth.login(PASSWORD, '198.51.100.2').ok, true);
    // Tentativas barradas não entram na auditoria (só as duas senhas erradas e o login).
    assert.equal(repos.audit.list({ limit: 10, offset: 0 }).length, 3);
  });

  it('agrupa requisições sem IP numa única chave', () => {
    const { auth } = build({ capacity: 1 });
    assert.equal(auth.login(PASSWORD, null).ok, true);
    assert.deepEqual(auth.login(PASSWORD, null), { ok: false, reason: 'rate_limited' });
  });
});

describe('createAdminAuth.authenticate', () => {
  it('encontra a sessão pelo cookie e ignora cookies alheios', () => {
    const { auth } = build();
    const setCookie = loginOk(auth);
    const session = auth.authenticate(`outro=1; ${cookieHeader(setCookie)}; cb_flash=abc`);
    assert.ok(session !== null);
    assert.ok(session.csrfToken.length >= 30);
  });

  it('devolve null para cookie ausente, malformado ou desconhecido', () => {
    const { auth } = build();
    loginOk(auth);
    assert.equal(auth.authenticate(undefined), null);
    assert.equal(auth.authenticate(''), null);
    assert.equal(auth.authenticate(`${ADMIN_COOKIE}=`), null);
    assert.equal(auth.authenticate(`${ADMIN_COOKIE}=nao-e-um-token-valido-mas-tem-tamanho-xx`), null);
    assert.equal(auth.authenticate(`${ADMIN_COOKIE}=<script>`), null);
  });

  it('aceita o cookie legítimo mesmo com outro de mesmo nome plantado antes dele', () => {
    const { auth } = build();
    const good = tokenOf(loginOk(auth));
    const planted = 'A'.repeat(43);
    assert.ok(auth.authenticate(`${ADMIN_COOKIE}=${planted}; ${ADMIN_COOKIE}=${good}`) !== null);
    assert.equal(auth.authenticate(`${ADMIN_COOKIE}=${planted}`), null);
  });

  it('trocar ADMIN_PASSWORD invalida as sessões abertas; reiniciar com a mesma senha as mantém', () => {
    const ctx = setup();
    const make = (password: string): AdminAuth =>
      createAdminAuth({
        adminSessions: ctx.repos.adminSessions,
        audit: ctx.repos.audit,
        config: { adminPassword: password, publicBaseUrl: 'https://bridge.test' },
        loginLimiter: createRateLimiter({ capacity: 5, refillPerSecond: 1 / 60, clock: ctx.clock }),
        logger: createLogger({ level: 'silent', env: 'test' }),
        clock: ctx.clock,
      });
    const before = make(PASSWORD);
    const cookie = cookieHeader(loginOk(before));
    assert.ok(before.authenticate(cookie) !== null);
    assert.ok(make(PASSWORD).authenticate(cookie) !== null, 'mesma senha: a sessão sobrevive ao reinício');
    const rotated = make('senha-nova-456');
    assert.equal(rotated.authenticate(cookie), null, 'senha trocada: o cookie antigo deixa de valer');
    // Com a senha nova o login funciona e a sessão nova é encontrada normalmente.
    const fresh = rotated.login('senha-nova-456', '203.0.113.9');
    assert.ok(fresh.ok);
    assert.ok(rotated.authenticate(cookieHeader(fresh.setCookie)) !== null);
  });

  it('ignora a sessão depois de 12 horas', () => {
    const { auth, clock } = build();
    const header = cookieHeader(loginOk(auth));
    clock.advance(TWELVE_HOURS_MS - 1);
    assert.ok(auth.authenticate(header) !== null);
    clock.advance(1);
    assert.equal(auth.authenticate(header), null);
  });

  it('o login seguinte limpa as sessões vencidas', () => {
    const { auth, clock, db } = build();
    loginOk(auth);
    clock.advance(TWELVE_HOURS_MS + 1);
    loginOk(auth);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_sessions')?.n, 1);
  });
});

describe('createAdminAuth.logout e verifyCsrf', () => {
  it('apaga a sessão e devolve um cookie que expira na hora', () => {
    const { auth, repos } = build();
    const header = cookieHeader(loginOk(auth));
    const { setCookie } = auth.logout(header);
    assert.ok(setCookie.startsWith(`${ADMIN_COOKIE}=;`));
    assert.ok(setCookie.includes('Max-Age=0'));
    assert.ok(setCookie.includes('Path=/admin'));
    assert.equal(auth.authenticate(header), null);
    assert.equal(repos.audit.list({ limit: 10, offset: 0 })[0]?.action, 'admin.logout');
  });

  it('logout sem sessão válida ainda devolve o cookie de limpeza', () => {
    const { auth } = build();
    assert.ok(auth.logout(undefined).setCookie.includes('Max-Age=0'));
  });

  it('verifyCsrf só aceita o token exato da sessão', () => {
    const { auth } = build();
    const session = auth.authenticate(cookieHeader(loginOk(auth)));
    assert.ok(session !== null);
    assert.equal(auth.verifyCsrf(session, session.csrfToken), true);
    assert.equal(auth.verifyCsrf(session, `${session.csrfToken}x`), false);
    assert.equal(auth.verifyCsrf(session, ''), false);
    assert.equal(auth.verifyCsrf(session, null), false);
    assert.equal(auth.verifyCsrf(session, undefined), false);
  });
});
