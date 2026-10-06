import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { PROPERTY_LIMITS } from '../src/checkout/limits.ts';
import { parseCheckoutBody } from '../src/checkout/schema.ts';
import { renderBridgeScript } from '../src/theme/render.ts';
import type { BridgeScriptConfig } from '../src/theme/render.ts';

/**
 * Testes do script do navegador (src/theme/bridge.client.js) rodando em node:vm sobre um
 * DOM falso, escrito à mão e mínimo: elementos com atributos, um motor de seletores simples
 * (tag, #id, .classe, [attr], [attr="v"], [attr*="v"], [attr^="v"], listas com vírgula),
 * forms com controles ligados por form="...", eventos com composedPath, fetch e timers
 * controlados. Nada de rede nem de espera real.
 */

// ---------------------------------------------------------------------------------------
// DOM falso
// ---------------------------------------------------------------------------------------

const CONTROL_TAGS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
const SIMPLE_RE = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:[*^$]?="[^"\]]*")?\])*)$/;
const PART_RE = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?)="([^"\]]*)")?\]/g;

type Simple = { tag: string | null; parts: RegExpMatchArray[] };

function parseSelector(selector: string): Simple[] {
  return selector.split(',').map((piece) => {
    const trimmed = piece.trim();
    const match = SIMPLE_RE.exec(trimmed);
    if (trimmed === '' || !match) throw new SyntaxError(`seletor inválido no DOM falso: ${selector}`);
    return { tag: match[1] ?? null, parts: [...(match[2] ?? '').matchAll(PART_RE)] };
  });
}

class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | FakeDocument | null = null;
  readonly childNodes: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners: Array<{ type: string; fn: (event: FakeEvent) => void }> = [];
  style = { cssText: '' };
  textContent = '';
  value: string | undefined;
  checked = false;
  disabled?: boolean;
  readonly ownerDocument: FakeDocument;
  readonly tagName: string;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    if (CONTROL_TAGS.has(tagName)) this.disabled = false;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  get classList(): { add(name: string): void; remove(name: string): void; contains(name: string): boolean } {
    const read = (): string[] => (this.getAttribute('class') ?? '').split(/\s+/).filter((c) => c !== '');
    const write = (classes: string[]): void => this.setAttribute('class', classes.join(' '));
    return {
      add: (name) => {
        const classes = read();
        if (!classes.includes(name)) write([...classes, name]);
      },
      remove: (name) => write(read().filter((c) => c !== name)),
      contains: (name) => read().includes(name),
    };
  }
  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: FakeElement): void {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
  }
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.childNodes) out.push(child, ...child.descendants());
    return out;
  }
  matchesSimple(simple: Simple): boolean {
    if (simple.tag !== null && simple.tag.toUpperCase() !== this.tagName) return false;
    for (const part of simple.parts) {
      if (part[1] !== undefined) {
        if (this.id !== part[1]) return false;
      } else if (part[2] !== undefined) {
        if (!this.classList.contains(part[2])) return false;
      } else if (part[3] !== undefined) {
        const actual = this.getAttribute(part[3]);
        if (actual === null) return false;
        const expected = part[5];
        if (expected === undefined) continue;
        const op = part[4] ?? '';
        if (op === '' && actual !== expected) return false;
        if (op === '*' && !actual.includes(expected)) return false;
        if (op === '^' && !actual.startsWith(expected)) return false;
        if (op === '$' && !actual.endsWith(expected)) return false;
      }
    }
    return true;
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some((simple) => this.matchesSimple(simple));
  }
  closest(selector: string): FakeElement | null {
    const simples = parseSelector(selector);
    let node: FakeElement | FakeDocument | null = this;
    while (node instanceof FakeElement) {
      if (simples.some((simple) => (node as FakeElement).matchesSimple(simple))) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const simples = parseSelector(selector);
    return this.descendants().filter((el) => simples.some((simple) => el.matchesSimple(simple)));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** Dono do form como no DOM: atributo form="id" primeiro, senão o ancestral FORM. */
  get form(): FakeElement | null {
    const ref = this.getAttribute('form');
    if (ref !== null) {
      const target = this.ownerDocument.getElementById(ref);
      return target instanceof FakeForm ? target : null;
    }
    let node = this.parentNode;
    while (node instanceof FakeElement) {
      if (node instanceof FakeForm) return node;
      node = node.parentNode;
    }
    return null;
  }
  addEventListener(type: string, fn: (event: FakeEvent) => void): void {
    this.listeners.push({ type, fn });
  }
}

class FakeForm extends FakeElement {
  noValidate = false;
  valid = true;
  get elements(): FakeElement[] {
    return this.ownerDocument.all().filter((el) => CONTROL_TAGS.has(el.tagName) && el.form === this);
  }
  reportValidity(): boolean {
    return this.valid;
  }
  /** O submit "nativo": só registra. O script embrulha este método no protótipo. */
  submit(): void {
    this.ownerDocument.nativeSubmits.push(this);
  }
}

class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly nativeSubmits: FakeForm[] = [];
  cookie = '';
  readonly baseURI: string;
  readonly formClass: typeof FakeForm;

  constructor(baseURI: string, formClass: typeof FakeForm = FakeForm) {
    this.baseURI = baseURI;
    this.formClass = formClass;
    this.documentElement = new FakeElement(this, 'HTML');
    this.head = this.documentElement.appendChild(new FakeElement(this, 'HEAD'));
    this.body = this.documentElement.appendChild(new FakeElement(this, 'BODY'));
  }
  createElement(tag: string): FakeElement {
    const upper = tag.toUpperCase();
    return upper === 'FORM' ? new this.formClass(this, 'FORM') : new FakeElement(this, upper);
  }
  all(): FakeElement[] {
    return [this.documentElement, ...this.documentElement.descendants()];
  }
  getElementById(id: string): FakeElement | null {
    return this.all().find((el) => el.id === id) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.matches(selector) ? this.documentElement : this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  immediateStopped = false;
  submitter: FakeElement | null;
  button: number;
  persisted: boolean;
  readonly type: string;
  readonly target: FakeElement | null;
  constructor(type: string, target: FakeElement | null, init: { submitter?: FakeElement | null; button?: number; persisted?: boolean } = {}) {
    this.type = type;
    this.target = target;
    this.submitter = init.submitter ?? null;
    this.button = init.button ?? 0;
    this.persisted = init.persisted ?? false;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
  stopImmediatePropagation(): void {
    this.immediateStopped = true;
    this.propagationStopped = true;
  }
  composedPath(): unknown[] {
    const path: unknown[] = [];
    let node: FakeElement | FakeDocument | null = this.target;
    while (node) {
      path.push(node);
      node = node instanceof FakeElement ? node.parentNode : null;
    }
    if (this.target) path.push(this.target.ownerDocument);
    return path;
  }
}

class FakeFormData {
  readonly entries: Array<[string, string]> = [];
  constructor(form?: FakeForm) {
    if (!form) return;
    for (const el of form.elements) {
      const name = el.getAttribute('name');
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (name === null || el.disabled === true || el.tagName === 'BUTTON') continue;
      if (type === 'submit' || type === 'button' || type === 'file') continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      this.entries.push([name, el.value ?? el.getAttribute('value') ?? '']);
    }
  }
  forEach(fn: (value: string, key: string) => void): void {
    for (const [key, value] of this.entries) fn(value, key);
  }
  append(key: string, value: string): void {
    this.entries.push([key, value]);
  }
}

// ---------------------------------------------------------------------------------------
// Janela falsa, rede e timers controlados
// ---------------------------------------------------------------------------------------

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  credentials?: string;
}

interface FakeResponse {
  status: number;
  redirected?: boolean;
  json: () => Promise<unknown>;
}

type Router = (url: string, init: FetchInit) => FakeResponse | Promise<FakeResponse>;

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
}

