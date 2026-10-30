// Line diffs (LCS) and the diff component used by edit/write tool rows and approval cards.

import { basename, dirname, escapeHtml } from './dom.js';
import { highlight, langFromPath } from './highlight.js';

export type DiffKind = 'add' | 'del' | 'ctx';
export interface DiffRow {
  kind: DiffKind;
  text: string;
  /** Line number shown in the gutter: the old number for deletions, the new number otherwise. */
  no?: number;
}

export function lineDiff(a: string, b: string): DiffRow[] {
  const x = a.split('\n');
  const y = b.split('\n');
  // Trim the common prefix and suffix first; the LCS only runs on the changed middle.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const mid: DiffRow[] = [];
  const n = xs.length;
  const m = ys.length;
  if (n * m > 400_000) {
    mid.push(...xs.map((t) => ({ kind: 'del' as const, text: t })), ...ys.map((t) => ({ kind: 'add' as const, text: t })));
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) {
        mid.push({ kind: 'ctx', text: xs[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ kind: 'del', text: xs[i++] });
      else mid.push({ kind: 'add', text: ys[j++] });
    }
    while (i < n) mid.push({ kind: 'del', text: xs[i++] });
    while (j < m) mid.push({ kind: 'add', text: ys[j++] });
  }
  return [...x.slice(0, pre).map((t) => ({ kind: 'ctx' as const, text: t })), ...mid, ...x.slice(x.length - suf).map((t) => ({ kind: 'ctx' as const, text: t }))];
}

/** Assigns gutter numbers, given the 1-based line where the snippet starts in the old and new file. */
export function numberRows(rows: DiffRow[], startOld: number, startNew = startOld): DiffRow[] {
  let o = startOld;
  let nw = startNew;
  return rows.map((r) => {
    if (r.kind === 'del') return { ...r, no: o++ };
    if (r.kind === 'add') return { ...r, no: nw++ };
    o++;
    return { ...r, no: nw++ };
  });
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }
  return { added, removed };
}

export function statHtml(added: number, removed: number): string {
  const parts: string[] = [];
  if (added || !removed) parts.push(`<span class="git-add">+${added}</span>`);
  if (removed) parts.push(`<span class="git-del">−${removed}</span>`);
  return parts.join(' ');
}

let baseDir = '';
/** Paths under this directory are shown relative to it in diff headers. */
export function setDiffBaseDir(dir: string): void {
  baseDir = dir.replace(/\/+$/, '');
}
function displayPath(path: string): string {
  if (baseDir && path.startsWith(baseDir + '/')) return path.slice(baseDir.length + 1);
  return path.replace(/^\/Users\/[^/]+(?=\/)/, '~');
}

/** A file header (dir dim, basename bold) for diffs and file tool rows. */
export function pathHtml(path: string): string {
  const shown = displayPath(path);
  return `<span class="path" title="${escapeHtml(path)}"><span class="path-dir">${escapeHtml(dirname(shown))}</span><span class="path-base">${escapeHtml(basename(shown))}</span></span>`;
}

export interface DiffOptions {
  /** Collapse unchanged runs to this many lines of context around each change; the gaps expand on click. */
  context?: number;
  /** Render at most this many rows up front; the rest sit behind a "N more lines" row that expands on click. */
  limit?: number;
  /** Extra class on the component, e.g. "fill" to fill a pane instead of capping the height */
  className?: string;
}

const SIGN: Record<DiffKind, string> = { add: '+', del: '−', ctx: '' };

function lineHtml(r: DiffRow, numbered: boolean, lang: string | null): string {
  return `<div class="line ${r.kind}">${numbered ? `<span class="ln">${r.no ?? ''}</span>` : ''}<span class="sg">${SIGN[r.kind]}</span><span class="tx">${
    r.text ? highlight(r.text, lang) : '​'
  }</span></div>`;
}

function gapHtml(index: number, hidden: number, label: string, numbered: boolean): string {
  return `<div class="line gap" role="button" tabindex="0" data-gap="${index}" title="Show ${hidden} line${hidden === 1 ? '' : 's'}">${
    numbered ? '<span class="ln"></span>' : ''
  }<span class="sg">⋯</span><span class="tx">${escapeHtml(label)}</span></div>`;
}

export function renderDiff(path: string, rows: DiffRow[], opts: DiffOptions = {}): HTMLElement {
  const { added, removed } = diffStats(rows);
  const numbered = rows.some((r) => r.no !== undefined);
  const lang = langFromPath(path);
  const el = document.createElement('div');
  el.className = 'diff' + (numbered ? '' : ' no-numbers') + (opts.className ? ` ${opts.className}` : '');

  // Which rows are shown up front; hidden runs become expandable gap rows.
  const show = rows.map(() => opts.context === undefined);
  if (opts.context !== undefined) {
    const c = Math.max(0, opts.context);
    rows.forEach((r, i) => {
      if (r.kind === 'ctx') return;
      for (let k = Math.max(0, i - c); k <= Math.min(rows.length - 1, i + c); k++) show[k] = true;
    });
    if (!rows.some((r) => r.kind !== 'ctx')) show.fill(true);
  }
  if (opts.limit !== undefined) {
    let shown = 0;
    show.forEach((v, i) => {
      if (v && ++shown > opts.limit!) show[i] = false;
    });
  }
  const gaps: DiffRow[][] = [];
  const parts: string[] = [];
  for (let i = 0; i < rows.length; ) {
    if (show[i]) {
      parts.push(lineHtml(rows[i], numbered, lang));
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !show[j]) j++;
    const run = rows.slice(i, j);
    // Hiding fewer than 4 lines saves nothing; show them.
    if (run.length < 4 && run.every((r) => r.kind === 'ctx')) parts.push(...run.map((r) => lineHtml(r, numbered, lang)));
    else {
      const trailing = j === rows.length && run.some((r) => r.kind !== 'ctx');
      const n = run.length;
      const label = trailing ? `${n} more line${n === 1 ? '' : 's'}` : `${n} unchanged line${n === 1 ? '' : 's'}`;
      parts.push(gapHtml(gaps.length, n, label, numbered));
      gaps.push(run);
    }
    i = j;
  }
  el.innerHTML = `<div class="diff-head">${pathHtml(path)}<span class="diff-stat">${statHtml(added, removed)}</span></div><div class="diff-body">${parts.join('')}</div>`;
  if (gaps.length) {
    const expand = (gap: HTMLElement) => {
      const run = gaps[Number(gap.dataset.gap)];
      if (!run) return;
      gap.insertAdjacentHTML('afterend', run.map((r) => lineHtml(r, numbered, lang)).join(''));
      gap.remove();
    };
    el.addEventListener('click', (e) => {
      const gap = (e.target as HTMLElement).closest<HTMLElement>('.line.gap');
      if (gap && el.contains(gap)) expand(gap);
    });
    el.addEventListener('keydown', (e) => {
      const gap = (e.target as HTMLElement).closest<HTMLElement>('.line.gap');
      if (gap && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        expand(gap);
      }
    });
  }
  return el;
}

/** Parses the edit_file approval preview: "<file>\n--- old\n<old>\n+++ new\n<new>". */
export function parseEditPreview(detail: string): { path: string; oldText: string; newText: string } | null {
  const a = detail.indexOf('\n--- old\n');
  const b = detail.lastIndexOf('\n+++ new\n');
  if (a < 0 || b < a) return null;
  return { path: detail.slice(0, a), oldText: detail.slice(a + 9, b), newText: detail.slice(b + 9) };
}
