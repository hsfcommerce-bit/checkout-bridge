import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdownToHtml } from '../src/admin/markdown.ts';
import { periodRange } from '../src/routes/admin/periods.ts';

describe('conversor de Markdown do guia', () => {
  it('converte o subconjunto suportado e escapa tudo o mais', () => {
    const out = markdownToHtml('# Título\n\nTexto com `código`, **negrito** e [link](https://exemplo.com/x).\n\n- um\n- dois\n\n1. a\n2. b\n\n```\n<b>cru</b>\n```\n\n<script>alert(1)</script> e [ruim](javascript:alert(1))');
    assert.ok(out.includes('<h1 id="titulo">Título</h1>'));
    assert.ok(out.includes('<code>código</code>') && out.includes('<strong>negrito</strong>'));
    assert.ok(out.includes('<a href="https://exemplo.com/x" rel="noopener noreferrer">link</a>'));
    assert.ok(out.includes('<ul><li>um</li><li>dois</li></ul>') && out.includes('<ol><li>a</li><li>b</li></ol>'));
    assert.ok(out.includes('<pre><code>&lt;b&gt;cru&lt;/b&gt;</code></pre>'));
    assert.ok(!out.includes('<script>') && out.includes('&lt;script&gt;'));
    assert.ok(!out.includes('javascript:') && out.includes('ruim'));
  });
});

describe('períodos do painel (UTC)', () => {
  const now = Date.UTC(2026, 9, 6, 15, 30); // 06/10/2026 15:30 UTC
  it('hoje, ontem, 7 dias, 30 dias e mês', () => {
    assert.deepEqual(periodRange('hoje', now), { since: '2026-10-06T00:00:00.000Z', until: '2026-10-06T23:59:59.999Z' });
    assert.deepEqual(periodRange('ontem', now), { since: '2026-10-05T00:00:00.000Z', until: '2026-10-05T23:59:59.999Z' });
    assert.equal(periodRange('7d', now).since, '2026-09-30T00:00:00.000Z');
    assert.equal(periodRange('30d', now).since, '2026-09-07T00:00:00.000Z');
    assert.equal(periodRange('mes', now).since, '2026-10-01T00:00:00.000Z');
  });
});
