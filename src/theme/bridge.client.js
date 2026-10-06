// checkout-bridge: script que roda no navegador do comprador, no tema da vitrine.
//
// Regras deste arquivo (src/theme/render.ts depende delas):
// - Comentários só em linhas inteiras iniciadas por "//": o render as remove antes de servir.
// - Nenhuma string ocupa mais de uma linha e nenhuma linha de código começa com "//".
// - O marcador de configuração aparece exatamente uma vez, na atribuição de RAW logo abaixo.
// - O texto não pode conter fechamento de script, abertura de comentário HTML nem
//   delimitadores de abertura do Liquid: o script também é colado direto no theme.liquid.
// - Textos mostrados ao comprador usam escapes \u para não depender do charset da página.
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var RAW = /*__CONFIG__*/null;
  var win = typeof window === 'undefined' ? null : window;
  if (!win || !RAW || typeof RAW !== 'object') return;
  // Uma instância por página: o lojista pode ter colado o trecho inline e o loader juntos.
  if (win.CheckoutBridge && win.CheckoutBridge.version) return;
  var doc = win.document;
  if (!doc) return;

  function stringList(value) {
    var out = [];
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
      });
    }
    return out;
  }

  // A configuração já chega validada pelo servidor; aqui só se garante que um valor
  // inesperado nunca vira exceção nem caminho de outra origem.
  var cfg = {
    proxyPath: '/apps/checkout-bridge',
    hosts: stringList(RAW.checkoutHosts),
    accelerated: RAW.acceleratedButtons === 'intercept' ? 'intercept' : 'hide',
    onError: RAW.onError === 'native' ? 'native' : 'message',
    extraSelectors: stringList(RAW.extraSelectors),
    debug: RAW.debug === true,
    test: RAW.__test === true
  };
  if (typeof RAW.proxyPath === 'string' && /^(?:\/[A-Za-z0-9_-]+)+$/.test(RAW.proxyPath)) {
    cfg.proxyPath = RAW.proxyPath;
  }
  // Limites de propriedade de linha, os mesmos que o serviço aplica (src/checkout/limits.ts).
  // Os padrões só valem para um trecho inline colado antes de o servidor enviá-los.
  var PROPERTY_LIMIT_DEFAULTS = { maxProperties: 25, maxKeyLength: 100, maxValueLength: 2000 };
  function propertyLimit(name) {
    var given = RAW.propertyLimits && typeof RAW.propertyLimits === 'object' ? RAW.propertyLimits[name] : null;
    return typeof given === 'number' && given >= 1 && given === Math.floor(given) ? given : PROPERTY_LIMIT_DEFAULTS[name];
  }
  cfg.limits = {
    maxProperties: propertyLimit('maxProperties'),
    maxKeyLength: propertyLimit('maxKeyLength'),
    maxValueLength: propertyLimit('maxValueLength')
  };

  var ATTRIBUTION_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid'
  ];
  // Cookies dos pixels (Meta, Google, TikTok) lidos só na hora do checkout. Nenhum cookie da
  // própria Shopify é lido: ela anunciou a remoção deles e não documenta o escopo de domínio.
  var ATTRIBUTION_COOKIES = { _fbp: 'fbp', _fbc: 'fbc', _ga: 'ga', _ttp: 'ttp' };
  var STORAGE_KEY = 'cb_attr';
  // Nonce por navegador (ver getClientNonce); mesmo formato que o serviço aceita.
  var NONCE_KEY = 'cb_nonce';
  var NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var MAX_VALUE_LENGTH = 255;
  var POST_TIMEOUT_MS = 12000;
  var CART_TIMEOUT_MS = 8000;
  // Depois de mandar o navegador para outra página o estado ocupado fica até a página sair;
  // este prazo o solta se a navegação não acontecer (bloqueada ou cancelada pelo comprador).
  var NAVIGATION_RELEASE_MS = 20000;
  var SUBMITTER_MEMORY_MS = 1000;

  // Botões de checkout acelerado. Os de produto compram uma variante; os de carrinho levam o
  // carrinho inteiro. Em qualquer dos casos o pedido nasceria na vitrine.
  var ACCELERATED_PRODUCT = 'shopify-accelerated-checkout,.shopify-payment-button,[data-shopify="payment-button"]';
  var ACCELERATED_CART = 'shopify-accelerated-checkout-cart,.additional-checkout-buttons,#dynamic-checkout-cart';
  var ACCELERATED_HIDE = [
    'shopify-accelerated-checkout', 'shopify-accelerated-checkout-cart', '.shopify-payment-button',
    '[data-shopify="payment-button"]', '.additional-checkout-buttons', '#dynamic-checkout-cart'
  ].join(',');
  // Gatilhos além de name="checkout" e de links para /checkout. Os três primeiros são
  // convenções de atributo; os demais são classes do Dawn/Horizon e de gavetas de carrinho
  // de apps (Upcart, Rebuy) anotadas de memória: precisam de teste em loja real, e o que
  // faltar entra por extraSelectors no painel.
  var TRIGGER_SELECTOR = [
    '[data-action="checkout"]', '[data-checkout-button]', '[data-cart-checkout]',
    '#CartDrawer-Checkout', '.cart__checkout-button',
    '.upcart-checkout-button', '.rebuy-cart__checkout-button'
  ].join(',');
  var GENERIC_MESSAGE = 'N\u00e3o foi poss\u00edvel iniciar o checkout. Tente novamente em instantes.';
  // Uma personaliza\u00e7\u00e3o acima do limite do servi\u00e7o invalidaria a requisi\u00e7\u00e3o inteira; cortar
  // o texto em sil\u00eancio produziria um pedido errado. O comprador recebe o motivo exato.
  var PROPERTY_TOO_LONG = 'cb_property_too_long';
  var PROPERTY_TOO_LONG_MESSAGE =
    'A personaliza\u00e7\u00e3o de um item \u00e9 longa demais para o checkout. Reduza o texto e tente novamente.';
  var CLOSE_LABEL = 'Fechar';

  var state = {
    busy: false,
    control: null,
    restore: null,
    lastControl: null,
    current: null,
    messageBox: null,
    releaseTimer: null,
    extraSelector: '',
    nonce: null
  };

  function debug() {
    if (!cfg.debug) return;
    try {
      var out = win.console;
      if (out && typeof out.log === 'function') {
        out.log.apply(out, ['[checkout-bridge]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (err) {
      return;
    }
  }

  // Todo ponto de entrada passa por aqui: um erro nosso nunca pode quebrar a página da loja.
  function guard(fn, label) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        debug('erro em ' + label, err && err.name);
        return undefined;
      }
    };
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // ---------------------------------------------------------------------------------------
  // Caminhos e elementos
  // ---------------------------------------------------------------------------------------

  // Raiz com o prefixo de idioma/mercado ("/pt-br/"). Só aceita caminho relativo simples:
  // um valor como "//outro.site/" viraria URL de outra origem.
  function root() {
    try {
      var value = win.Shopify && win.Shopify.routes && win.Shopify.routes.root;
      if (typeof value === 'string') {
        if (value.charAt(value.length - 1) !== '/') value += '/';
        if (/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) return value;
      }
    } catch (err) {
      return '/';
    }
    return '/';
  }

  // Pathname resolvido, sem barra final, ou null quando a URL é de outra origem ou inválida.
  function resolvePath(raw) {
    try {
      var url = new win.URL(raw, doc.baseURI || win.location.href);
      if (url.origin !== win.location.origin) return null;
      return url.pathname.replace(/\/+$/, '');
    } catch (err) {
      return null;
    }
  }

  // Prefixo de idioma/mercado da Shopify ("/fr/", "/pt-br/", "/en-ca/"): o único segmento
  // que a loja coloca antes de /cart e /checkout. Conteúdo fica em /pages, /collections,
  // /products, /blogs, nunca num segmento de duas ou três letras.
  var LOCALE_PREFIX_RE = /^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})?\//;

  // Comparação exata com a rota da loja: sem prefixo ("/checkout"), com o prefixo de
  // Shopify.routes.root ("/pt-br/checkout") ou com outro prefixo de idioma ("/en/checkout"
  // numa página em /pt-br/). Comparar só o fim do caminho trataria /pages/checkout ou
  // /collections/cart (conteúdo da loja) como gatilho; o nosso endpoint
  // "/apps/checkout-bridge/checkout" também nunca é igual à rota.
  function isRoute(path, name) {
    if (typeof path !== 'string') return false;
    var lower = path.toLowerCase();
    var bare = '/' + name;
    if (lower === bare || lower === (root() + name).toLowerCase()) return true;
    var match = LOCALE_PREFIX_RE.exec(lower);
    return !!match && lower.slice(match[0].length - 1) === bare;
  }

  function isCheckoutPath(path) {
    return isRoute(path, 'checkout');
  }

  function isElement(node) {
    return !!node && node.nodeType === 1 && typeof node.getAttribute === 'function';
  }

  function tagOf(el) {
    return String(el.tagName || '').toUpperCase();
  }

  function attr(el, name) {
    try {
      return el.getAttribute(name);
    } catch (err) {
      return null;
    }
  }

  // Seletor vindo da configuração pode ser inválido; matches() lançaria SyntaxError.
  function matches(el, selector) {
    try {
      return typeof el.matches === 'function' && el.matches(selector) === true;
    } catch (err) {
      return false;
    }
  }

  function closest(el, selector) {
    try {
      return typeof el.closest === 'function' ? el.closest(selector) : null;
    } catch (err) {
      return null;
    }
  }

  // No Dawn e no Horizon o botão fica FORA do form e é ligado pelo atributo form="...":
  // a propriedade .form resolve isso; closest() cobre elementos que não são controles.
  function formOf(el) {
    var form = null;
    try {
      form = el.form || null;
    } catch (err) {
      form = null;
    }
    if (!isElement(form) || tagOf(form) !== 'FORM') form = closest(el, 'form');
    return isElement(form) && tagOf(form) === 'FORM' ? form : null;
  }

  // getAttribute em vez de form.action: um input chamado "action" esconde a propriedade.
  function actionPath(form, submitter) {
    var raw = submitter ? attr(submitter, 'formaction') : null;
    if (raw === null || raw === '') raw = attr(form, 'action');
    return resolvePath(raw === null ? '' : raw);
  }

  function isCartForm(form) {
    return isRoute(actionPath(form, null), 'cart');
  }

  function isCheckoutControl(el) {
    if (attr(el, 'name') !== 'checkout') return false;
    var tag = tagOf(el);
    if (tag === 'BUTTON') return true;
    if (tag !== 'INPUT') return false;
    var type = String(attr(el, 'type') || '').toLowerCase();
    return type === 'submit' || type === 'image' || type === 'button';
  }

  function isCheckoutLink(el) {
    var tag = tagOf(el);
    if (tag !== 'A' && tag !== 'AREA') return false;
    var href = attr(el, 'href');
    if (href === null || href === '') return false;
    return isCheckoutPath(resolvePath(href));
  }

  // ---------------------------------------------------------------------------------------
  // Atribuição e consentimento
  // ---------------------------------------------------------------------------------------

  function cleanValue(value, max) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max || MAX_VALUE_LENGTH);
  }

  // Devolve só chaves conhecidas; o que estiver vencido ou fora do formato é descartado.
  function readStoredAttribution() {
    try {
      var raw = win.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var valid = parsed && typeof parsed.t === 'number' && parsed.v && typeof parsed.v === 'object';
      if (!valid || Date.now() - parsed.t > ATTRIBUTION_TTL_MS) {
        win.localStorage.removeItem(STORAGE_KEY);
        return {};
      }
      var out = {};
      ATTRIBUTION_PARAMS.forEach(function (key) {
        var value = cleanValue(parsed.v[key]);
        if (value) out[key] = value;
      });
      return out;
    } catch (err) {
      return {};
    }
  }

  // Parâmetros da URL de entrada guardados por 30 dias e mesclados com os anteriores: o
  // comprador pode chegar por um anúncio hoje e comprar amanhã vindo de outro lugar.
  function captureAttribution() {
    var params = new win.URLSearchParams(win.location.search || '');
    var found = {};
    var any = false;
    ATTRIBUTION_PARAMS.forEach(function (key) {
      var value = cleanValue(params.get(key));
      if (value) {
        found[key] = value;
        any = true;
      }
    });
    if (!any) return;
    try {
      var merged = readStoredAttribution();
      for (var key in found) {
        if (hasOwn(found, key)) merged[key] = found[key];
      }
      win.localStorage.setItem(STORAGE_KEY, JSON.stringify({ t: Date.now(), v: merged }));
    } catch (err) {
      debug('armazenamento indisponivel');
    }
  }

  function readAttributionCookies() {
    var out = {};
    try {
      var parts = String(doc.cookie || '').split(';');
      for (var i = 0; i < parts.length; i += 1) {
        var eq = parts[i].indexOf('=');
        if (eq === -1) continue;
        var name = parts[i].slice(0, eq).trim();
        if (!hasOwn(ATTRIBUTION_COOKIES, name)) continue;
        var value = parts[i].slice(eq + 1).trim();
        try {
          value = decodeURIComponent(value);
        } catch (err) {
          value = '';
        }
        value = cleanValue(value);
        if (value) out[ATTRIBUTION_COOKIES[name]] = value;
      }
    } catch (err) {
      return out;
    }
    return out;
  }

  function collectAttribution() {
    var out = readStoredAttribution();
    var cookies = readAttributionCookies();
    for (var key in cookies) {
      if (hasOwn(cookies, key)) out[key] = cookies[key];
    }
    return out;
  }

  // Customer Privacy API da vitrine. Sem os quatro métodos não se afirma consentimento
  // nenhum: o servidor trata ausência como "não informado".
  function readConsent() {
    try {
      var api = win.Shopify && win.Shopify.customerPrivacy;
      if (!api) return null;
      var methods = {
        analytics: 'analyticsProcessingAllowed',
        marketing: 'marketingAllowed',
        preferences: 'preferencesProcessingAllowed',
        saleOfData: 'saleOfDataAllowed'
      };
      var out = {};
      for (var key in methods) {
        if (!hasOwn(methods, key)) continue;
        if (typeof api[methods[key]] !== 'function') return null;
        out[key] = api[methods[key]]() === true;
      }
      return out;
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Nonce do navegador: identificador aleatório gerado uma vez por aba e enviado em toda
  // requisição de checkout. O serviço só o usa na idempotência da compra direta (sem token
  // de carrinho), para dois navegadores atrás do mesmo IP não dividirem um checkout. Não
  // identifica o comprador e não vai para nenhum outro lugar.
  // ---------------------------------------------------------------------------------------

  function randomNonce() {
    var c = win.crypto;
    try {
      if (c && typeof c.randomUUID === 'function') {
        var uuid = String(c.randomUUID());
        if (NONCE_RE.test(uuid)) return uuid;
      }
      if (c && typeof c.getRandomValues === 'function') {
        var bytes = c.getRandomValues(new Uint8Array(16));
        var hex = '';
        for (var i = 0; i < bytes.length; i += 1) hex += (bytes[i] + 256).toString(16).slice(1);
        if (NONCE_RE.test(hex)) return hex;
      }
    } catch (err) {
      debug('crypto indisponivel');
    }
    // Sem Web Crypto (navegador muito antigo): o nonce não é segredo, só separa escopos.
    var out = '';
    while (out.length < 32) out += Math.random().toString(36).slice(2);
    return out.slice(0, 32);
  }

  // Fica em sessionStorage para sobreviver à navegação entre páginas; sem armazenamento
  // (modo privado, bloqueio de cookies) vale só na memória da página.
  function getClientNonce() {
    if (state.nonce) return state.nonce;
    var stored = null;
    try {
      stored = win.sessionStorage.getItem(NONCE_KEY);
    } catch (err) {
      stored = null;
    }
    state.nonce = typeof stored === 'string' && NONCE_RE.test(stored) ? stored : randomNonce();
    if (state.nonce !== stored) {
      try {
        win.sessionStorage.setItem(NONCE_KEY, state.nonce);
      } catch (err) {
        debug('armazenamento indisponivel');
      }
    }
    return state.nonce;
  }

  // ---------------------------------------------------------------------------------------
  // Carga enviada ao serviço. Só variante e quantidade descrevem o item: preço, nunca.
  // ---------------------------------------------------------------------------------------

  function basePayload(source, lines) {
    var payload = { lines: lines, source: source };
    var shopify = win.Shopify || {};
    if (typeof shopify.country === 'string' && /^[A-Za-z]{2}$/.test(shopify.country)) {
      payload.country = shopify.country.toUpperCase();
    }
    if (typeof shopify.locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(shopify.locale)) {
      payload.language = shopify.locale;
    }
    var attribution = collectAttribution();
    for (var key in attribution) {
      if (hasOwn(attribution, key)) {
        payload.attribution = attribution;
        break;
      }
    }
    var consent = readConsent();
    if (consent) payload.consent = consent;
    return payload;
  }

  function propertyTooLong() {
    var err = new Error(PROPERTY_TOO_LONG_MESSAGE);
    err.name = PROPERTY_TOO_LONG;
    return err;
  }

  function isPropertyTooLong(err) {
    return !!err && err.name === PROPERTY_TOO_LONG;
  }

  // Propriedades "__x" são privadas da Shopify e não saem do carrinho; valores nulos e
  // vazios são descartados como o próprio tema faz com campos opcionais em branco. Os
  // limites são os do serviço: chave longa demais é ignorada, a contagem para no máximo e
  // um valor longo demais interrompe o fluxo (o texto é do comprador; não se corta).
  function cleanProperties(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {};
    var count = 0;
    for (var key in raw) {
      if (!hasOwn(raw, key) || key === '' || key.indexOf('__') === 0 || key.length > cfg.limits.maxKeyLength) continue;
      var value = raw[key];
      var type = typeof value;
      if (value === null || (type !== 'string' && type !== 'number' && type !== 'boolean')) continue;
      var text = String(value);
      if (text === '') continue;
      if (text.length > cfg.limits.maxValueLength) throw propertyTooLong();
      if (count >= cfg.limits.maxProperties) continue;
      out[key] = text;
      count += 1;
    }
    return count > 0 ? out : null;
  }

  // items[].id é igual ao variant_id no carrinho e não identifica a linha; o que importa
  // é variant_id + quantity. selling_plan_allocation só existe em linha com assinatura.
  function cartLines(cart) {
    var lines = [];
    var items = cart && Array.isArray(cart.items) ? cart.items : [];
    items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = item.variant_id !== undefined && item.variant_id !== null ? item.variant_id : item.id;
      var quantity = Number(item.quantity);
      if (id === undefined || id === null || !(quantity >= 1)) return;
      var line = { variantId: String(id), quantity: Math.floor(quantity) };
      var properties = cleanProperties(item.properties);
      if (properties) line.properties = properties;
      if (item.selling_plan_allocation) line.hasSellingPlan = true;
      lines.push(line);
    });
    return lines;
  }

  // Cupons que o carrinho da vitrine diz aplicáveis. discount_codes[] aparece na resposta
  // de cart/update.js com "discount"; os discount_applications são a forma documentada no
  // objeto cart. Qual dos dois a loja devolve em cada caso precisa de teste em loja real.
  function cartDiscountCodes(cart) {
    var seen = Object.create(null);
    var out = [];
    function add(code) {
      if (typeof code !== 'string') return;
      code = code.trim();
      var folded = code.toLowerCase();
      if (!code || code.length > 64 || code.indexOf(',') !== -1 || seen[folded]) return;
      seen[folded] = true;
      out.push(code);
    }
    function fromApplications(list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (application) {
        if (application && application.type === 'discount_code') add(application.title);
      });
    }
    if (Array.isArray(cart.discount_codes)) {
      cart.discount_codes.forEach(function (entry) {
        if (entry && entry.applicable === true) add(entry.code);
      });
    }
    fromApplications(cart.cart_level_discount_applications);
    (Array.isArray(cart.items) ? cart.items : []).forEach(function (item) {
      if (!item || !Array.isArray(item.line_level_discount_allocations)) return;
      item.line_level_discount_allocations.forEach(function (allocation) {
        if (allocation) fromApplications([allocation.discount_application]);
      });
    });
    // O serviço aceita no máximo cinco códigos; um sexto invalidaria o pedido inteiro.
    return out.slice(0, 5);
  }

  function buildCartPayload(cart) {
    var payload = basePayload('cart', cartLines(cart));
    if (typeof cart.token === 'string' && cart.token !== '') {
      // O token vem como "<token>?key=<segredo>"; a chave do carrinho não sai do navegador.
      var token = cart.token.split('?')[0].trim();
      if (token) payload.cartToken = token.slice(0, 200);
    }
    var codes = cartDiscountCodes(cart);
    if (codes.length) payload.discountCodes = codes;
    return payload;
  }

  // Compra direta: dados do form de produto. Os controles podem estar fora do form, ligados
  // por form="..." (Dawn faz isso com a quantidade), por isso form.elements vem primeiro.
  function controlsOf(form) {
    var out = [];
    function add(list) {
      try {
        for (var i = 0; i < list.length; i += 1) {
          if (isElement(list[i]) && out.indexOf(list[i]) === -1) out.push(list[i]);
        }
      } catch (err) {
        return;
      }
    }
    try {
      if (form.elements) add(form.elements);
    } catch (err) {
      out.length = 0;
    }
    try {
      add(form.querySelectorAll('[name]'));
    } catch (err) {
      return out;
    }
    return out;
  }

  // Mesma regra do envio nativo: controle desligado, caixa desmarcada e arquivo não contam.
  function formFields(form, name) {
    return controlsOf(form).filter(function (el) {
      if (attr(el, 'name') !== name || el.disabled === true) return false;
      var type = String(attr(el, 'type') || '').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && el.checked !== true) return false;
      return type !== 'file';
    });
  }

  function fieldValue(form, name) {
    var fields = formFields(form, name);
    if (!fields.length) return '';
    var value = fields[0].value;
    if (value === undefined || value === null) value = attr(fields[0], 'value') || '';
    return String(value);
  }

  function readBuyNowLine(form) {
    var variantId = fieldValue(form, 'id').trim();
    if (!/^[1-9][0-9]{0,19}$/.test(variantId)) return null;
    var quantity = parseInt(fieldValue(form, 'quantity'), 10);
    if (!(quantity >= 1)) quantity = 1;
    var line = { variantId: variantId, quantity: quantity };
    var properties = {};
    var count = 0;
    var names = [];
    controlsOf(form).forEach(function (el) {
      var name = attr(el, 'name') || '';
      var match = /^properties\[(.+)\]$/.exec(name);
      if (!match || match[1].indexOf('__') === 0 || names.indexOf(name) !== -1) return;
      names.push(name);
      if (match[1].length > cfg.limits.maxKeyLength) return;
      var value = fieldValue(form, name);
      if (value === '') return;
      if (value.length > cfg.limits.maxValueLength) throw propertyTooLong();
      if (count >= cfg.limits.maxProperties) return;
      properties[match[1]] = value;
      count += 1;
    });
    if (count > 0) line.properties = properties;
    if (fieldValue(form, 'selling_plan').trim() !== '') line.hasSellingPlan = true;
    return line;
  }

  // ---------------------------------------------------------------------------------------
  // Rede
  // ---------------------------------------------------------------------------------------

  // Corrida entre a operação e um prazo. O prazo também aborta a requisição; a corrida
  // garante o resultado mesmo quando o fetch ignora o sinal (ou a leitura do corpo trava).
  function withTimeout(run, ms) {
    return new Promise(function (resolve, reject) {
      var controller = null;
      try {
        controller = new win.AbortController();
      } catch (err) {
        controller = null;
      }
      var settled = false;
      var timer = win.setTimeout(function () {
        if (settled) return;
        settled = true;
        try {
          if (controller) controller.abort();
        } catch (err) {
          debug('abort falhou');
        }
        reject(new Error('timeout'));
      }, ms);
      function finish(ok, value) {
        if (settled) return;
        settled = true;
        win.clearTimeout(timer);
        if (ok) resolve(value);
        else reject(value);
      }
      Promise.resolve()
        .then(function () {
          return run(controller ? controller.signal : undefined);
        })
        .then(
          function (value) {
            finish(true, value);
          },
          function (err) {
            finish(false, err);
          }
        );
    });
  }

  // Só o que o POST nativo para /cart interpreta: quantidades, nota e atributos. Qualquer
  // outro campo do form (um "discount" em branco, por exemplo) é ignorado pelo envio nativo
  // mas seria aplicado por cart/update.js, e poderia apagar um cupom já no carrinho.
  var CART_FIELD_RE = /^(?:note|attributes\[[^\]]*\]|updates\[[^\]]*\])$/;
  function cartFormData(form) {
    var source = new win.FormData(form);
    var data = new win.FormData();
    var any = false;
    source.forEach(function (value, key) {
      if (typeof value !== 'string' || !CART_FIELD_RE.test(key)) return;
      data.append(key, value);
      any = true;
    });
    return any ? data : null;
  }

  // Interceptar o submit pula o POST nativo para /cart, que é o que salva quantidade, nota e
  // atributos editados. Enviar esses campos para cart/update.js preserva isso. Falha é
  // ignorada: cart.js devolve o estado real logo em seguida.
  function saveCartForm(form) {
    return withTimeout(function (signal) {
      var data = cartFormData(form);
      if (!data) return null;
      return win.fetch(root() + 'cart/update.js', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        body: data,
        signal: signal
      });
    }, CART_TIMEOUT_MS).then(
      function () {
        return undefined;
      },
      function () {
        debug('cart/update.js falhou');
        return undefined;
      }
    );
  }

  function fetchCart() {
    return withTimeout(function (signal) {
      return win
        .fetch(root() + 'cart.js', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: signal
        })
        .then(function (res) {
          if (!res || res.status !== 200) throw new Error('cart status');
          return res.json();
        })
        .then(function (cart) {
          if (!cart || typeof cart !== 'object' || !Array.isArray(cart.items)) throw new Error('cart shape');
          return cart;
        });
    }, CART_TIMEOUT_MS);
  }

  function isCheckoutUrl(value) {
    if (typeof value !== 'string' || value === '' || value.length > 4096) return false;
    try {
      var url = new win.URL(value);
      return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
    } catch (err) {
      return false;
    }
  }

  // Mesma origem, sem query string própria (a assinatura do App Proxy cobre a query e as duas
  // implementações de referência da Shopify ordenam parâmetros de jeitos diferentes).
  // Só 200 com JSON { ok: true, checkoutUrl https } vale; redirecionamento, HTML (página de
  // senha, erro do proxy) ou qualquer outro corpo é falha.
  function postCheckout(payload) {
    payload.clientNonce = getClientNonce();
    return withTimeout(function (signal) {
      return win
        .fetch(cfg.proxyPath + '/checkout', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: signal
        })
        .then(function (res) {
          if (!res || res.status !== 200 || res.redirected === true) return null;
          return res.json();
        });
    }, POST_TIMEOUT_MS).then(
      function (data) {
        if (!data || typeof data !== 'object') return { ok: false, message: null };
        if (data.ok === true && isCheckoutUrl(data.checkoutUrl)) return { ok: true, url: data.checkoutUrl };
        var message = data.ok === false ? cleanValue(data.message, 300) : '';
        return { ok: false, message: message || null };
      },
      function (err) {
        debug('checkout falhou', err && err.message);
        return { ok: false, message: null };
      }
    );
  }

  // ---------------------------------------------------------------------------------------
  // Estado ocupado, navegação e mensagem
  // ---------------------------------------------------------------------------------------

  function setBusy(control) {
    state.busy = true;
    try {
      doc.documentElement.classList.add('cb-busy');
    } catch (err) {
      debug('classe busy');
    }
    if (!isElement(control)) return;
    state.control = control;
    state.restore = {
      ariaBusy: attr(control, 'aria-busy'),
      ariaDisabled: attr(control, 'aria-disabled'),
      hasDisabled: 'disabled' in control,
      disabled: control.disabled === true
    };
    try {
      control.setAttribute('aria-busy', 'true');
      if (state.restore.hasDisabled) control.disabled = true;
      else control.setAttribute('aria-disabled', 'true');
    } catch (err) {
      debug('controle busy');
    }
  }

  function release() {
    state.busy = false;
    if (state.releaseTimer !== null) {
      win.clearTimeout(state.releaseTimer);
      state.releaseTimer = null;
    }
    try {
      doc.documentElement.classList.remove('cb-busy');
    } catch (err) {
      debug('classe busy');
    }
    var control = state.control;
    var restore = state.restore;
    state.control = null;
    state.restore = null;
    if (!control || !restore) return;
    try {
      if (restore.ariaBusy === null) control.removeAttribute('aria-busy');
      else control.setAttribute('aria-busy', restore.ariaBusy);
      if (restore.hasDisabled) control.disabled = restore.disabled;
      else if (restore.ariaDisabled === null) control.removeAttribute('aria-disabled');
      else control.setAttribute('aria-disabled', restore.ariaDisabled);
    } catch (err) {
      debug('restaurar controle');
    }
  }

  // O estado ocupado segue até a página sair. Voltar do checkout pelo histórico pode
  // restaurar a página do bfcache com o botão ainda travado: pageshow (persisted) solta.
  function navigate(url) {
    if (state.releaseTimer !== null) win.clearTimeout(state.releaseTimer);
    state.releaseTimer = win.setTimeout(guard(release, 'release'), NAVIGATION_RELEASE_MS);
    try {
      win.location.assign(url);
    } catch (err) {
      release();
    }
  }

  function hideMessage() {
    var box = state.messageBox;
    state.messageBox = null;
    if (!box) return;
    try {
      if (box.parentNode) box.parentNode.removeChild(box);
    } catch (err) {
      debug('remover mensagem');
    }
  }

  // Texto sempre via textContent: a mensagem vem do servidor, mas nunca vira HTML.
  function showMessage(text) {
    hideMessage();
    var box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.setAttribute('data-checkout-bridge', 'message');
    box.style.cssText =
      'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:480px;margin:0 auto;' +
      'padding:14px 44px 14px 16px;background:#1f2937;color:#fff;font:14px/1.45 system-ui,-apple-system,sans-serif;' +
      'border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);box-sizing:border-box';
    var span = doc.createElement('span');
    span.textContent = text || GENERIC_MESSAGE;
    var close = doc.createElement('button');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', CLOSE_LABEL);
    close.textContent = '\u00d7';
    close.style.cssText =
      'position:absolute;top:6px;right:8px;width:32px;height:32px;border:0;background:transparent;color:#fff;' +
      'font:22px/1 system-ui,sans-serif;cursor:pointer';
    close.addEventListener('click', guard(hideMessage, 'fechar'));
    box.appendChild(span);
    box.appendChild(close);
    state.messageBox = box;
    (doc.body || doc.documentElement).appendChild(box);
  }

  // ---------------------------------------------------------------------------------------
  // Fluxos
  // ---------------------------------------------------------------------------------------

  // 'native' só vale para o checkout do carrinho: na compra direta o item não está no
  // carrinho, então o checkout nativo da vitrine não teria o que cobrar.
  function failed(source, message) {
    if (cfg.onError === 'native' && source === 'cart') {
      navigate(root() + 'checkout');
      return;
    }
    release();
    showMessage(message);
  }

  function settle(answer, source) {
    if (answer.ok) {
      navigate(answer.url);
      return true;
    }
    failed(source, answer.message);
    return false;
  }

  function finishRun(promise, source) {
    state.current = promise.then(
      function (value) {
        return value === true;
      },
      function (err) {
        debug('fluxo falhou', err && err.name);
        try {
          failed(source, isPropertyTooLong(err) ? PROPERTY_TOO_LONG_MESSAGE : null);
        } catch (inner) {
          release();
        }
        return false;
      }
    );
    return state.current;
  }

  function runCartCheckout(control, form) {
    if (state.busy) return state.current || Promise.resolve(false);
    hideMessage();
    setBusy(control);
    var saved = form && isCartForm(form) ? saveCartForm(form) : Promise.resolve();
    return finishRun(
      saved
        .then(fetchCart)
        .then(function (cart) {
          if (cart.items.length === 0) {
            navigate(root() + 'cart');
            return false;
          }
          var payload = buildCartPayload(cart);
          if (payload.lines.length === 0) throw new Error('sem linhas');
          return postCheckout(payload).then(function (answer) {
            return settle(answer, 'cart');
          });
        }),
      'cart'
    );
  }

  function runBuyNow(form, control) {
    if (state.busy) return state.current || Promise.resolve(false);
    hideMessage();
    var line = null;
    try {
      line = form ? readBuyNowLine(form) : null;
    } catch (err) {
      showMessage(isPropertyTooLong(err) ? PROPERTY_TOO_LONG_MESSAGE : null);
      return Promise.resolve(false);
    }
    if (!line) {
      showMessage(null);
      return Promise.resolve(false);
    }
    setBusy(control);
    return finishRun(
      postCheckout(basePayload('buy_now', [line])).then(function (answer) {
        return settle(answer, 'buy_now');
      }),
      'buy_now'
    );
  }

  // ---------------------------------------------------------------------------------------
  // Interceptação
  // ---------------------------------------------------------------------------------------

  function cancel(event) {
    try {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    } catch (err) {
      debug('cancelar evento');
    }
  }

  // composedPath() enxerga o alvo dentro de shadow DOM aberto e chega até o host de um
  // fechado. Sem ele, sobe pelos pais a partir do alvo.
  function pathOf(event) {
    var path = null;
    try {
      if (typeof event.composedPath === 'function') path = event.composedPath();
    } catch (err) {
      path = null;
    }
    if (!path || !path.length) {
      path = [];
      var node = event.target;
      while (node) {
        path.push(node);
        node = node.parentNode;
      }
    }
    return path;
  }

  // Classifica o primeiro elemento do caminho (do alvo para fora) que é um gatilho.
  function findTrigger(path) {
    for (var i = 0; i < path.length; i += 1) {
      var el = path[i];
      if (!isElement(el)) continue;
      if (matches(el, ACCELERATED_PRODUCT)) return { kind: 'buy_now', el: el };
      if (matches(el, ACCELERATED_CART)) return { kind: 'accelerated_cart', el: el };
      if (isCheckoutLink(el)) return { kind: 'link', el: el };
      if (isCheckoutControl(el)) return { kind: 'control', el: el };
      if (matches(el, TRIGGER_SELECTOR)) return { kind: 'custom', el: el };
      if (state.extraSelector && matches(el, state.extraSelector)) return { kind: 'custom', el: el };
    }
    return null;
  }

  // Validação nativa (required, pattern) que o submit faria; sem ela um "aceito os termos"
  // obrigatório seria pulado. Não substitui validações feitas em JavaScript pelo tema.
  function passesNativeValidation(form, control) {
    try {
      if (form.noValidate === true || control.formNoValidate === true) return true;
      if (attr(form, 'novalidate') !== null || attr(control, 'formnovalidate') !== null) return true;
      if (typeof form.reportValidity === 'function') return form.reportValidity() !== false;
    } catch (err) {
      return true;
    }
    return true;
  }

  function productFormFor(el) {
    var form = closest(el, 'form');
    if (form && isRoute(actionPath(form, null), 'cart/add')) return form;
    try {
      return doc.querySelector('form[action*="/cart/add"]');
    } catch (err) {
      return form;
    }
  }

  function onClick(event) {
    var found = findTrigger(pathOf(event));
    if (!found) return;
    // Botão do meio em link de checkout abriria o checkout nativo em outra aba.
    if (event.type === 'auxclick' && (found.kind !== 'link' || event.button !== 1)) return;
    var el = found.el;
    var form = null;
    if (found.kind === 'control') {
      form = formOf(el);
      state.lastControl = { el: el, form: form, at: Date.now() };
      if (!state.busy && form && !passesNativeValidation(form, el)) {
        cancel(event);
        return;
      }
    }
    cancel(event);
    if (state.busy) return;
    if (found.kind === 'buy_now') {
      runBuyNow(productFormFor(el), null);
      return;
    }
    if (found.kind === 'accelerated_cart') {
      runCartCheckout(null, null);
      return;
    }
    runCartCheckout(el, form || formOf(el));
  }

  // Form para /cart só é checkout quando quem enviou se chama "checkout" (o Horizon tem um
  // segundo form de carrinho, o de parcelamento, sem esse botão). Form para /checkout é
  // checkout sempre. Qualquer outro envio (atualizar carrinho, adicionar item) segue nativo.
  function onSubmit(event) {
    var form = event.target;
    if (!isElement(form) || tagOf(form) !== 'FORM') return;
    var submitter = isElement(event.submitter) ? event.submitter : null;
    var path = actionPath(form, submitter);
    var hit = false;
    if (isCheckoutPath(path)) {
      hit = true;
    } else if (isRoute(path, 'cart')) {
      var control = submitter;
      if (!control) {
        var last = state.lastControl;
        if (last && Date.now() - last.at <= SUBMITTER_MEMORY_MS && (last.form === form || last.form === null)) {
          control = last.el;
        }
      }
      if (control && attr(control, 'name') === 'checkout') {
        hit = true;
        submitter = control;
      }
    }
    if (!hit) return;
    cancel(event);
    if (state.busy) return;
    runCartCheckout(submitter, form);
  }

  // form.submit() não dispara evento submit. A exceção estreita: só forms cujo action
  // termina em /checkout passam pela ponte; qualquer outro vai para a função original.
  function wrapFormSubmit() {
    var ctor = win.HTMLFormElement;
    var proto = ctor && ctor.prototype;
    if (!proto || typeof proto.submit !== 'function') return;
    var original = proto.submit;
    proto.submit = function submit() {
      var handled = false;
      try {
        if (isElement(this) && tagOf(this) === 'FORM' && isCheckoutPath(actionPath(this, null))) {
          handled = true;
          if (!state.busy) runCartCheckout(null, null);
        }
      } catch (err) {
        debug('submit programatico', err && err.name);
        handled = cfg.onError !== 'native';
      }
      if (handled) return undefined;
      return original.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------------------
  // Preparação da página
  // ---------------------------------------------------------------------------------------

  function preconnect() {
    var head = doc.head || doc.documentElement;
    if (!head) return;
    cfg.hosts.slice(0, 8).forEach(function (host) {
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) return;
      var link = doc.createElement('link');
      link.setAttribute('rel', 'preconnect');
      link.setAttribute('href', 'https://' + host.toLowerCase());
      head.appendChild(link);
    });
  }

  // Um único elemento de estilo. Os botões ficam escondidos em vez de interceptados porque
  // rodam em shadow DOM fechado e não têm API para cancelar o checkout que iniciam.
  function hideAccelerated() {
    var style = doc.createElement('style');
    style.setAttribute('data-checkout-bridge', 'accelerated');
    style.textContent = ACCELERATED_HIDE + '{display:none!important}';
    (doc.head || doc.documentElement).appendChild(style);
  }

  // Seletor inválido derrubaria a lista inteira num matches() combinado: cada um é testado
  // sozinho antes, e os válidos viram um seletor só (uma chamada por elemento do caminho).
  function prepareExtraSelectors() {
    var valid = [];
    cfg.extraSelectors.slice(0, 20).forEach(function (selector) {
      try {
        doc.querySelector(selector);
        valid.push(selector);
      } catch (err) {
        debug('seletor invalido ignorado');
      }
    });
    state.extraSelector = valid.join(',');
  }

  function onPageShow(event) {
    if (event && event.persisted === true) release();
  }

  function start() {
    var steps = [
      ['attribution', captureAttribution],
      ['preconnect', preconnect],
      ['selectors', prepareExtraSelectors],
      ['accelerated', function () {
        if (cfg.accelerated === 'hide') hideAccelerated();
      }],
      ['listeners', function () {
        win.addEventListener('click', guard(onClick, 'click'), true);
        win.addEventListener('auxclick', guard(onClick, 'auxclick'), true);
        win.addEventListener('submit', guard(onSubmit, 'submit'), true);
        win.addEventListener('pageshow', guard(onPageShow, 'pageshow'), false);
      }],
      ['submit', wrapFormSubmit]
    ];
    steps.forEach(function (step) {
      guard(step[1], step[0])();
    });
  }

  var api = {
    version: VERSION,
    checkout: function () {
      try {
        return runCartCheckout(null, null);
      } catch (err) {
        debug('checkout()', err && err.name);
        return Promise.resolve(false);
      }
    }
  };
  if (cfg.test) {
    api.__test = {
      config: cfg,
      state: state,
      root: root,
      resolvePath: resolvePath,
      isCheckoutPath: isCheckoutPath,
      isCheckoutUrl: isCheckoutUrl,
      captureAttribution: captureAttribution,
      readStoredAttribution: readStoredAttribution,
      collectAttribution: collectAttribution,
      readConsent: readConsent,
      buildCartPayload: buildCartPayload,
      cartLines: cartLines,
      cartDiscountCodes: cartDiscountCodes,
      readBuyNowLine: readBuyNowLine,
      getClientNonce: getClientNonce,
      findTrigger: findTrigger,
      release: release,
      whenIdle: function () {
        return state.current || Promise.resolve(false);
      }
    };
  }
  win.CheckoutBridge = api;
  guard(start, 'start')();
})();