interface TestHook {
  config: { proxyPath: string; accelerated: string; onError: string; hosts: string[]; limits: Record<string, number> };
  state: { busy: boolean; lastControl: { el: FakeElement; form: FakeElement | null; at: number } | null };
  root(): string;
  isCheckoutPath(path: unknown): boolean;
  isCheckoutUrl(value: unknown): boolean;
  captureAttribution(): void;
  readStoredAttribution(): Record<string, string>;
  collectAttribution(): Record<string, string>;
  buildCartPayload(cart: unknown): Record<string, unknown>;
  cartLines(cart: unknown): unknown[];
  readBuyNowLine(form: FakeElement): Record<string, unknown> | null;
  getClientNonce(): string;
  findTrigger(path: unknown[]): { kind: string; el: FakeElement } | null;
  release(): void;
  whenIdle(): Promise<boolean>;
}

interface BridgeApi {
  version: string;
  checkout(): Promise<boolean>;
  __test?: TestHook;
}

interface Listener {
  type: string;
  fn: (event: FakeEvent) => void;
  capture: boolean;
}

function jsonResponse(body: unknown, status = 200, redirected = false): FakeResponse {
  return { status, redirected, json: async () => body };
}

function htmlResponse(status = 200): FakeResponse {
  return {
    status,
    redirected: false,
    json: async () => {
      throw new SyntaxError('not json');
    },
  };
}

const CHECKOUT_URL = 'https://checkout.example.com/cart/c/abc123?key=segredo';

function sampleCart(): Record<string, unknown> {
  return {
    token: 'tok123?key=chave-secreta',
    note: 'embrulhar',
    attributes: { Presente: 'sim' },
    total_price: 2925,
    items_subtotal_price: 2925,
    currency: 'BRL',
    item_count: 3,
    discount_codes: [
      { code: 'BEMVINDO', applicable: true },
      { code: 'EXPIRADO', applicable: false },
    ],
    cart_level_discount_applications: [{ type: 'discount_code', title: 'bemvindo' }],
    items: [
      {
        id: 111,
        variant_id: 111,
        quantity: 2,
        price: 900,
        line_price: 1800,
        final_price: 900,
        properties: { Gravação: 'Ana', _oculta: 'x', __privada: 'nunca', Vazia: '', Nula: null, Num: 7 },
        line_level_discount_allocations: [{ amount: 100, discount_application: { type: 'discount_code', title: 'LINHA10' } }],
      },
      {
        id: 222,
        variant_id: 222,
        quantity: 1,
        price: 1125,
        properties: null,
        selling_plan_allocation: { price: 1000, selling_plan: { id: 5 } },
      },
    ],
  };
}

interface PageOptions {
  href?: string;
  cookie?: string;
  shopify?: Record<string, unknown>;
  storage?: 'ok' | 'throws';
  stored?: Record<string, string>;
  /** Conteúdo inicial do sessionStorage. */
  session?: Record<string, string>;
  /** Web Crypto disponível: completa, só getRandomValues, ou nenhuma. */
  crypto?: 'uuid' | 'bytes' | 'none';
  router?: Router;
  config?: Partial<BridgeScriptConfig>;
  now?: number;
}

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

class Page {
  readonly doc: FakeDocument;
  readonly sandbox: Record<string, unknown>;
  readonly fetchCalls: Array<{ url: string; init: FetchInit }> = [];
  readonly assigned: string[] = [];
  readonly timers: Timer[] = [];
  readonly logs: unknown[][] = [];
  readonly listeners: Listener[] = [];
  readonly storage = new Map<string, string>();
  readonly session = new Map<string, string>();
  /** Classe própria por página: o script embrulha submit() no protótipo dela, não no compartilhado. */
  readonly formClass: typeof FakeForm;
  now: number;
  router: Router;
  private nextTimer = 1;

