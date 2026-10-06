import type { Config } from '../config.ts';
import { isoNow, systemClock } from '../lib/clock.ts';
import { hmacSha256Hex, randomId, randomToken, sha256Hex, timingSafeEqualStr } from '../lib/crypto.ts';
import type { AdminSession, AdminSessionRepo, AuditRepo, Clock, Logger, RateLimiter } from '../types.ts';

/**
 * Autenticação do painel administrativo: uma única senha (ADMIN_PASSWORD) e sessões
 * guardadas no banco.
 *
 * O cookie leva um token aleatório de 256 bits; o banco guarda só um HMAC dele, com chave
 * derivada da senha do painel, então uma cópia do banco não permite assumir uma sessão
 * aberta e trocar ADMIN_PASSWORD invalida todas as sessões abertas de uma vez (o único
 * jeito de expulsar quem roubou um cookie, já que a senha é a única credencial do painel).
 * O token de CSRF é outro valor aleatório, amarrado à sessão e enviado em campo oculto de
 * cada formulário.
 */

export const ADMIN_COOKIE = 'cb_admin';

/** Duração da sessão: 12 horas, igual ao Max-Age do cookie. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Chave do limitador quando o IP não pôde ser determinado (todos dividem o mesmo balde). */
const UNKNOWN_IP_KEY = 'desconhecido';

/** Chave única do limitador global de login. */
const GLOBAL_LOGIN_KEY = 'global';

/**
 * Senhas maiores que isso são recusadas sem comparar. O formulário já é limitado em
 * 64 KB; o corte aqui só evita gastar HMAC com lixo quando a função é chamada por outro
 * caminho.
 */
const MAX_PASSWORD_CHARS = 1024;

/** randomToken(32) gera 43 caracteres base64url; qualquer coisa fora desse formato nem vai ao banco. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export interface AdminAuth {
  login(password: string, ip: string | null): { ok: true; setCookie: string } | { ok: false; reason: 'invalid' | 'rate_limited' };
  logout(cookieHeader: string | null | undefined): { setCookie: string };
  authenticate(cookieHeader: string | null | undefined): AdminSession | null;
  verifyCsrf(session: AdminSession, token: string | null | undefined): boolean;
}

/** Quantos cookies com o nome da sessão são examinados numa requisição. */
const MAX_TOKEN_CANDIDATES = 4;

/**
 * Extrai do cabeçalho Cookie os valores com o nome da sessão. O nome pode aparecer mais de
 * uma vez (um cookie plantado em outro caminho ou por um subdomínio, por exemplo), e a
 * ordem no cabeçalho não diz qual é o legítimo. Por isso todos os candidatos bem formados
 * são devolvidos e quem chama aceita apenas o que corresponder a uma sessão guardada: um
 * cookie plantado não vale nada e também não consegue derrubar a sessão verdadeira.
 */
function readSessionTokens(cookieHeader: string | null | undefined): string[] {
  if (typeof cookieHeader !== 'string' || cookieHeader === '' || cookieHeader.length > 8192) return [];
  const found: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (!TOKEN_RE.test(value) || found.includes(value)) continue;
    found.push(value);
    if (found.length >= MAX_TOKEN_CANDIDATES) break;
  }
  return found;
}

