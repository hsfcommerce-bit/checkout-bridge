import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { markdownToHtml } from '../../admin/markdown.ts';
import type { AdminDeps, AdminEnv } from './context.ts';
import { takeFlash } from './context.ts';
import { page } from './layout.ts';

/**
 * Guia dentro do painel: os documentos do projeto (docs/INSTALACAO.md e docs/ARQUITETURA.md)
 * convertidos por src/admin/markdown.ts. Só arquivos de uma lista fixa são lidos; o nome
 * vindo da URL nunca vira caminho.
 */

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');

const GUIDES: ReadonlyArray<{ key: string; file: string; label: string }> = [
  { key: 'instalacao', file: 'INSTALACAO.md', label: 'Instalação passo a passo' },
  { key: 'arquitetura', file: 'ARQUITETURA.md', label: 'Como funciona' },
];

const cache = new Map<string, string>();

function renderGuide(file: string): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let markdown: string;
  try {
    markdown = readFileSync(join(DOCS_DIR, file), 'utf8');
  } catch {
    markdown = '# Documento indisponível\n\nO arquivo deste guia não foi encontrado na instalação.';
  }
  const rendered = markdownToHtml(markdown);
  cache.set(file, rendered);
  return rendered;
}

export function guidePage(deps: AdminDeps, c: Context<AdminEnv>): Response | Promise<Response> {
  void deps;
  const wanted = c.req.query('doc');
  const guide = GUIDES.find((g) => g.key === wanted) ?? GUIDES[0]!;
  const body = html`<nav class="seg guide-tabs" aria-label="Guias">
      ${GUIDES.map((g) =>
        g.key === guide.key
          ? html`<a href="/admin/guide?doc=${g.key}" aria-current="true">${g.label}</a>`
          : html`<a href="/admin/guide?doc=${g.key}">${g.label}</a>`,
      )}
    </nav>
    <article class="card prose">${raw(renderGuide(guide.file))}</article>`;
  return c.html(
    page({
      title: 'Guia',
      description: 'Como instalar nas lojas, configurar o App Proxy e operar a ponte no dia a dia.',
      active: 'guide',
      session: c.get('session'),
      flash: takeFlash(c),
      body,
    }),
  );
}