  constructor(opts: PageOptions = {}) {
    const href = opts.href ?? 'https://vitrine.example.com/cart';
    const url = new URL(href);
    this.now = opts.now ?? NOW;
    this.formClass = class PageForm extends FakeForm {};
    this.doc = new FakeDocument(href, this.formClass);
    this.doc.cookie = opts.cookie ?? '';
    for (const [key, value] of Object.entries(opts.stored ?? {})) this.storage.set(key, value);
    for (const [key, value] of Object.entries(opts.session ?? {})) this.session.set(key, value);
    this.router = opts.router ?? ((target) => this.defaultRoute(target));
    const storageOf = (map: Map<string, string>) =>
      opts.storage === 'throws'
        ? {
            getItem: () => {
              throw new Error('SecurityError');
            },
            setItem: () => {
              throw new Error('SecurityError');
            },
            removeItem: () => {
              throw new Error('SecurityError');
            },
          }
        : {
            getItem: (key: string) => map.get(key) ?? null,
            setItem: (key: string, value: string) => void map.set(key, String(value)),
            removeItem: (key: string) => void map.delete(key),
          };
    const localStorage = storageOf(this.storage);
    const sessionStorage = storageOf(this.session);
    // getRandomValues preenche à mão: o Uint8Array vem de outro realm (o do sandbox).
    const getRandomValues = (array: Uint8Array) => {
      const bytes = randomBytes(array.length);
      for (let i = 0; i < array.length; i += 1) array[i] = bytes[i]!;
      return array;
    };
    const cryptoMode = opts.crypto ?? 'uuid';
    const crypto = cryptoMode === 'none' ? undefined : cryptoMode === 'bytes' ? { getRandomValues } : { randomUUID, getRandomValues };
    const sandbox: Record<string, unknown> = {
      document: this.doc,
      location: {
        href,
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
        assign: (target: string) => void this.assigned.push(target),
      },
      localStorage,
      sessionStorage,
      crypto,
      fetch: (target: string, init: FetchInit = {}) => {
        this.fetchCalls.push({ url: target, init });
        return Promise.resolve().then(() => this.router(target, init));
      },
      setTimeout: (fn: () => void, ms: number) => {
        const id = this.nextTimer++;
        this.timers.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (id: number) => {
        const index = this.timers.findIndex((t) => t.id === id);
        if (index !== -1) this.timers.splice(index, 1);
      },
      addEventListener: (type: string, fn: (event: FakeEvent) => void, capture?: boolean) => {
        this.listeners.push({ type, fn, capture: capture === true });
      },
      console: { log: (...args: unknown[]) => void this.logs.push(args) },
      Date: { now: () => this.now },
      URL,
      URLSearchParams,
      AbortController,
      FormData: FakeFormData,
      HTMLFormElement: this.formClass,
      Event: FakeEvent,
      Shopify: opts.shopify ?? { routes: { root: '/' }, country: 'BR', locale: 'pt-BR' },
    };
    sandbox['window'] = sandbox;
    this.sandbox = sandbox;
    vm.createContext(sandbox);
    this.run(opts.config, true);
  }

  defaultRoute(target: string): FakeResponse {
    if (target.endsWith('cart.js')) return jsonResponse(sampleCart());
    if (target.endsWith('cart/update.js')) return jsonResponse(sampleCart());
    if (target.endsWith('/checkout')) return jsonResponse({ ok: true, checkoutUrl: CHECKOUT_URL });
    return htmlResponse(404);
  }

  run(config: Partial<BridgeScriptConfig> = {}, test = true): void {
    const full: BridgeScriptConfig = {
      proxyPath: '/apps/checkout-bridge',
      checkoutHosts: ['checkout.example.com'],
      acceleratedButtons: 'hide',
      onError: 'message',
      extraSelectors: [],
      debug: false,
      ...config,
    };
    vm.runInContext(renderBridgeScript(full, { test }), this.sandbox);
  }

  get bridge(): BridgeApi {
    return this.sandbox['CheckoutBridge'] as BridgeApi;
  }
  get hook(): TestHook {
    const hook = this.bridge.__test;
    assert.ok(hook, 'gancho de teste ausente');
    return hook;
  }
  /** Dispara o evento nos listeners de captura da janela, na ordem de registro. */
  dispatch(event: FakeEvent): FakeEvent {
    for (const listener of this.listeners) {
      if (listener.type !== event.type || !listener.capture) continue;
      listener.fn(event);
      if (event.immediateStopped) break;
    }
    return event;
  }
  click(el: FakeElement, init: { button?: number; type?: string } = {}): FakeEvent {
    return this.dispatch(new FakeEvent(init.type ?? 'click', el, { button: init.button ?? 0 }));
  }
  submit(form: FakeForm, submitter: FakeElement | null = null): FakeEvent {
    return this.dispatch(new FakeEvent('submit', form, { submitter }));
  }
  pageShow(persisted: boolean): void {
    const event = new FakeEvent('pageshow', null, { persisted });
    for (const listener of this.listeners) if (listener.type === 'pageshow') listener.fn(event);
  }
  fireTimer(ms: number): void {
    const timer = this.timers.find((t) => t.ms === ms);
    assert.ok(timer, `nenhum timer de ${ms}ms pendente`);
    this.timers.splice(this.timers.indexOf(timer), 1);
    timer.fn();
  }
  el(tag: string, attrs: Record<string, string> = {}, parent: FakeElement = this.doc.body): FakeElement {
    const node = this.doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return parent.appendChild(node);
  }
  form(attrs: Record<string, string>, parent: FakeElement = this.doc.body): FakeForm {
    const node = this.el('form', attrs, parent);
    assert.ok(node instanceof FakeForm);
    return node;
  }
  input(parent: FakeElement, attrs: Record<string, string>, value?: string): FakeElement {
    const node = this.el('input', attrs, parent);
    if (value !== undefined) node.value = value;
    return node;
  }
  checkoutPost(): { url: string; body: Record<string, unknown> } | null {
    const call = this.fetchCalls.find((c) => c.url.endsWith('/checkout') && c.init.method === 'POST');
    if (!call) return null;
    const body = typeof call.init.body === 'string' ? call.init.body : '';
    return { url: call.url, body: JSON.parse(body) as Record<string, unknown> };
  }
  alertBox(): FakeElement | null {
    return this.doc.body.querySelector('[role="alert"]');
  }
  idle(): Promise<boolean> {
    return this.hook.whenIdle();
  }
}

/** Página de carrinho no estilo Dawn: form de carrinho e botão de checkout fora dele. */
function cartPage(opts: PageOptions = {}): { page: Page; form: FakeForm; checkout: FakeElement; update: FakeElement } {
  const page = new Page(opts);
  const root = page.hook.root();
  const form = page.form({ id: 'cart', action: `${root}cart`, method: 'post' });
  page.input(form, { type: 'hidden', name: 'form_type' }, 'cart');
  page.input(form, { type: 'number', name: 'updates[]' }, '3');
  const note = page.el('textarea', { name: 'note', form: 'cart' });
  note.value = 'embrulhar';
  const update = page.el('button', { type: 'submit', name: 'update', form: 'cart' });
  const checkout = page.el('button', { type: 'submit', id: 'checkout', name: 'checkout', form: 'cart' });
  return { page, form, checkout, update };
}

/** Deixa as microtarefas e os fetches falsos pendentes avançarem (sem espera real). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Cópia no realm do teste: objetos do vm não são deepEqual aos daqui. */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Partida e gancho
// ---------------------------------------------------------------------------------------

test('inicia uma vez, expõe só window.CheckoutBridge e não escreve no console sem debug', () => {
  const page = new Page();
  assert.equal(typeof page.bridge.version, 'string');
  assert.equal(typeof page.bridge.checkout, 'function');
  assert.ok(page.bridge.__test);
  const registered = page.listeners.length;
  // Segunda execução (trecho inline + loader na mesma página) não registra nada de novo.
  page.run();
  assert.equal(page.listeners.length, registered);
  assert.deepEqual(
    page.listeners.filter((l) => l.capture).map((l) => l.type),
    ['click', 'auxclick', 'submit'],
  );
  assert.deepEqual(page.logs, []);
  const globals = Object.keys(page.sandbox).filter((k) => k === 'CheckoutBridge' || k.startsWith('cb') || k.startsWith('__'));
  assert.deepEqual(globals, ['CheckoutBridge']);
});

test('sem __test na configuração não existe gancho de teste', () => {
  const page = new Page();
  const sandbox: Record<string, unknown> = { ...page.sandbox };
  delete sandbox['CheckoutBridge'];
  sandbox['window'] = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    renderBridgeScript({ proxyPath: '/apps/x', checkoutHosts: [], acceleratedButtons: 'hide', onError: 'message', extraSelectors: [], debug: false }),
    sandbox,
  );
  const api = sandbox['CheckoutBridge'] as BridgeApi;
  assert.equal(api.__test, undefined);
});

test('console só com debug ligado (seletor extra inválido é registrado e ignorado)', () => {
  const quiet = new Page({ config: { extraSelectors: ['[['] } });
  assert.deepEqual(quiet.logs, []);
  const loud = new Page({ config: { extraSelectors: ['[['], debug: true } });
  assert.ok(loud.logs.length > 0);
  assert.ok(loud.logs.every((entry) => entry[0] === '[checkout-bridge]'));
});

test('não altera Event.prototype; só embrulha HTMLFormElement.prototype.submit', () => {
  const eventBefore = Object.getOwnPropertyDescriptors(FakeEvent.prototype);
  const elementBefore = Object.getOwnPropertyDescriptors(FakeElement.prototype);
  const page = new Page();
  assert.deepEqual(Object.getOwnPropertyDescriptors(FakeEvent.prototype), eventBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptors(FakeElement.prototype), elementBefore);
  assert.equal(Object.hasOwn(page.formClass.prototype, 'submit'), true);
  assert.notEqual(page.formClass.prototype.submit, FakeForm.prototype.submit);
  assert.deepEqual(Object.getOwnPropertyNames(page.formClass.prototype).sort(), ['constructor', 'submit']);
});

// ---------------------------------------------------------------------------------------
// Atribuição
// ---------------------------------------------------------------------------------------

test('captura parâmetros de atribuição da URL para localStorage, mesclando com os anteriores', () => {
  const page = new Page({
    href: 'https://vitrine.example.com/products/x?utm_source=meta&fbclid=abc.123&utm_medium=%20cpc%20&foo=bar&price=10',
    stored: { cb_attr: JSON.stringify({ t: NOW - 1000, v: { utm_campaign: 'antiga', utm_source: 'velha', lixo: 'x' } }) },
  });
  const stored = JSON.parse(page.storage.get('cb_attr') ?? 'null') as { t: number; v: Record<string, string> };
  assert.equal(stored.t, NOW);
  assert.deepEqual(stored.v, { utm_campaign: 'antiga', utm_source: 'meta', fbclid: 'abc.123', utm_medium: 'cpc' });
  assert.deepEqual(plain(page.hook.readStoredAttribution()), stored.v);
});

test('atribuição guardada expira em 30 dias e é descartada', () => {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const fresh = new Page({ stored: { cb_attr: JSON.stringify({ t: NOW - thirtyDays + 1, v: { gclid: 'g1' } }) } });
  assert.deepEqual(plain(fresh.hook.readStoredAttribution()), { gclid: 'g1' });
  const stale = new Page({ stored: { cb_attr: JSON.stringify({ t: NOW - thirtyDays - 1, v: { gclid: 'g1' } }) } });
  assert.deepEqual(plain(stale.hook.readStoredAttribution()), {});
  assert.equal(stale.storage.has('cb_attr'), false);
  const broken = new Page({ stored: { cb_attr: '{nao é json' } });
  assert.deepEqual(plain(broken.hook.readStoredAttribution()), {});
});

