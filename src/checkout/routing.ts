import type { Link } from '../types.ts';

/**
 * Escolha da rota vitrine -> checkout.
 *
 * A regra inteira é esta: entre as rotas ATIVAS, a rota 'country' que lista o país do
 * comprador vence; sem ela, vale a rota 'default' ativa; sem nenhuma, não há rota.
 * Não existe outro critério, por decisão de projeto: nada de volume, horário, cota, carga
 * ou falha da loja de destino. Se a loja de destino estiver fora do ar, o checkout falha;
 * ele nunca é desviado para outra loja.
 */

/**
 * O repositório garante no máximo uma rota aplicável de cada tipo por vitrine. Se mesmo
 * assim chegarem duas (lista montada à mão, dado antigo), a mais antiga vence, só para o
 * resultado não depender da ordem da lista recebida.
 */
function oldestFirst(a: Link, b: Link): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function resolveLink(links: Link[], country: string | null): Link | null {
  const enabled = links.filter((link) => link.enabled === true).sort(oldestFirst);
  if (country !== null) {
    const byCountry = enabled.find((link) => link.kind === 'country' && link.countries.includes(country));
    if (byCountry) return byCountry;
  }
  return enabled.find((link) => link.kind === 'default') ?? null;
}
