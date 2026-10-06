import { readFileSync } from 'node:fs';
import { PROPERTY_LIMITS } from '../checkout/limits.ts';
import { normalizeHost } from '../lib/shop.ts';
import type { Store } from '../types.ts';

/**
 * Geração do script do tema (src/theme/bridge.client.js) com a configuração da vitrine.
 *
 * O mesmo texto é servido de dois jeitos: pelo App Proxy (GET {proxyPath}/bridge.js, via
 * src/routes/proxy.ts) e colado inline no theme.liquid pelo lojista (painel). Por isso a
 * configuração é serializada de forma segura dentro de um elemento script E dentro de um
 * arquivo Liquid: "<", ">", "&" e os separadores U+2028/U+2029 viram escapes \u, e "{"
 * seguido de "{" ou "%" também, para o Liquid não interpretar valores da configuração.
 */

export interface BridgeScriptConfig {
  /** Caminho do App Proxy no domínio da vitrine, por exemplo "/apps/checkout-bridge". */
  proxyPath: string;
  /** Hosts das lojas checkout, para preconnect. Só hostnames válidos entram. */
  checkoutHosts: string[];
  /**
   * 'hide': esconde os botões de checkout acelerado (padrão; eles não podem ser
   * redirecionados e criariam o pedido na vitrine). 'intercept': tenta cancelar o clique
   * e tratá-lo como compra direta ou checkout do carrinho.
   */
  acceleratedButtons: 'hide' | 'intercept';
  /** 'message': mostra aviso acessível e libera o botão. 'native': segue para o checkout da vitrine. */
  onError: 'message' | 'native';
  /** Seletores CSS extras de botões de checkout (apps de gaveta de carrinho). */
  extraSelectors: string[];
  debug: boolean;
}

export const DEFAULT_PROXY_PATH = '/apps/checkout-bridge';

const PLACEHOLDER = '/*__CONFIG__*/null';
/** Prefixos e subcaminho que a Shopify aceita para o App Proxy (a, apps, community, tools). */
const PROXY_PATH_RE = /^\/(?:a|apps|community|tools)\/[A-Za-z0-9_-]{1,30}$/;
const MAX_HOSTS = 8;
const MAX_SELECTORS = 20;
const MAX_SELECTOR_LENGTH = 200;
/** Controles C0/C1 e DEL não têm lugar num seletor CSS. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** Sequências que quebrariam o script inline ou seriam interpretadas pelo Liquid. */
const FORBIDDEN_IN_TEMPLATE = ['</script', '<!--', '{{', '{%'];

/** Separadores de linha e parágrafo do Unicode, montados por código para não depender do editor. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const UNSAFE_IN_SCRIPT_RE = new RegExp(`[<>&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');

const JSON_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  [LINE_SEPARATOR]: '\\u2028',
  [PARAGRAPH_SEPARATOR]: '\\u2029',
};

/**
 * Lê o script uma vez, na carga do módulo: um arquivo ausente ou fora das regras derruba
 * o processo na partida, não no primeiro comprador.
 */
function loadTemplate(): string {
  const raw = readFileSync(new URL('./bridge.client.js', import.meta.url), 'utf8');
  // Comentários de linha inteira são documentação do código e saem do que vai ao navegador.
  const stripped = raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//');
    })
    .join('\n');
  const first = stripped.indexOf(PLACEHOLDER);
  if (first === -1 || stripped.indexOf(PLACEHOLDER, first + 1) !== -1) {
    throw new Error('checkout-bridge: bridge.client.js precisa ter exatamente um marcador de configuração');
  }
  const lower = stripped.toLowerCase();
  for (const forbidden of FORBIDDEN_IN_TEMPLATE) {
    if (lower.includes(forbidden)) {
      throw new Error(`checkout-bridge: bridge.client.js não pode conter "${forbidden}"`);
    }
  }
  return stripped;
}

const TEMPLATE = loadTemplate();

export function isValidProxyPath(value: unknown): value is string {
  return typeof value === 'string' && PROXY_PATH_RE.test(value);
}

function cleanHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) return [];
  const out: string[] = [];
  for (const host of hosts) {
    if (typeof host !== 'string') continue;
    const normalized = normalizeHost(host);
    if (normalized === null || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length === MAX_HOSTS) break;
  }
  return out;
}