test('falha de armazenamento é ignorada e o script continua funcionando', () => {
  const page = new Page({ href: 'https://vitrine.example.com/?utm_source=x', storage: 'throws' });
  assert.ok(page.bridge.__test);
  assert.deepEqual(plain(page.hook.collectAttribution()), {});
});

test('na hora do checkout os cookies dos pixels entram como fbp, fbc, ga e ttp', () => {
  const page = new Page({
    stored: { cb_attr: JSON.stringify({ t: NOW, v: { ttclid: 't1' } }) },
    cookie: '_fbp=fb.1.123; _fbc=fb.1.456.abc; _ga=GA1.1.9.9; _ttp=ttp%20x; _shopify_y=nunca; cart=tok',
  });
  assert.deepEqual(plain(page.hook.collectAttribution()), {
    ttclid: 't1',
    fbp: 'fb.1.123',
    fbc: 'fb.1.456.abc',
    ga: 'GA1.1.9.9',
    ttp: 'ttp x',
  });
});

// ---------------------------------------------------------------------------------------
// Carga do checkout
// ---------------------------------------------------------------------------------------

test('monta a carga a partir do carrinho sem nenhum preço', () => {
  const page = new Page({
    cookie: '_fbp=fb.1.1',
    stored: { cb_attr: JSON.stringify({ t: NOW, v: { utm_source: 'meta' } }) },
    shopify: {
      routes: { root: '/pt-br/' },
      country: 'br',
      locale: 'pt-BR',
      customerPrivacy: {
        analyticsProcessingAllowed: () => true,
        marketingAllowed: () => false,
        preferencesProcessingAllowed: () => true,
        saleOfDataAllowed: () => 'sim',
      },
    },
  });
  const payload = plain<Record<string, unknown>>(page.hook.buildCartPayload(sampleCart()));
  assert.deepEqual(payload, {
    source: 'cart',
    lines: [
      { variantId: '111', quantity: 2, properties: { Gravação: 'Ana', _oculta: 'x', Num: '7' } },
      { variantId: '222', quantity: 1, hasSellingPlan: true },
    ],
    country: 'BR',
    language: 'pt-BR',
    attribution: { utm_source: 'meta', fbp: 'fb.1.1' },
    consent: { analytics: true, marketing: false, preferences: true, saleOfData: false },
    cartToken: 'tok123',
    discountCodes: ['BEMVINDO', 'LINHA10'],
  });
  const keys = keysDeep(payload);
  assert.equal(keys.some((k) => /price|total|amount|currency/i.test(k)), false);
  assert.equal(JSON.stringify(payload).includes('chave-secreta'), false);
});

test('sem Customer Privacy API completa não afirma consentimento; país e idioma inválidos ficam de fora', () => {
  const page = new Page({ shopify: { routes: { root: '/' }, country: 'Brasil', locale: 'pt_BR!', customerPrivacy: { marketingAllowed: () => true } } });
  const payload = plain<Record<string, unknown>>(page.hook.buildCartPayload({ items: [{ variant_id: 1, quantity: 1 }] }));
  assert.deepEqual(payload, { source: 'cart', lines: [{ variantId: '1', quantity: 1 }] });
});

test('linhas inválidas são descartadas e os cupons respeitam o limite do serviço', () => {
  const page = new Page();
  const lines = plain<unknown[]>(
    page.hook.cartLines({ items: [{ id: 5, quantity: 0 }, { quantity: 2 }, null, { id: 9, quantity: '3' }, { variant_id: 7, quantity: 1.9 }] }),
  );
  assert.deepEqual(lines, [
    { variantId: '9', quantity: 3 },
    { variantId: '7', quantity: 1 },
  ]);
  const codes = plain<string[]>(
    page.hook.buildCartPayload({
      items: [{ variant_id: 1, quantity: 1 }],
      discount_codes: ['A', 'B', 'C', 'D', 'E', 'F'].map((code) => ({ code, applicable: true })).concat([{ code: 'COM,VIRGULA', applicable: true }]),
    })['discountCodes'],
  );
  assert.deepEqual(codes, ['A', 'B', 'C', 'D', 'E']);
});

// ---------------------------------------------------------------------------------------
// Checkout do carrinho: fluxo completo
// ---------------------------------------------------------------------------------------

