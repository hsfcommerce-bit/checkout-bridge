import type { Alert, Alerter, AlertSeverity, Clock, Logger } from '../types.ts';
import { systemClock } from './clock.ts';
import { REDACT_CENSOR, SENSITIVE_KEYS } from './logger.ts';
import { fetchWithTimeout, TimeoutError } from './resilience.ts';

const DEFAULT_COOLDOWN_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_DEDUPE_KEYS = 5000;
/** Envios simultâneos ao webhook; acima disso o envio é descartado (o log já foi feito). */
const MAX_IN_FLIGHT = 20;
const MAX_TITLE_CHARS = 300;
const MAX_DETAIL_CHARS = 4000;
const MAX_SUMMARY_DETAIL_CHARS = 600;

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'INFO',
  warning: 'AVISO',
  critical: 'CRÍTICO',
};

const SENSITIVE_LOWER = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/**
 * Cópia do detalhe segura para sair do processo: chaves sensíveis censuradas em qualquer
 * profundidade, tamanho limitado e sem nada que faça o JSON.stringify lançar.
 * O detalhe vai para um serviço de terceiros (Slack, Discord), então a censura aqui não
 * depende da do logger.
 */
function sanitizeDetail(detail: unknown): Record<string, unknown> {
  if (detail === undefined || detail === null) return {};
  try {
    const json = JSON.stringify(detail, (key, value: unknown) => {
      if (key !== '' && SENSITIVE_LOWER.has(key.toLowerCase())) return REDACT_CENSOR;
      if (typeof value === 'bigint') return value.toString();
      // Error não tem propriedades enumeráveis e viraria "{}".
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    });
    if (json === undefined) return {};
    if (json.length > MAX_DETAIL_CHARS) {
      return { truncated: true, preview: json.slice(0, MAX_DETAIL_CHARS) };
    }
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // Referência circular, getter que lança etc.
    return { unserializable: true };
  }
}

function oneLine(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Descrição curta da falha de envio, montada só com o nome da classe do erro e o código
 * de rede. A mensagem do erro fica de fora: o fetch inclui a URL em algumas mensagens
 * ("Failed to parse URL from ...") e a URL do webhook é um segredo.
 */
function describeFailure(err: unknown): string {
  if (err instanceof TimeoutError) return 'timeout';
  if (typeof err !== 'object' || err === null) return 'error';
  const name = typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : 'Error';
  const cause = (err as { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const safeName = /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : 'Error';
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `${safeName} (${code})` : safeName;
}

/**
 * Alertas operacionais: sempre vão para o log e, se houver webhook configurado, também
 * para ele. notify() nunca lança e nunca espera a rede; o envio acontece em segundo plano.
 *
 * Alertas com a mesma chave dentro de `cooldownMs` são suprimidos (log em debug, sem
 * envio). O intervalo vale mesmo quando o envio anterior falhou: um webhook fora do ar
 * não pode virar uma rajada de tentativas. O alerta original já está no log.
 */
export function createAlerter(opts: {
  webhookUrl: string | null;
  logger: Logger;
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}): Alerter {
  const { logger } = opts;
  const clock = opts.clock ?? systemClock;
  const cooldownMs =
    opts.cooldownMs !== undefined && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0
      ? opts.cooldownMs
      : DEFAULT_COOLDOWN_MS;
  const timeoutMs =
    opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let webhookUrl: string | null = null;
  if (opts.webhookUrl) {
    try {
      const protocol = new URL(opts.webhookUrl).protocol;
      if (protocol === 'https:' || protocol === 'http:') webhookUrl = opts.webhookUrl;
    } catch {
      // Tratado logo abaixo, junto com o protocolo não suportado.
    }
    if (webhookUrl === null) {
      logger.warn('URL do webhook de alertas inválida; os alertas ficarão apenas no log');
    }
  }

  // Chave -> instante (ms) do último alerta emitido. Cada emissão reinsere a chave no
  // fim, então o Map fica em ordem de tempo e as entradas vencidas estão sempre no começo.
  const lastEmitted = new Map<string, number>();
  let inFlight = 0;

  function shouldSuppress(key: string, now: number): boolean {
    const last = lastEmitted.get(key);
    // now < last só acontece se o relógio voltou; nesse caso o alerta passa.
    if (last !== undefined && now >= last && now - last < cooldownMs) return true;
    lastEmitted.delete(key);
    for (const [otherKey, at] of lastEmitted) {
      if (now - at < cooldownMs) break;
      lastEmitted.delete(otherKey);
    }
    while (lastEmitted.size >= MAX_DEDUPE_KEYS) {
      const oldest = lastEmitted.keys().next();
      if (oldest.done) break;
      lastEmitted.delete(oldest.value);
    }
    lastEmitted.set(key, now);
    return false;
  }

  async function deliver(url: string, key: string, body: string): Promise<void> {
    inFlight += 1;
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const res = await fetchWithTimeout(
        fetchImpl,
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        timeoutMs,
      );
      if (res.status < 200 || res.status >= 300) {
        logger.warn({ alertKey: key, status: res.status }, 'webhook de alertas respondeu com erro');
      }
    } catch (err) {
      try {
        logger.warn({ alertKey: key, reason: describeFailure(err) }, 'falha ao enviar alerta ao webhook');
      } catch {
        // Nem a falha do próprio log pode escapar daqui.
      }
    } finally {
      inFlight -= 1;
    }
  }

  return {
    notify(alert: Alert): void {
      try {
        const now = clock.now();
        const key = oneLine(alert.key, 200);
        const severity: AlertSeverity =
          alert.severity === 'info' || alert.severity === 'critical' ? alert.severity : 'warning';
        const title = oneLine(alert.title, MAX_TITLE_CHARS);

        if (shouldSuppress(key, now.getTime())) {
          logger.debug({ alertKey: key, severity }, `alerta suprimido (repetido dentro do intervalo): ${title}`);
          return;
        }

        const detail = sanitizeDetail(alert.detail);
        const fields = { alertKey: key, severity, detail };
        const message = `alerta: ${title}`;
        if (severity === 'critical') logger.error(fields, message);
        else if (severity === 'warning') logger.warn(fields, message);
        else logger.info(fields, message);

        if (webhookUrl === null) return;
        if (inFlight >= MAX_IN_FLIGHT) {
          logger.warn({ alertKey: key }, 'webhook de alertas saturado; envio descartado');
          return;
        }

        const detailJson = Object.keys(detail).length > 0 ? JSON.stringify(detail) : '';
        const summary =
          `[checkout-bridge] ${SEVERITY_LABEL[severity]}: ${title} (${key})` +
          (detailJson ? ` ${oneLine(detailJson, MAX_SUMMARY_DETAIL_CHARS)}` : '');
        // `text` é o campo que o Slack lê e `content` o que o Discord lê; os dois levam o
        // mesmo resumo de uma linha. Os demais campos servem a receptores genéricos.
        const body = JSON.stringify({
          text: summary,
          content: summary,
          key,
          severity,
          title,
          detail,
          at: now.toISOString(),
        });
        // deliver() trata todos os erros; a promessa nunca rejeita.
        void deliver(webhookUrl, key, body);
      } catch {
        // Alertar é melhor esforço: quem chama nunca pode ser interrompido por isso.
      }
    },
  };
}