function cleanSelectors(selectors: unknown): string[] {
  if (!Array.isArray(selectors)) return [];
  const out: string[] = [];
  for (const selector of selectors) {
    if (typeof selector !== 'string') continue;
    const trimmed = selector.trim();
    if (trimmed === '' || trimmed.length > MAX_SELECTOR_LENGTH || CONTROL_CHAR_RE.test(trimmed)) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length === MAX_SELECTORS) break;
  }
  return out;
}

/**
 * Cópia saneada, só com as chaves conhecidas: o objeto pode ter vindo de JSON guardado e
 * nada além do contrato chega ao navegador. Lança se o caminho do proxy for inválido,
 * porque ele vira URL de requisição e atributo HTML.
 */
function sanitizeConfig(config: BridgeScriptConfig): BridgeScriptConfig {
  if (!isValidProxyPath(config.proxyPath)) {
    throw new Error('checkout-bridge: caminho do App Proxy inválido');
  }
  return {
    proxyPath: config.proxyPath,
    checkoutHosts: cleanHosts(config.checkoutHosts),
    acceleratedButtons: config.acceleratedButtons === 'intercept' ? 'intercept' : 'hide',
    onError: config.onError === 'native' ? 'native' : 'message',
    extraSelectors: cleanSelectors(config.extraSelectors),
    debug: config.debug === true,
  };
}

/** JSON seguro dentro de <script> e de um arquivo Liquid (veja o cabeçalho do módulo). */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(UNSAFE_IN_SCRIPT_RE, (ch) => JSON_ESCAPES[ch] ?? ch)
    // Estruturalmente "{" é sempre seguido de '"' ou "}", então "{{" e "{%" só ocorrem
    // dentro de strings, onde { é um escape válido.
    .replace(/\{(?=[{%])/g, '\\u007b');
}

/**
 * Configuração padrão de uma vitrine. O caminho do proxy vem da loja (o lojista pode tê-lo
 * personalizado no admin da Shopify); ausente ou fora do padrão, vale o caminho padrão do app.
 */
export function defaultScriptConfig(store: Store, checkoutHosts: string[]): BridgeScriptConfig {
  return {
    proxyPath: isValidProxyPath(store.proxyPath) ? store.proxyPath : DEFAULT_PROXY_PATH,
    checkoutHosts: cleanHosts(checkoutHosts),
    acceleratedButtons: 'hide',
    onError: 'message',
    extraSelectors: [],
    debug: false,
  };
}

/**
 * Código JavaScript do script do tema com a configuração embutida.
 * `opts.test` liga o gancho de testes do script (window.CheckoutBridge.__test); nunca em produção.
 */
export function renderBridgeScript(config: BridgeScriptConfig, opts: { test?: boolean } = {}): string {
  // Os limites de propriedade são do serviço, não do lojista: vão sempre os de
  // src/checkout/limits.ts, os mesmos que src/checkout/schema.ts aplica ao corpo.
  const clean: Record<string, unknown> = { ...sanitizeConfig(config), propertyLimits: { ...PROPERTY_LIMITS } };
  if (opts.test === true) clean['__test'] = true;
  // Função como substituição: uma string com "$&" ou "$1" seria interpretada pelo replace.
  return TEMPLATE.replace(PLACEHOLDER, () => serializeForInlineScript(clean));
}

/** Bloco para colar no theme.liquid, entre comentários que permitem localizá-lo depois. */
export function renderInlineSnippet(config: BridgeScriptConfig): string {
  const script = renderBridgeScript(config);
  return [
    '<!-- checkout-bridge: início (gerado pelo painel; não edite à mão) -->',
    '<script>',
    script,
    '</script>',
    '<!-- checkout-bridge: fim -->',
  ].join('\n');
}

/** Uma linha que carrega o script pelo App Proxy; `defer` mantém o carregamento da página. */
export function renderLoaderSnippet(proxyPath: string): string {
  if (!isValidProxyPath(proxyPath)) {
    throw new Error('checkout-bridge: caminho do App Proxy inválido');
  }
  return `<script src="${proxyPath}/bridge.js" defer></script>`;
}