test('clique no botão de checkout do Dawn: salva o form, lê o carrinho, chama o proxy e navega', async () => {
  const { page, checkout } = cartPage({ shopify: { routes: { root: '/pt-br/' }, country: 'BR', locale: 'pt-BR' } });
  const event = page.click(checkout);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediateStopped, true);
  // Estado ocupado enquanto roda.
  assert.equal(page.hook.state.busy, true);
  assert.equal(page.doc.documentElement.classList.contains('cb-busy'), true);
  assert.equal(checkout.getAttribute('aria-busy'), 'true');
  assert.equal(checkout.disabled, true);
  assert.equal(await page.idle(), true);

  assert.deepEqual(
    page.fetchCalls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`),
    ['POST /pt-br/cart/update.js', 'GET /pt-br/cart.js', 'POST /apps/checkout-bridge/checkout'],
  );
  const save = page.fetchCalls[0];
  assert.ok(save?.init.body instanceof FakeFormData);
  // form_type não é um campo do carrinho: só quantidades, nota e atributos seguem.
  assert.deepEqual(save.init.body.entries, [
    ['updates[]', '3'],
    ['note', 'embrulhar'],
  ]);
  const post = page.checkoutPost();
  assert.ok(post);
  assert.equal(post.url.includes('?'), false);
  assert.equal(page.fetchCalls[2]?.init.credentials, 'same-origin');
  assert.equal(page.fetchCalls[2]?.init.headers?.['Content-Type'], 'application/json');
  assert.equal(post.body['source'], 'cart');
  assert.equal(post.body['cartToken'], 'tok123');
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
  // Segue ocupado até a página sair; voltar pelo bfcache libera.
  assert.equal(page.hook.state.busy, true);
  page.pageShow(false);
  assert.equal(page.hook.state.busy, true);
  page.pageShow(true);
  assert.equal(page.hook.state.busy, false);
  assert.equal(checkout.disabled, false);
  assert.equal(checkout.getAttribute('aria-busy'), null);
});

test('cliques repetidos durante o checkout são ignorados (uma única leitura do carrinho)', async () => {
  const pending: { release: (() => void) | null } = { release: null };
  const { page, checkout } = cartPage({
    router: (url) => {
      if (url.endsWith('cart.js')) {
        return new Promise<FakeResponse>((resolve) => {
          pending.release = () => resolve(jsonResponse(sampleCart()));
        });
      }
      return page.defaultRoute(url);
    },
  });
  page.click(checkout);
  const second = page.click(checkout);
  const third = page.click(checkout);
  assert.equal(second.defaultPrevented, true);
  assert.equal(third.defaultPrevented, true);
  await flush();
  assert.equal(page.fetchCalls.filter((c) => c.url.endsWith('cart.js')).length, 1);
  assert.ok(pending.release);
  pending.release();
  await page.idle();
  assert.equal(page.fetchCalls.filter((c) => c.url.endsWith('/checkout')).length, 1);
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
});

test('carrinho vazio leva à página do carrinho, sem chamar o proxy', async () => {
  const { page, checkout } = cartPage({
    shopify: { routes: { root: '/pt-br/' } },
    router: (url) => (url.endsWith('cart.js') ? jsonResponse({ token: 't', items: [] }) : page.defaultRoute(url)),
  });
  page.click(checkout);
  await page.idle();
  assert.deepEqual(page.assigned, ['/pt-br/cart']);
  assert.equal(page.checkoutPost(), null);
});

test('CheckoutBridge.checkout() inicia o fluxo sem gatilho e nunca rejeita', async () => {
  const page = new Page({ router: () => htmlResponse(500) });
  assert.equal(await page.bridge.checkout(), false);
  assert.ok(page.alertBox());
});

// ---------------------------------------------------------------------------------------
// Matriz de respostas
// ---------------------------------------------------------------------------------------

async function runWithAnswer(answer: Router, config: Partial<BridgeScriptConfig> = {}) {
  const fixture = cartPage({
    config,
    shopify: { routes: { root: '/pt-br/' } },
    router: (url, init) => (url.endsWith('/checkout') ? answer(url, init) : fixture.page.defaultRoute(url)),
  });
  fixture.page.click(fixture.checkout);
  await fixture.page.idle();
  return fixture;
}

test('só 200 com { ok: true, checkoutUrl https } navega', async () => {
  const ok = await runWithAnswer(() => jsonResponse({ ok: true, checkoutUrl: CHECKOUT_URL }));
  assert.deepEqual(ok.page.assigned, [CHECKOUT_URL]);
  assert.equal(ok.page.alertBox(), null);

  const cases: Array<[string, Router]> = [
    ['http', () => jsonResponse({ ok: true, checkoutUrl: 'http://checkout.example.com/x' })],
    ['url relativa', () => jsonResponse({ ok: true, checkoutUrl: '/checkout' })],
    ['javascript', () => jsonResponse({ ok: true, checkoutUrl: 'javascript:alert(1)' })],
    ['userinfo', () => jsonResponse({ ok: true, checkoutUrl: 'https://user@checkout.example.com/x' })],
    ['ok false', () => jsonResponse({ ok: false, code: 'no_route', message: 'Indisponível' })],
    ['sem ok', () => jsonResponse({ checkoutUrl: CHECKOUT_URL })],
    ['html', () => htmlResponse(200)],
    ['500', () => jsonResponse({ ok: true, checkoutUrl: CHECKOUT_URL }, 500)],
    ['redirecionado', () => jsonResponse({ ok: true, checkoutUrl: CHECKOUT_URL }, 200, true)],
    ['rede', () => Promise.reject(new TypeError('fetch failed'))],
    ['corpo não objeto', () => jsonResponse('texto')],
  ];
  for (const [label, router] of cases) {
    const fixture = await runWithAnswer(router);
    assert.deepEqual(fixture.page.assigned, [], label);
    const box = fixture.page.alertBox();
    assert.ok(box, label);
    assert.equal(box.getAttribute('role'), 'alert', label);
    assert.equal(fixture.page.hook.state.busy, false, label);
    assert.equal(fixture.checkout.disabled, false, label);
    assert.equal(fixture.page.doc.documentElement.classList.contains('cb-busy'), false, label);
  }
});

test('a mensagem usa o texto do serviço quando há um, senão um texto genérico, e pode ser fechada', async () => {
  const specific = await runWithAnswer(() => jsonResponse({ ok: false, code: 'price_divergence', message: 'O preço de um item foi atualizado.' }));
  const box = specific.page.alertBox();
  assert.ok(box);
  assert.equal(box.childNodes[0]?.textContent, 'O preço de um item foi atualizado.');
  const close = box.querySelector('button');
  assert.ok(close);
  assert.equal(close.getAttribute('aria-label'), 'Fechar');
  const listener = close.listeners.find((l) => l.type === 'click');
  assert.ok(listener);
  listener.fn(new FakeEvent('click', close));
  assert.equal(specific.page.alertBox(), null);

  const generic = await runWithAnswer(() => htmlResponse(200));
  const text = generic.page.alertBox()?.childNodes[0]?.textContent ?? '';
  assert.ok(text.includes('checkout'));
  // Texto de ok:true malformado nunca vira mensagem.
  const sneaky = await runWithAnswer(() => jsonResponse({ ok: true, checkoutUrl: 'nada', message: '<b>x</b>' }));
  assert.equal(sneaky.page.alertBox()?.childNodes[0]?.textContent, text);
});

test('estouro de 12 s aborta a requisição e vira falha', async () => {
  const fixture = await (async () => {
    const f = cartPage({
      router: (url, init) => {
        if (!url.endsWith('/checkout')) return f.page.defaultRoute(url);
        return new Promise<FakeResponse>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });
    f.page.click(f.checkout);
    // Espera o POST ser disparado antes de estourar o prazo dele.
    await flush();
    assert.ok(f.page.timers.some((t) => t.ms === 12000));
    f.page.fireTimer(12000);
    await f.page.idle();
    return f;
  })();
  assert.deepEqual(fixture.page.assigned, []);
  assert.ok(fixture.page.alertBox());
  assert.equal(fixture.page.hook.state.busy, false);
});

test("onError 'native' leva ao checkout nativo da vitrine em falha do carrinho", async () => {
  const fixture = await runWithAnswer(() => htmlResponse(200), { onError: 'native' });
  assert.deepEqual(fixture.page.assigned, ['/pt-br/checkout']);
  assert.equal(fixture.page.alertBox(), null);
});

// ---------------------------------------------------------------------------------------
// O que é interceptado e o que não é
// ---------------------------------------------------------------------------------------

test('cliques: links para /checkout (com prefixo de idioma), controles name=checkout, atributos e seletores extras', () => {
  const page = new Page({ config: { extraSelectors: ['.drawer-go', '[['] } });
  const kind = (el: FakeElement): string | null => page.hook.findTrigger([el, page.doc.body, page.doc])?.kind ?? null;
  assert.equal(kind(page.el('a', { href: '/checkout' })), 'link');
  assert.equal(kind(page.el('a', { href: '/pt-br/checkout/' })), 'link');
  assert.equal(kind(page.el('a', { href: 'https://vitrine.example.com/checkout?discount=X' })), 'link');
  assert.equal(kind(page.el('a', { href: 'https://outra.example.com/checkout' })), null);
  assert.equal(kind(page.el('a', { href: '/pages/checkout-info' })), null);
  assert.equal(kind(page.el('a', { href: '/apps/checkout-bridge/checkout' })), null);
  assert.equal(kind(page.el('a', { href: 'javascript:void(0)' })), null);
  assert.equal(kind(page.el('a', {})), null);
  assert.equal(kind(page.el('button', { name: 'checkout' })), 'control');
  assert.equal(kind(page.el('input', { type: 'submit', name: 'checkout' })), 'control');
  assert.equal(kind(page.el('input', { type: 'hidden', name: 'checkout' })), null);
  assert.equal(kind(page.el('button', { name: 'update' })), null);
  assert.equal(kind(page.el('div', { 'data-action': 'checkout' })), 'custom');
  assert.equal(kind(page.el('div', { 'data-checkout-button': '' })), 'custom');
  assert.equal(kind(page.el('span', { 'data-cart-checkout': '1' })), 'custom');
  assert.equal(kind(page.el('button', { class: 'drawer-go' })), 'custom');
  assert.equal(kind(page.el('button', { class: 'cart__checkout-button' })), 'custom');
  assert.equal(kind(page.el('button', { class: 'add-to-cart' })), null);
  // O caminho é percorrido do alvo para fora: um ícone dentro do link conta.
  const link = page.el('a', { href: '/checkout' });
  const icon = page.el('svg', {}, link);
  assert.equal(page.hook.findTrigger([icon, link, page.doc.body])?.el, link);
});

test('clique num link de checkout e clique do meio são interceptados', async () => {
  const page = new Page();
  const link = page.el('a', { href: '/checkout' });
  const icon = page.el('span', {}, link);
  const click = page.click(icon);
  assert.equal(click.defaultPrevented, true);
  await page.idle();
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
  // Sem form de carrinho não há o que salvar: direto para cart.js.
  assert.deepEqual(page.fetchCalls.map((c) => c.url), ['/cart.js', '/apps/checkout-bridge/checkout']);

  const other = new Page();
  const middle = other.click(other.el('a', { href: '/checkout' }), { type: 'auxclick', button: 1 });
  assert.equal(middle.defaultPrevented, true);
  const rightOnButton = other.click(other.el('button', { name: 'checkout' }), { type: 'auxclick', button: 2 });
  assert.equal(rightOnButton.defaultPrevented, false);
});

test('submit: form do carrinho só com submitter checkout; atualizar e adicionar seguem nativos', async () => {
  const { page, form, checkout, update } = cartPage({ shopify: { routes: { root: '/pt-br/' } } });
  assert.equal(page.submit(form, update).defaultPrevented, false);
  assert.equal(page.submit(form, null).defaultPrevented, false);
  const addForm = page.form({ action: '/pt-br/cart/add', method: 'post' });
  const addButton = page.el('button', { type: 'submit', name: 'add' }, addForm);
  assert.equal(page.submit(addForm, addButton).defaultPrevented, false);
  // Form de parcelamento do Horizon: action /cart, sem botão de checkout.
  const terms = page.form({ id: 'cart_form', action: '/pt-br/cart', class: 'shopify-cart-form' });
  assert.equal(page.submit(terms, null).defaultPrevented, false);
  assert.equal(page.fetchCalls.length, 0);

  const hit = page.submit(form, checkout);
  assert.equal(hit.defaultPrevented, true);
  await page.idle();
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
  assert.equal(page.fetchCalls[0]?.url, '/pt-br/cart/update.js');
});

test('submit sem submitter usa o último controle de checkout clicado há menos de um segundo', () => {
  const { page, form, checkout } = cartPage();
  page.hook.state.lastControl = { el: checkout, form, at: NOW - 999 };
  assert.equal(page.submit(form, null).defaultPrevented, true);
  page.hook.release();
  const late = cartPage();
  late.page.hook.state.lastControl = { el: late.checkout, form: late.form, at: NOW - 1001 };
  assert.equal(late.page.submit(late.form, null).defaultPrevented, false);
});

test('form com action /checkout é interceptado no submit; formaction do botão também conta', () => {
  const page = new Page();
  const form = page.form({ action: '/checkout', method: 'post' });
  assert.equal(page.submit(form, null).defaultPrevented, true);
  page.hook.release();
  const cart = page.form({ action: '/cart', method: 'post' });
  const button = page.el('button', { type: 'submit', name: 'go', formaction: '/checkout' }, cart);
  assert.equal(page.submit(cart, button).defaultPrevented, true);
});

test('validação nativa do form é respeitada no clique: só segue quando o form é válido', () => {
  const { page, form, checkout } = cartPage();
  form.valid = false;
  const blocked = page.click(checkout);
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(page.hook.state.busy, false);
  assert.equal(page.fetchCalls.length, 0);
  form.valid = true;
  page.click(checkout);
  assert.equal(page.hook.state.busy, true);
});

test('form.submit() programático: /checkout passa pela ponte, qualquer outro vai ao original', async () => {
  const page = new Page();
  const checkoutForm = page.form({ action: '/pt-br/checkout' });
  const cartForm = page.form({ action: '/cart' });
  const addForm = page.form({ action: '/cart/add' });
  checkoutForm.submit();
  assert.equal(page.hook.state.busy, true);
  assert.deepEqual(page.doc.nativeSubmits, []);
  await page.idle();
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
  cartForm.submit();
  addForm.submit();
  assert.deepEqual(page.doc.nativeSubmits, [cartForm, addForm]);
});

// ---------------------------------------------------------------------------------------
// Compra direta e botões acelerados
// ---------------------------------------------------------------------------------------

function productPage(opts: PageOptions = {}): { page: Page; form: FakeForm; button: FakeElement } {
  const page = new Page({ href: 'https://vitrine.example.com/products/camiseta', ...opts });
  const form = page.form({ id: 'product-form', action: '/cart/add', method: 'post' });
  page.input(form, { type: 'hidden', name: 'id' }, '4455');
  page.input(form, { type: 'text', name: 'properties[Gravação]' }, 'Ana');
  page.input(form, { type: 'text', name: 'properties[Vazia]' }, '');
  page.input(form, { type: 'text', name: 'properties[__privada]' }, 'x');
  page.input(form, { type: 'checkbox', name: 'properties[Presente]' }, 'sim');
  const radioA = page.input(form, { type: 'radio', name: 'properties[Cor]' }, 'azul');
  radioA.checked = true;
  page.input(form, { type: 'radio', name: 'properties[Cor]' }, 'verde');
  page.input(form, { type: 'file', name: 'properties[Arquivo]' }, 'c:\\arquivo.png');
  const off = page.input(form, { type: 'text', name: 'properties[Desligada]' }, 'não');
  off.disabled = true;
  page.input(form, { type: 'hidden', name: 'selling_plan' }, '');
  // Quantidade fora do form, ligada por form="...", como no Dawn.
  page.input(page.doc.body, { type: 'number', name: 'quantity', form: 'product-form' }, '3');
  const wrapper = page.el('div', { 'data-shopify': 'payment-button', class: 'shopify-payment-button' }, form);
  const button = page.el('shopify-accelerated-checkout', {}, wrapper);
  return { page, form, button };
}

test('compra direta: extrai variante, quantidade, propriedades e plano do form de produto', () => {
  const { page, form } = productPage();
  assert.deepEqual(plain(page.hook.readBuyNowLine(form)), {
    variantId: '4455',
    quantity: 3,
    properties: { Gravação: 'Ana', Cor: 'azul' },
  });
  const plan = page.doc.querySelector('[name="selling_plan"]');
  assert.ok(plan);
  plan.value = '77';
  assert.equal(plain<Record<string, unknown>>(page.hook.readBuyNowLine(form))['hasSellingPlan'], true);
  const id = page.doc.querySelector('[name="id"]');
  assert.ok(id);
  id.value = 'abc';
  assert.equal(page.hook.readBuyNowLine(form), null);
});

test("acceleratedButtons 'intercept': clique no botão acelerado do produto vira compra direta", async () => {
  const { page, button } = productPage({ config: { acceleratedButtons: 'intercept' } });
  assert.equal(page.doc.head.querySelector('style'), null);
  const event = page.click(button);
  assert.equal(event.defaultPrevented, true);
  await page.idle();
  assert.deepEqual(page.fetchCalls.map((c) => c.url), ['/apps/checkout-bridge/checkout']);
  const post = page.checkoutPost();
  assert.ok(post);
  assert.deepEqual(post.body, {
    source: 'buy_now',
    lines: [{ variantId: '4455', quantity: 3, properties: { Gravação: 'Ana', Cor: 'azul' } }],
    country: 'BR',
    language: 'pt-BR',
    clientNonce: page.hook.getClientNonce(),
  });
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
});

test("acceleratedButtons 'intercept': botão acelerado do carrinho vira checkout do carrinho", async () => {
  const { page } = cartPage({ config: { acceleratedButtons: 'intercept' } });
  const container = page.el('shopify-accelerated-checkout-cart', {});
  const inner = page.el('shop-pay-wallet-button', {}, container);
  assert.equal(page.click(inner).defaultPrevented, true);
  await page.idle();
  assert.equal(page.checkoutPost()?.body['source'], 'cart');
  assert.deepEqual(page.assigned, [CHECKOUT_URL]);
});

test("compra direta com falha mostra mensagem mesmo em onError 'native'", async () => {
  const { page, button } = productPage({ config: { acceleratedButtons: 'intercept', onError: 'native' }, router: () => htmlResponse(200) });
  page.click(button);
  await page.idle();
  assert.deepEqual(page.assigned, []);
  assert.ok(page.alertBox());
});

test("acceleratedButtons 'hide' injeta um único estilo escondendo os botões acelerados", () => {
  const page = new Page();
  const styles = page.doc.head.querySelectorAll('style');
  assert.equal(styles.length, 1);
  const css = styles[0]?.textContent ?? '';
  for (const selector of [
    'shopify-accelerated-checkout',
    'shopify-accelerated-checkout-cart',
    '.shopify-payment-button',
    '[data-shopify="payment-button"]',
    '.additional-checkout-buttons',
    '#dynamic-checkout-cart',
  ]) {
    assert.ok(css.includes(selector), selector);
  }
  assert.ok(css.includes('display:none!important'));
  assert.equal(styles[0]?.getAttribute('data-checkout-bridge'), 'accelerated');
});

test('preconnect para os hosts de checkout configurados', () => {
  const page = new Page({ config: { checkoutHosts: ['checkout.example.com', 'loja2.myshopify.com'] } });
  const links = page.doc.head.querySelectorAll('link[rel="preconnect"]');
  assert.deepEqual(
    links.map((l) => l.getAttribute('href')),
    ['https://checkout.example.com', 'https://loja2.myshopify.com'],
  );
});

test('Shopify.routes.root inválida não vira caminho de outra origem', () => {
  const evil = new Page({ shopify: { routes: { root: '//evil.example/' } } });
  assert.equal(evil.hook.root(), '/');
  const locale = new Page({ shopify: { routes: { root: '/en-ca' } } });
  assert.equal(locale.hook.root(), '/en-ca/');
});

// ---------------------------------------------------------------------------------------
// Rotas exatas: só /checkout, /cart e /cart/add (com o prefixo de idioma) são gatilhos
// ---------------------------------------------------------------------------------------

test('links para conteúdo cujo último segmento é "checkout" não são gatilhos', () => {
  const page = new Page();
  const kind = (el: FakeElement): string | null => page.hook.findTrigger([el, page.doc.body, page.doc])?.kind ?? null;
  for (const href of ['/pages/checkout', '/collections/checkout', '/blogs/news/checkout', '/products/checkout', '/checkouts/abc']) {
    assert.equal(kind(page.el('a', { href })), null, href);
  }
  assert.equal(kind(page.el('a', { href: '/checkout' })), 'link');
  assert.equal(kind(page.el('a', { href: '/CHECKOUT/' })), 'link');
  assert.equal(kind(page.el('a', { href: 'https://vitrine.example.com/checkout?discount=X' })), 'link');
  assert.equal(page.hook.isCheckoutPath('/apps/checkout-bridge/checkout'), false);
  assert.equal(page.hook.isCheckoutPath(null), false);
});

test('na página /pages/checkout, forms sem action seguem nativos (submit e form.submit())', async () => {
  const page = new Page({ href: 'https://vitrine.example.com/pages/checkout' });
  const search = page.form({ method: 'get' });
  page.input(search, { type: 'search', name: 'q' }, 'meias');
  assert.equal(page.submit(search, null).defaultPrevented, false);
  search.submit();
  assert.deepEqual(page.doc.nativeSubmits, [search]);
  await flush();
  assert.equal(page.hook.state.busy, false);
  assert.deepEqual(page.fetchCalls, []);
  assert.deepEqual(page.assigned, []);
});

test('com prefixo de idioma, /pt-br/checkout e /checkout são gatilhos; /pt-br/pages/checkout não', () => {
  const page = new Page({ shopify: { routes: { root: '/pt-br/' } } });
  const kind = (el: FakeElement): string | null => page.hook.findTrigger([el, page.doc.body, page.doc])?.kind ?? null;
  assert.equal(kind(page.el('a', { href: '/pt-br/checkout' })), 'link');
  assert.equal(kind(page.el('a', { href: '/checkout' })), 'link');
  // Outro prefixo de idioma ainda é a rota; qualquer outro segmento é conteúdo.
  assert.equal(kind(page.el('a', { href: '/en/checkout' })), 'link');
  assert.equal(kind(page.el('a', { href: '/en-ca/checkout' })), 'link');
  assert.equal(kind(page.el('a', { href: '/pt-br/pages/checkout' })), null);
  assert.equal(kind(page.el('a', { href: '/en/pages/checkout' })), null);
  assert.equal(kind(page.el('a', { href: '/news/checkout' })), null);
  assert.equal(kind(page.el('a', { href: '/pt-br/checkout/extra' })), null);
});

test('form de carrinho é só o da rota /cart exata: /collections/cart não é salvo nem interceptado no submit', async () => {
  const page = new Page();
  const form = page.form({ id: 'f', action: '/collections/cart', method: 'post' });
  page.input(form, { type: 'hidden', name: 'note' }, 'x');
  const button = page.el('button', { type: 'submit', name: 'checkout', form: 'f' });
  assert.equal(page.submit(form, button).defaultPrevented, false);
  // O botão name=checkout continua sendo um gatilho no clique, mas não há form de carrinho a salvar.
  page.click(button);
  await page.idle();
  assert.deepEqual(page.fetchCalls.map((c) => c.url), ['/cart.js', '/apps/checkout-bridge/checkout']);
});

test('form de produto é o da rota /cart/add exata; /pages/add não serve e cai no form de produto da página', async () => {
  const page = new Page({ href: 'https://vitrine.example.com/products/x', config: { acceleratedButtons: 'intercept' } });
  const real = page.form({ id: 'real', action: '/cart/add', method: 'post' });
  page.input(real, { type: 'hidden', name: 'id' }, '77');
  const fake = page.form({ id: 'fake', action: '/pages/add', method: 'post' });
  page.input(fake, { type: 'hidden', name: 'id' }, '88');
  const button = page.el('shopify-accelerated-checkout', {}, fake);
  page.click(button);
  await page.idle();
  assert.deepEqual(page.checkoutPost()?.body['lines'], [{ variantId: '77', quantity: 1 }]);
});

// ---------------------------------------------------------------------------------------
// Limites de propriedade: o script e o serviço aplicam os mesmos números
// ---------------------------------------------------------------------------------------

test('o script recebe os limites de propriedade do serviço (src/checkout/limits.ts)', () => {
  const page = new Page();
  assert.deepEqual(plain(page.hook.config.limits), { ...PROPERTY_LIMITS });
});

test('carga do carrinho com propriedades nos limites passa pelo schema do serviço', () => {
  const page = new Page();
  const many = Object.fromEntries(Array.from({ length: PROPERTY_LIMITS.maxProperties + 1 }, (_, i) => [`k${i}`, 'v']));
  const cart = {
    items: [
      { variant_id: 1, quantity: 1, properties: { Mensagem: 'a'.repeat(PROPERTY_LIMITS.maxValueLength) } },
      { variant_id: 2, quantity: 1, properties: many },
      { variant_id: 3, quantity: 1, properties: { ['x'.repeat(PROPERTY_LIMITS.maxKeyLength + 1)]: 'v', ok: 'sim' } },
    ],
  };
  const parsed = parseCheckoutBody(plain(page.hook.buildCartPayload(cart)));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  assert.equal(parsed.value.lines[0]?.properties?.['Mensagem']?.length, PROPERTY_LIMITS.maxValueLength);
  assert.equal(Object.keys(parsed.value.lines[1]?.properties ?? {}).length, PROPERTY_LIMITS.maxProperties);
  assert.deepEqual(parsed.value.lines[2]?.properties, { ok: 'sim' });
});

test('valor de propriedade acima do limite interrompe o checkout do carrinho com mensagem específica, sem chamar o proxy', async () => {
  const long = { token: 't', items: [{ variant_id: 1, quantity: 1, properties: { Mensagem: 'a'.repeat(PROPERTY_LIMITS.maxValueLength + 1) } }] };
  const { page, checkout } = cartPage({ router: (url) => (url.endsWith('cart.js') ? jsonResponse(long) : page.defaultRoute(url)) });
  assert.throws(() => page.hook.buildCartPayload(long), /longa demais/);
  page.click(checkout);
  assert.equal(await page.idle(), false);
  assert.equal(page.checkoutPost(), null);
  assert.deepEqual(page.assigned, []);
  assert.equal(page.hook.state.busy, false);
  assert.equal(checkout.disabled, false);
  const text = page.alertBox()?.childNodes[0]?.textContent ?? '';
  assert.ok(text.includes('longa demais'), text);
});

test('compra direta com personalização longa demais mostra a mensagem específica e não chama o proxy', async () => {
  const { page, form, button } = productPage({ config: { acceleratedButtons: 'intercept' } });
  page.input(form, { type: 'text', name: 'properties[Mensagem]' }, 'a'.repeat(PROPERTY_LIMITS.maxValueLength + 1));
  assert.throws(() => page.hook.readBuyNowLine(form), /longa demais/);
  assert.equal(page.click(button).defaultPrevented, true);
  await flush();
  assert.deepEqual(page.fetchCalls, []);
  assert.equal(page.hook.state.busy, false);
  const text = page.alertBox()?.childNodes[0]?.textContent ?? '';
  assert.ok(text.includes('longa demais'), text);
});

test('compra direta nos limites passa pelo schema do serviço', () => {
  const { page, form } = productPage();
  page.input(form, { type: 'text', name: 'properties[Mensagem]' }, 'a'.repeat(PROPERTY_LIMITS.maxValueLength));
  page.input(form, { type: 'text', name: `properties[${'k'.repeat(PROPERTY_LIMITS.maxKeyLength + 1)}]` }, 'v');
  for (let i = 0; i < PROPERTY_LIMITS.maxProperties + 5; i += 1) page.input(form, { type: 'text', name: `properties[p${i}]` }, 'v');
  const line = plain<Record<string, unknown>>(page.hook.readBuyNowLine(form));
  const parsed = parseCheckoutBody({ lines: [line], source: 'buy_now' });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  const properties = parsed.value.lines[0]?.properties ?? {};
  assert.equal(Object.keys(properties).length, PROPERTY_LIMITS.maxProperties);
  assert.equal(properties['Mensagem']?.length, PROPERTY_LIMITS.maxValueLength);
  assert.equal(properties['Gravação'], 'Ana');
});

// ---------------------------------------------------------------------------------------
// Nonce do navegador
// ---------------------------------------------------------------------------------------

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

test('nonce do navegador: gerado uma vez por página, guardado em sessionStorage e reaproveitado', () => {
  const page = new Page();
  const nonce = page.hook.getClientNonce();
  assert.match(nonce, NONCE_RE);
  assert.equal(page.hook.getClientNonce(), nonce);
  assert.equal(page.session.get('cb_nonce'), nonce);
  assert.equal(page.storage.has('cb_nonce'), false);
  // Outra página da mesma aba reaproveita o nonce guardado; um valor fora do formato é trocado.
  const next = new Page({ session: { cb_nonce: nonce } });
  assert.equal(next.hook.getClientNonce(), nonce);
  const bad = new Page({ session: { cb_nonce: 'curto' } });
  assert.notEqual(bad.hook.getClientNonce(), 'curto');
  assert.match(bad.hook.getClientNonce(), NONCE_RE);
  assert.equal(bad.session.get('cb_nonce'), bad.hook.getClientNonce());
  // Páginas distintas sem nonce guardado geram nonces distintos.
  assert.notEqual(new Page().hook.getClientNonce(), nonce);
});

test('o nonce vai na requisição do carrinho e da compra direta, e passa pelo schema do serviço', async () => {
  const cart = cartPage();
  cart.page.click(cart.checkout);
  assert.equal(await cart.page.idle(), true);
  const cartPost = cart.page.checkoutPost();
  assert.ok(cartPost);
  assert.equal(cartPost.body['clientNonce'], cart.page.hook.getClientNonce());
  assert.equal(cartPost.body['source'], 'cart');
  assert.ok(parseCheckoutBody(cartPost.body).ok);
  // A carga montada do carrinho não leva o nonce; ele entra só na hora de enviar.
  assert.equal('clientNonce' in cart.page.hook.buildCartPayload(sampleCart()), false);

  const product = productPage({ config: { acceleratedButtons: 'intercept' } });
  product.page.click(product.button);
  await product.page.idle();
  const buyNowPost = product.page.checkoutPost();
  assert.ok(buyNowPost);
  assert.equal(buyNowPost.body['source'], 'buy_now');
  assert.equal(buyNowPost.body['clientNonce'], product.page.hook.getClientNonce());
  assert.ok(parseCheckoutBody(buyNowPost.body).ok);
  assert.notEqual(buyNowPost.body['clientNonce'], cartPost.body['clientNonce']);
});

test('nonce sobrevive à falha de armazenamento e à falta de randomUUID ou de Web Crypto', async () => {
  const noStorage = new Page({ storage: 'throws' });
  const nonce = noStorage.hook.getClientNonce();
  assert.match(nonce, NONCE_RE);
  assert.equal(noStorage.hook.getClientNonce(), nonce);
  assert.equal(noStorage.session.size, 0);
  await noStorage.bridge.checkout();
  assert.equal(noStorage.checkoutPost()?.body['clientNonce'], nonce);

  const bytes = new Page({ crypto: 'bytes' });
  assert.match(bytes.hook.getClientNonce(), /^[0-9a-f]{32}$/);
  const none = new Page({ crypto: 'none' });
  assert.match(none.hook.getClientNonce(), NONCE_RE);
  assert.equal(none.logs.length, 0);
});

// ---------------------------------------------------------------------------------------
// Form do carrinho: só nota, atributos e quantidades vão para cart/update.js
// ---------------------------------------------------------------------------------------

test('cart/update.js recebe só note, attributes[...] e updates[...]; sem esses campos nada é enviado', async () => {
  const { page, form, checkout } = cartPage();
  page.input(form, { type: 'text', name: 'discount' }, '');
  page.input(form, { type: 'text', name: 'attributes[Presente]' }, 'sim');
  page.input(form, { type: 'hidden', name: 'updates[123]' }, '2');
  page.input(form, { type: 'hidden', name: 'sections' }, 'cart-drawer');
  page.click(checkout);
  await page.idle();
  const save = page.fetchCalls[0];
  assert.equal(save?.url, '/cart/update.js');
  assert.ok(save?.init.body instanceof FakeFormData);
  assert.deepEqual(save.init.body.entries, [
    ['updates[]', '3'],
    ['attributes[Presente]', 'sim'],
    ['updates[123]', '2'],
    ['note', 'embrulhar'],
  ]);

  const only = new Page();
  const bare = only.form({ id: 'cart', action: '/cart', method: 'post' });
  only.input(bare, { type: 'hidden', name: 'form_type' }, 'cart');
  only.input(bare, { type: 'hidden', name: 'discount' }, '');
  only.click(only.el('button', { type: 'submit', name: 'checkout', form: 'cart' }));
  await only.idle();
  assert.deepEqual(only.fetchCalls.map((c) => c.url), ['/cart.js', '/apps/checkout-bridge/checkout']);
  assert.deepEqual(only.assigned, [CHECKOUT_URL]);
});
