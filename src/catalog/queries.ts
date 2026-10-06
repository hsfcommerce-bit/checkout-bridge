/**
 * Documentos GraphQL da Admin API usados na sincronização de catálogo.
 *
 * Nomes de campos conferidos para a versão 2026-10 (docs/research/3-admin-api-catalog-webhooks.md,
 * itens AC-04 a AC-24, e shopify.dev para Domain.host e Query.product). Tudo aqui é leitura e
 * exige só o escopo read_products.
 *
 * Preço: ProductVariant.price e compareAtPrice são o escalar Money (string decimal) na moeda
 * PADRÃO da loja, sem código de moeda (AC-08, PT-22). Preço por mercado só existe em
 * contextualPricing, que não é lido aqui: a paridade compara os preços-base das duas lojas e
 * quem decide o valor cobrado é sempre o carrinho da loja checkout.
 */

/**
 * Tamanho inicial da página de variantes. O custo pedido de uma consulta cresce com `first`
 * e uma única consulta não pode passar de 1.000 pontos (AC-27): com os campos abaixo, 100
 * variantes ficam em torno de 400 pontos e 250 (o máximo de uma página) já estourariam.
 */
export const CATALOG_PAGE_SIZE = 100;

/** Menor página possível; abaixo disso não há mais como reduzir o custo da consulta. */
export const MIN_PAGE_SIZE = 1;

/**
 * A Shopify só pagina até 25.000 objetos por conexão (AC-24). Catálogos maiores precisam de
 * filtros ou de bulk operation; continuar paginando além disso não é suportado.
 */
export const PAGINATION_OBJECT_CAP = 25_000;

/** Código de erro da Shopify quando o custo pedido de UMA consulta passa do teto. */
export const MAX_COST_EXCEEDED = 'MAX_COST_EXCEEDED';

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query BridgeShopInfo {
    shop {
      name
      currencyCode
      myshopifyDomain
      primaryDomain {
        host
      }
    }
  }
`;

/**
 * Campos da variante comuns às duas consultas.
 *
 * - barcode: DESCONTINUADO na 2026-10 (AC-05). Foi substituído pela conexão `barcodes` (até
 *   20 por variante); o campo antigo continua respondendo, mas devolve só o PRIMEIRO código,
 *   sem avisar que existem outros. É mantido porque o contrato (CatalogVariant.barcode) guarda
 *   um único código; trocar por `barcodes` exige mudar o contrato e o casamento por código de
 *   barras antes que o campo seja removido numa versão futura.
 * - inventoryQuantity é o total vendável e pode vir null; só faz sentido quando
 *   inventoryItem.tracked é true.
 * - inventoryItem é legível com read_products (AC-18), sem precisar de read_inventory.
 */
const VARIANT_CORE_FIELDS = /* GraphQL */ `
  fragment BridgeVariantCore on ProductVariant {
    id
    title
    sku
    barcode
    price
    compareAtPrice
    availableForSale
    inventoryPolicy
    inventoryQuantity
    selectedOptions {
      name
      value
    }
    inventoryItem {
      tracked
    }
  }
`;

/**
 * Uma página de variantes da loja inteira. A ordenação padrão é por ID, o que mantém o cursor
 * estável mesmo com o catálogo mudando durante a leitura. Não há filtro por status: produtos
 * DRAFT, ARCHIVED e UNLISTED também entram, e quem decide o que é vendável é quem consome
 * (UNLISTED é vendável por link direto, AC-15).
 */
export const VARIANTS_PAGE_QUERY = /* GraphQL */ `
  query BridgeVariantsPage($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes {
        ...BridgeVariantCore
        product {
          id
          title
          handle
          status
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  ${VARIANT_CORE_FIELDS}
`;

/**
 * Um produto com as variantes dele, paginadas (um produto pode ter até 2.048 variantes). Os
 * dados do produto vêm uma vez só, no nível de cima, em vez de repetidos em cada variante.
 * `product` vem null quando o ID não existe mais (produto apagado).
 */
export const PRODUCT_VARIANTS_QUERY = /* GraphQL */ `
  query BridgeProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      id
      title
      handle
      status
      variants(first: $first, after: $after) {
        nodes {
          ...BridgeVariantCore
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
  ${VARIANT_CORE_FIELDS}
`;
