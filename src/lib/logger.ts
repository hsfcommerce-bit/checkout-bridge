import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import type { Config } from '../config.ts';
import type { Logger } from '../types.ts';

/** Texto que substitui os valores censurados. */
export const REDACT_CENSOR = '[redigido]';

/**
 * Chaves cujo valor nunca pode aparecer em log, em qualquer objeto logado.
 *
 * A censura do pino casa a chave de forma exata e sensível a maiúsculas, por isso os
 * cabeçalhos aparecem nas duas grafias: minúscula (como o Node e o Hono entregam os
 * cabeçalhos recebidos) e canônica (como costumam ser escritos nas chamadas de saída).
 *
 * Cada chave custa alguns microssegundos por linha de log (o pino reavalia todos os
 * caminhos a cada linha), então a lista se limita ao que este serviço de fato manipula.
 */
export const SENSITIVE_KEYS: string[] = [
  // Credenciais das lojas e do painel
  'clientSecret',
  'client_secret',
  'accessToken',
  'access_token',
  'storefrontToken',
  'token',
  'csrfToken',
  'password',
  'adminPassword',
  'secret',
  // Campos de Config que são segredo (um log do objeto de configuração inteiro é o
  // vazamento clássico). A URL do webhook carrega o segredo no próprio caminho.
  'encryptionKey',
  'metricsToken',
  'alertWebhookUrl',
  'webhookUrl',
  // IP do comprador em claro (só o HMAC pode ser guardado ou logado). Os cabeçalhos de
  // proxy entram porque um log de `req.headers` inteiro levaria o IP junto.
  'buyerIp',
  'clientIp',
  'ip',
  'x-forwarded-for',
  'X-Forwarded-For',
  'x-real-ip',
  'X-Real-IP',
  // Cabeçalhos
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'x-shopify-access-token',
  'X-Shopify-Access-Token',
  'x-shopify-storefront-access-token',
  'X-Shopify-Storefront-Access-Token',
  'shopify-storefront-private-token',
  'Shopify-Storefront-Private-Token',
];

/** Segmento de caminho do pino: identificador simples ou ["chave-com-hífen"]. */
function pathSegment(key: string): { head: string; tail: string } {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return { head: key, tail: `.${key}` };
  const quoted = `["${key}"]`;
  return { head: quoted, tail: quoted };
}

/**
 * Caminhos de censura: cada chave sensível no nível raiz e a um e dois níveis de
 * profundidade (o curinga "*" do pino também percorre índices de array). Isso cobre
 * { clientSecret }, { store: { clientSecret } } e { req: { headers: { authorization } } }.
 *
 * Limites que quem loga precisa conhecer:
 * - a censura é por nome de chave; um segredo embutido em texto livre (mensagem, URL)
 *   NÃO é detectado;
 * - uma chave sensível a três ou mais níveis de profundidade NÃO é censurada.
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const { head, tail } = pathSegment(key);
  return [head, `*${tail}`, `*.*${tail}`];
});

/**
 * Logger JSON (uma linha por evento) com censura de segredos.
 *
 * Não há formatação "bonita" embutida, de propósito: em desenvolvimento basta encadear a
 * saída em uma ferramenta externa. `env` faz parte da assinatura para que a composição
 * não precise mudar se a saída passar a variar por ambiente; hoje ela é a mesma em todos.
 * `destination` existe para os testes capturarem a saída; o padrão é stdout.
 */
export function createLogger(opts: {
  level: Config['logLevel'];
  env: Config['env'];
  destination?: DestinationStream;
}): Logger {
  const options = {
    level: opts.level,
    base: { service: 'checkout-bridge' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Nível por nome ("info") em vez de número: legível sem ferramenta auxiliar.
      level: (label: string) => ({ level: label }),
    },
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