export function createAdminAuth(deps: {
  adminSessions: AdminSessionRepo;
  audit: AuditRepo;
  config: Pick<Config, 'adminPassword' | 'publicBaseUrl'>;
  /** Limite por IP do cliente. */
  loginLimiter: RateLimiter;
  /**
   * Limite global (uma chave só, todos os IPs). O IP vem de cabeçalhos de proxy e, com o
   * proxy mal configurado, pode ser forjado; este limite garante que o total de senhas
   * testadas por minuto tem teto mesmo quando cada tentativa vem com um "IP" diferente.
   */
  globalLoginLimiter?: RateLimiter;
  logger: Logger;
  clock?: Clock;
}): AdminAuth {
  const { adminSessions, audit, config, loginLimiter, globalLoginLimiter, logger } = deps;
  const clock = deps.clock ?? systemClock;

  // Secure só quando o serviço é publicado em https; em desenvolvimento (http://localhost)
  // o navegador descartaria o cookie e o login nunca "pegaria".
  const secure = config.publicBaseUrl.toLowerCase().startsWith('https://');
  const cookieAttributes = `Path=/admin; HttpOnly; SameSite=Strict`;

  function cookie(value: string, maxAge: number): string {
    return `${ADMIN_COOKIE}=${value}; ${cookieAttributes}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  // Chave do HMAC derivada da senha atual: uma sessão criada com a senha anterior nunca
  // mais é encontrada por findByTokenHash (ela some na próxima limpeza de vencidas).
  const sessionKey = sha256Hex(`checkout-bridge/admin-session\n${config.adminPassword}`);

  function tokenHash(token: string): string {
    return hmacSha256Hex(sessionKey, token);
  }

  /** A auditoria nunca pode derrubar o login nem o logout. */
  function recordAudit(action: string, targetId: string | null, detail: Record<string, unknown>): void {
    try {
      audit.record({ actor: 'admin', action, targetType: 'admin_session', targetId, detail });
    } catch (err) {
      logger.warn({ err, action }, 'falha ao gravar auditoria do painel');
    }
  }

  function authenticate(cookieHeader: string | null | undefined): AdminSession | null {
    const now = isoNow(clock);
    for (const token of readSessionTokens(cookieHeader)) {
      // O repositório já ignora sessões expiradas (expires_at > agora).
      const session = adminSessions.findByTokenHash(tokenHash(token), now);
      if (session !== null) return session;
    }
    return null;
  }

  return {
    login(password, ip) {
      // Os limitadores vêm antes da comparação: tentativa bloqueada não testa senha nenhuma.
      // Primeiro o balde do IP, depois o global: assim um único IP insistente esgota só o
      // próprio balde e não tranca o painel para os demais; o global só é consumido pelas
      // tentativas que passaram pelo IP, e é o que vale quando o IP é forjado ou desconhecido.
      let decision = loginLimiter.take(ip ?? UNKNOWN_IP_KEY);
      if (decision.allowed && globalLoginLimiter !== undefined) decision = globalLoginLimiter.take(GLOBAL_LOGIN_KEY);
      if (!decision.allowed) {
        // Só log, sem auditoria: durante um ataque de força bruta as recusas são ilimitadas
        // e encheriam a trilha de auditoria; as tentativas que passam pelos limitadores (e
        // por isso são contadas) continuam auditadas abaixo.
        logger.warn({ retryAfterMs: decision.retryAfterMs }, 'login do painel bloqueado pelo limitador');
        return { ok: false, reason: 'rate_limited' };
      }

      const valid =
        typeof password === 'string' &&
        password.length > 0 &&
        password.length <= MAX_PASSWORD_CHARS &&
        timingSafeEqualStr(password, config.adminPassword);
      if (!valid) {
        // Nem a senha tentada nem o IP entram na auditoria.
        recordAudit('admin.login_failed', null, { reason: 'invalid' });
        return { ok: false, reason: 'invalid' };
      }

      const now = clock.now();
      const token = randomToken(32);
      const session: AdminSession = {
        id: randomId('as'),
        csrfToken: randomToken(24),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
      };
      adminSessions.create(session, tokenHash(token));
      // Aproveita o login para limpar sessões vencidas; se falhar, não impede a entrada.
      try {
        adminSessions.purgeExpired(now.toISOString());
      } catch (err) {
        logger.warn({ err }, 'falha ao limpar sessões administrativas expiradas');
      }
      recordAudit('admin.login', session.id, {});
      return { ok: true, setCookie: cookie(token, SESSION_TTL_SECONDS) };
    },

    logout(cookieHeader) {
      const session = authenticate(cookieHeader);
      if (session !== null) {
        adminSessions.delete(session.id);
        recordAudit('admin.logout', session.id, {});
      }
      // O cookie é apagado mesmo sem sessão válida (expirada ou já removida).
      return { setCookie: cookie('', 0) };
    },

    authenticate,

    verifyCsrf(session, token) {
      if (typeof token !== 'string' || token === '' || token.length > 512) return false;
      if (typeof session?.csrfToken !== 'string' || session.csrfToken === '') return false;
      return timingSafeEqualStr(token, session.csrfToken);
    },
  };
}
