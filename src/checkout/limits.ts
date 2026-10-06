/**
 * Limites das propriedades de linha (personalização: gravação, mensagem de presente,
 * JSON de configurador) aceitos numa requisição de checkout.
 *
 * Um único lugar para os dois lados: src/checkout/schema.ts recusa o que passa daqui e
 * src/theme/render.ts entrega os mesmos números ao script do tema, que então evita
 * mandar uma requisição que o serviço recusaria inteira. A Shopify não documenta limite
 * de tamanho para AttributeInput (pesquisa SF-09); o corpo já é limitado a 64 KB, então
 * estes valores só precisam caber nos casos reais.
 */
export interface PropertyLimits {
  /** Propriedades por linha (depois de descartar as privadas "__x" e as vazias). */
  maxProperties: number;
  /** Comprimento máximo da chave, em unidades UTF-16 (igual a String.length). */
  maxKeyLength: number;
  /** Comprimento máximo do valor, em unidades UTF-16 (igual a String.length). */
  maxValueLength: number;
}

export const PROPERTY_LIMITS: Readonly<PropertyLimits> = Object.freeze({
  maxProperties: 25,
  maxKeyLength: 100,
  maxValueLength: 2000,
});
