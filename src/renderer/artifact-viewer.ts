// The artifact viewer page's script (served as artifact://view/_app/artifact-viewer.js). The page embeds the
// artifact's source as JSON; this renders Markdown with the app's renderer or code with its highlighter.

import { highlight, resolveLang } from './highlight.js';
import { renderMarkdown } from './markdown.js';

interface Embedded {
  kind: 'markdown' | 'code';
  language: string | null;
  source: string;
}

const data = JSON.parse(document.getElementById('src')?.textContent ?? '{}') as Partial<Embedded>;
const source = typeof data.source === 'string' ? data.source : '';

if (data.kind === 'code') {
  const pre = document.getElementById('code');
  if (pre) {
    const lang = data.language ? resolveLang(data.language) : null;
    const lines = highlight(source.replace(/\n$/, ''), lang).split('\n');
    pre.innerHTML = lines.map((l) => `<span class="ln">${l || ' '}</span>`).join('');
  }
} else {
  const md = document.getElementById('md');
  if (md) md.innerHTML = renderMarkdown(source);
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('pre, code');
    if (code) navigator.clipboard.writeText(code.textContent ?? '').catch(() => undefined);
  });
}
