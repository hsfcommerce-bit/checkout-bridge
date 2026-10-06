/**
 * Conversor mínimo e seguro de Markdown para HTML, usado só para exibir os documentos do
 * próprio projeto (docs/*.md) dentro do painel.
 *
 * Suporta: títulos (#..####), parágrafos, listas com - ou * e numeradas, blocos de código
 * com cercas, código em linha, negrito, itálico e links http(s). Tudo o mais vira texto.
 * Cada trecho de texto passa pelo escape antes de entrar na marcação; nenhum HTML do
 * arquivo é copiado como está, então um "<script>" escrito no Markdown aparece como texto.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(trimmed)) return trimmed;
  if (/^#[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

/** Formatação em linha: código, negrito, itálico e links. O texto já chega escapado. */
function inline(escaped: string): string {
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href === null ? label : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === null) return;
    out.push(`<${list.kind}>${list.items.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('')}</${list.kind}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const text = heading[2]!;
      out.push(`<h${level} id="${escapeHtml(slug(text))}">${inline(escapeHtml(text))}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const kind: 'ul' | 'ol' = bullet !== null ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1]!;
      if (list === null || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push(item);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (list !== null && /^\s{2,}/.test(raw)) {
      // Continuação de item de lista (linha indentada).
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join('\n');
}
