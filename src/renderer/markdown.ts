// A small, dependency-free Markdown renderer for assistant messages.
// Everything is escaped; only the constructs below produce markup:
// headings, paragraphs (single newlines become <br>), fenced code (with language label, copy button and
// highlighting), blockquotes, horizontal rules, tables (with alignment), nested ordered/unordered lists,
// task lists, inline code, bold, italics (* and _), bold-italics, strikethrough, links, autolinks.

import { escapeHtml } from './dom.js';
import { highlight } from './highlight.js';
import { icon } from './icons.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`\n]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

const indentOf = (line: string): number => /^[ ]*/.exec(line)![0].length;

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_DELIM.test(lines[i + 1]);
}

function isBlockStart(lines: string[], i: number): boolean {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || isTableStart(lines, i);
}

// ---------- inline ----------

function anchor(href: string, innerHtml: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${innerHtml}</a>`;
}

/** Splits a trailing run of punctuation (and unbalanced closing parens) off a bare URL. */
function trimUrl(url: string): [string, string] {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if ('.,;:!?*_~\'"'.includes(c)) end--;
    else if (c === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--;
    else break;
  }
  return [url.slice(0, end), url.slice(end)];
}

export function inline(src: string, links = true): string {
  const slots: string[] = [];
  const stash = (html: string): string => `\u0000${slots.push(html) - 1}\u0001`;
  let s = src.replace(/[\u0000\u0001]/g, '');
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t: string, code: string) => stash(`<code>${escapeHtml(code.replace(/^ ([\s\S]*) $/, '$1'))}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_m, c: string) => stash(escapeHtml(c)));
  if (links) {
    s = s.replace(/!?\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (m, text: string, url: string) =>
      SAFE_URL.test(url) ? stash(anchor(url, inline(text, false))) : m,
    );
    s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (_m, url: string) => stash(anchor(url, escapeHtml(url))));
    s = s.replace(/\bhttps?:\/\/[^\s<>"'`\u0000\u0001]+/g, (raw) => {
      const [url, rest] = trimUrl(raw);
      return url.length > 8 ? stash(anchor(url, escapeHtml(url))) + rest : raw;
    });
  }
  const wrap = (open: string, close: string) => (_m: string, t: string) => stash(open) + t + stash(close);
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, wrap('<strong><em>', '</em></strong>'));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, wrap('<strong>', '</strong>'));
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_m, pre: string, t: string) => pre + stash('<strong>') + t + stash('</strong>'));
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, (_m, pre: string, t: string) => pre + stash('<em>') + t + stash('</em>'));
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, (_m, pre: string, t: string) => pre + stash('<em>') + t + stash('</em>'));
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, wrap('<del>', '</del>'));
  let out = escapeHtml(s).replace(/\n/g, '<br>');
  for (let guard = 0; guard < 8 && out.includes('\u0000'); guard++) out = out.replace(/\u0000(\d+)\u0001/g, (_m, n: string) => slots[Number(n)] ?? '');
  return out;
}

// ---------- blocks ----------

function codeBlock(code: string, lang: string): string {
  const label = lang ? `<span class="code-lang">${escapeHtml(lang.toLowerCase())}</span>` : '<span class="code-lang"></span>';
  return (
    `<div class="code-block"><div class="code-head">${label}` +
    `<button type="button" class="code-copy" aria-label="Copy code">${icon('copy', 14)}<span>Copy</span></button></div>` +
    `<pre><code>${highlight(code, lang || null)}</code></pre></div>`
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function table(lines: string[], start: number): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const al = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
  const th = head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${head.map((_c, k) => `<td${al(k)}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('');
  return { html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`, next: i };
}

function list(lines: string[], start: number): { html: string; next: number } {
  const first = ITEM.exec(lines[start])!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: string[][] = [];
  let loose = false;
  let contentIndent = base + first[2].length + 1;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const nm = ITEM.exec(lines[j]);
      const ind = indentOf(lines[j]);
      if (nm && ind >= base && ind < base + 2 && /\d/.test(nm[2]) === ordered) loose = true;
      else if (!(ind > base && ind >= Math.min(contentIndent, base + 2))) break;
      items[items.length - 1].push('');
      i = j;
      continue;
    }
    const m = ITEM.exec(line);
    const ind = indentOf(line);
    if (m && ind < base) break;
    if (m && ind < base + 2) {
      if (/\d/.test(m[2]) !== ordered) break;
      contentIndent = ind + m[2].length + 1;
      items.push([m[3] ?? '']);
      i++;
      continue;
    }
    if (ind > base) {
      items[items.length - 1].push(line.slice(Math.min(ind, contentIndent)));
      i++;
      continue;
    }
    if (lines[i - 1]?.trim() && !isBlockStart(lines, i)) {
      items[items.length - 1].push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  let isTasks = false;
  const lis = items
    .map((itemLines) => {
      let done: boolean | null = null;
      const tm = /^\[([ xX])\][ \t]+/.exec(itemLines[0]);
      if (tm) {
        done = tm[1] !== ' ';
        isTasks = true;
        itemLines = [itemLines[0].slice(tm[0].length), ...itemLines.slice(1)];
      }
      const blocks = parseBlocks(itemLines);
      let html = blocks.join('');
      if (!loose && blocks[0]?.startsWith('<p>')) html = blocks[0].slice(3, -4) + blocks.slice(1).join('');
      if (done === null) return `<li>${html}</li>`;
      return `<li class="task${done ? ' done' : ''}"><span class="task-box">${done ? icon('check', 12) : ''}</span><div class="task-text">${html}</div></li>`;
    })
    .join('');
  return { html: `<${tag}${startAttr}${isTasks ? ' class="tasks"' : ''}>${lis}</${tag}>`, next: i };
}

function parseBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const lang = m[2] ?? '';
      const ind = indentOf(line);
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(ind ? lines[i].replace(new RegExp(`^ {0,${ind}}`), '') : lines[i]);
        i++;
      }
      i++;
      out.push(codeBlock(body.join('\n'), lang));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      out.push(`<blockquote>${parseBlocks(inner).join('')}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const t = table(lines, i);
      out.push(t.html);
      i = t.next;
      continue;
    }
    if (ITEM.test(line)) {
      const l = list(lines, i);
      out.push(l.html);
      i = l.next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines, i))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));
  return parseBlocks(lines).join('');
}
