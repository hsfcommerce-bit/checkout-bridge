import type { Clock, RateLimitDecision, RateLimiter } from '../types.ts';
import { systemClock } from './clock.ts';

const DEFAULT_MAX_KEYS = 50_000;

/**
 * Folga, em milissegundos, para o erro de ponto flutuante acumulado nas somas. Um
 * microssegundo é irrelevante para o limite e muito maior que o erro possível.
 */
const TIME_EPSILON_MS = 1e-3;

/**
 * Limitador em memória, um balde de fichas por chave.
 *
 * Em vez de guardar "quantas fichas restam", cada chave guarda um único número: o
 * instante em que o balde volta a ficar cheio. É o mesmo balde de fichas, só que uma
 * recusa não altera o estado, e por isso o tempo de espera informado é exato: quem
 * volta depois de `retryAfterMs` passa, quem volta um milissegundo antes não.
 *
 * Vale só para este processo: com mais de uma instância do serviço, cada uma aplica o
 * limite por conta própria.
 *
 * Memória limitada por `maxKeys`. Baldes cheios nem são guardados (equivalem a uma chave
 * nunca vista). Quando uma chave nova chega com o mapa cheio, saem primeiro os baldes
 * que encheram desde o último uso (ociosos) e, se ainda faltar espaço, o usado há mais
 * tempo.
 */
export function createRateLimiter(opts: {
  capacity: number;
  refillPerSecond: number;
  clock?: Clock;
  maxKeys?: number;
}): RateLimiter {
  const { capacity, refillPerSecond } = opts;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error('Limitador: capacity deve ser um número maior que zero');
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error('Limitador: refillPerSecond deve ser um número maior que zero');
  }
  const clock = opts.clock ?? systemClock;
  const maxKeys =
    opts.maxKeys !== undefined && Number.isFinite(opts.maxKeys) && opts.maxKeys >= 1
      ? Math.floor(opts.maxKeys)
      : DEFAULT_MAX_KEYS;

  /** Tempo para repor uma ficha. */
  const intervalMs = 1000 / refillPerSecond;
  /** Tempo para encher um balde vazio. */
  const burstMs = capacity * intervalMs;

  // Os instantes são relativos à criação do limitador: números pequenos preservam a
  // precisão das frações de milissegundo.
  const origin = clock.now().getTime();

  // Chave -> instante em que o balde fica cheio. O Map preserva a ordem de inserção e
  // cada uso reinsere a chave no fim, então a primeira da iteração é a usada há mais tempo.
  const fullAt = new Map<string, number>();

  // A varredura de ociosos custa O(n). Sob uma enxurrada de chaves distintas e ativas ela
  // não libera nada, então roda no máximo uma vez a cada `sweepEvery` inserções com o
  // mapa cheio; entre uma varredura e outra sai direto o balde mais antigo, em O(1).
  const sweepEvery = Math.max(1, Math.floor(maxKeys / 10));
  let insertsSinceSweep = sweepEvery;

  function makeRoom(now: number): void {
    if (insertsSinceSweep >= sweepEvery) {
      insertsSinceSweep = 0;
      for (const [key, at] of fullAt) {
        if (at <= now) fullAt.delete(key);
      }
    }
    insertsSinceSweep += 1;
    while (fullAt.size >= maxKeys) {
      const oldest = fullAt.keys().next();
      if (oldest.done) break;
      fullAt.delete(oldest.value);
    }
  }

  return {
    take(key: string, cost = 1): RateLimitDecision {
      // Custo inválido vira 1: uma chamada mal formada não pode sair de graça.
      const needed = Number.isFinite(cost) && cost >= 0 ? cost : 1;
      const now = clock.now().getTime() - origin;
      const stored = fullAt.get(key);

      let base = stored === undefined || stored < now ? now : stored;
      // Só acontece se o relógio voltou no tempo: trata o balde como vazio agora, em vez
      // de deixar a chave bloqueada pelo tamanho do salto.
      if (base > now + burstMs) base = now + burstMs;

      const next = base + needed * intervalMs;
      // Instante a partir do qual o balde comporta este custo.
      const readyAt = next - burstMs;
      const allowed = readyAt <= now + TIME_EPSILON_MS;
      const updated = allowed ? next : base;

      // Recusas também renovam a posição: uma chave sendo martelada não pode ser a
      // primeira a sair do mapa, porque voltaria com o balde cheio.
      if (stored !== undefined) fullAt.delete(key);
      if (updated > now) {
        if (stored === undefined && fullAt.size >= maxKeys) makeRoom(now);
        fullAt.set(key, updated);
      }

      if (allowed) return { allowed: true, retryAfterMs: 0 };
      // Se o custo for maior que a capacidade o balde nunca chega lá; o valor devolvido
      // continua finito para poder virar um cabeçalho Retry-After.
      // Metade da folga no arredondamento garante que, passado esse tempo, a comparação
      // acima dá verdadeiro mesmo com erro de ponto flutuante.
      // O teto cobre custos absurdos (1e308), em que a conta acima estoura para Infinity.
      const waitMs = Math.ceil(readyAt - now - TIME_EPSILON_MS / 2);
      const retryAfterMs = Number.isFinite(waitMs) ? Math.max(1, waitMs) : Number.MAX_SAFE_INTEGER;
      return { allowed: false, retryAfterMs };
    },
  };
}
