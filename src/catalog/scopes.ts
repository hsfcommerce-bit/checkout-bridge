import type { StoreRole } from '../types.ts';

/**
 * Escopos da Admin API que o app de cada loja precisa ter.
 *
 * No client credentials grant os escopos não são pedidos na chamada do token: a resposta só
 * informa (campo scope) o que está configurado na versão lançada do app e concedido na loja
 * (SC-26). Mudar escopo exige lançar uma versão nova E aprovar a mudança em cada loja
 * (SC-27, SC-28), então a única forma de saber se a loja está pronta é comparar essa leitura
 * com a lista abaixo.
 *
 * - read_products: catálogo (produtos, variantes, preços) e os webhooks de produto.
 * - read_inventory: quantidade em estoque das variantes.
 * - write_app_proxy (só vitrine): a documentação exige o escopo para o app ter App Proxy
 *   (SC-48). Há relato de proxy funcionando sem ele (RISK-02), mas a exigência é a regra
 *   documentada e é ela que vale aqui.
 *
 * - read_orders: webhooks de pedido. Na checkout alimentam o painel de vendas; na vitrine
 *   detectam pedido fechado fora da ponte (vazamento). Só o essencial do pedido é guardado,
 *   nunca dados pessoais do comprador (ver OrderRecord em src/types.ts).
 *
 * Nenhum escopo de escrita de catálogo ou de pedidos é pedido: o serviço só lê.
 */
export const REQUIRED_SCOPES: { vitrine: string[]; checkout: string[] } = {
  vitrine: ['read_products', 'read_inventory', 'write_app_proxy', 'read_orders'],
  checkout: ['read_products', 'read_inventory', 'read_orders'],
};

function normalizeScope(scope: unknown): string {
  return typeof scope === 'string' ? scope.trim().toLowerCase() : '';
}

/**
 * Escopos exigidos para o papel da loja que não aparecem entre os concedidos, na ordem de
 * REQUIRED_SCOPES.
 *
 * Um write_x concedido satisfaz o read_x exigido: na Shopify o escopo de escrita inclui a
 * leitura do mesmo recurso, e a leitura do token costuma trazer só o write_x nesse caso.
 * O contrário não vale (read_app_proxy não satisfaz write_app_proxy).
 */
export function missingScopes(role: StoreRole, granted: string[]): string[] {
  const have = new Set<string>();
  for (const raw of Array.isArray(granted) ? granted : []) {
    const scope = normalizeScope(raw);
    if (scope !== '') have.add(scope);
  }
  const required = REQUIRED_SCOPES[role] ?? [];
  return required.filter((scope) => {
    if (have.has(scope)) return false;
    if (scope.startsWith('read_') && have.has(`write_${scope.slice('read_'.length)}`)) return false;
    return true;
  });
}
