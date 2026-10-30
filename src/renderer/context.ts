// The context meter in the composer footer (tokens used against the model's window, with a popover to compact
// or open Settings) and the compaction divider that marks where earlier messages were folded into a summary.

import type { CompactionInfo, ContextInfo } from '../shared/types';
import { escapeHtml, formatCount } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { closeMenu, menuAnchoredTo, openMenu, type MenuHandle, type MenuSection } from './popover.js';

/** Context windows as people say them: 16384 → "16k", 131072 → "128k", 128000 → "128k", 1048576 → "1M". */
export function formatWindow(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  // Round thousands first (128000 is also 125 × 1024), then the power-of-two sizes Ollama uses.
  if (v >= 1000 && v % 1000 === 0) return formatCount(v);
  if (v >= 1_048_576 && v % 1_048_576 === 0) return `${v / 1_048_576}M`;
  if (v >= 1024 && v % 1024 === 0) return `${v / 1024}k`;
  return formatCount(v);
}

/** A context estimate the meter can show (a positive limit), normalised; null otherwise. */
export function normalizeContext(info: unknown): ContextInfo | null {
  if (!info || typeof info !== 'object') return null;
  const c = info as Partial<ContextInfo>;
  const limit = Math.round(Number(c.limit));
  const tokens = Math.max(0, Math.round(Number(c.tokens) || 0));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const threshold = Number(c.threshold);
  return { tokens, limit, threshold: threshold > 0 && threshold <= 1 ? threshold : 0.8, autoCompact: c.autoCompact !== false };
}

export type ContextLevel = 'ok' | 'warn' | 'danger';

/** Rounded percentage used, and its level: neutral below 70%, amber 70–90%, red above 90%. */
export function contextUsage(c: ContextInfo): { pct: number; text: string; level: ContextLevel } {
  const pct = Math.round((c.tokens / c.limit) * 100);
  const text = c.tokens > 0 && pct === 0 ? '<1%' : `${pct}%`;
  return { pct, text, level: pct > 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok' };
}

/** "auto-compacts at 80%" or "auto-compact off" */
function autoText(c: ContextInfo): string {
  return c.autoCompact ? `auto-compacts at ${Math.round(c.threshold * 100)}%` : 'auto-compact off';
}

/** "Context 6.7k of 16k tokens · auto-compacts at 80%" */
export function contextTip(c: ContextInfo): string {
  return `Context ${formatCount(c.tokens)} of ${formatWindow(c.limit)} tokens · ${autoText(c)}`;
}

function ring(fraction: number, size: number): string {
  const fill = Math.max(0, Math.min(100, fraction * 100));
  return (
    `<svg class="meter-ring" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
    `<circle class="meter-track" cx="8" cy="8" r="6"/>` +
    `<circle class="meter-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="${fill.toFixed(1)} 100" transform="rotate(-90 8 8)"/></svg>`
  );
}

/** The numbers at the top of the meter's popover: percentage, a bar with the auto-compact mark, tokens of window. */
function popoverHeader(c: ContextInfo): string {
  const u = contextUsage(c);
  const fill = Math.max(0, Math.min(100, (c.tokens / c.limit) * 100));
  const mark = c.autoCompact ? `<span class="ctx-mark" style="left: ${(c.threshold * 100).toFixed(1)}%"></span>` : '';
  return (
    `<div class="ctx-head ${u.level}">` +
    `<div class="ctx-row"><span class="ctx-title">Context window</span><span class="ctx-pct">${escapeHtml(u.text)}</span></div>` +
    `<div class="ctx-bar" role="presentation"><span class="ctx-fill" style="width: ${fill.toFixed(1)}%"></span>${mark}</div>` +
    `<div class="ctx-meta">${escapeHtml(`${formatCount(c.tokens)} of ${formatWindow(c.limit)} tokens · ${autoText(c)}`)}</div>` +
    `</div>`
  );
}

export interface ContextMeterOptions {
  /** #context-meter */
  button: HTMLButtonElement;
  /** The popover stays horizontally inside this element */
  boundary?: HTMLElement;
  /** A run or a compaction is in progress: "Compact now" is disabled */
  busy: () => boolean;
  compact: () => void;
  openSettings: () => void;
}

export interface ContextMeter {
  /** Shows the estimate (null hides the meter) */
  set(info: ContextInfo | null): void;
  get(): ContextInfo | null;
}

export function createContextMeter(o: ContextMeterOptions): ContextMeter {
  const btn = o.button;
  let info: ContextInfo | null = null;
  let menu: MenuHandle | null = null;

  const render = () => {
    if (!info) {
      btn.hidden = true;
      btn.innerHTML = '';
      delete btn.dataset.level;
      if (menuAnchoredTo(btn)) closeMenu();
      return;
    }
    const u = contextUsage(info);
    btn.hidden = false;
    btn.dataset.level = u.level;
    btn.classList.toggle('warn', u.level === 'warn');
    btn.classList.toggle('danger', u.level === 'danger');
    btn.innerHTML = `${ring(info.tokens / info.limit, 14)}<span class="meter-pct">${escapeHtml(u.text)}</span>`;
    btn.dataset.tip = contextTip(info);
    btn.setAttribute('aria-label', `Context: ${u.text} used, ${formatCount(info.tokens)} of ${formatWindow(info.limit)} tokens`);
    if (menu && menuAnchoredTo(btn)) menu.setHeader(popoverHeader(info));
  };

  const sections = (): MenuSection[] => [
    {
      items: [
        { label: 'Compact now', description: 'Summarise the conversation to free context', icon: 'fold', disabled: o.busy(), onSelect: o.compact },
        { label: 'Open settings', icon: 'settings', hint: '⌘,', onSelect: o.openSettings },
      ],
    },
  ];

  btn.addEventListener('click', () => {
    if (menuAnchoredTo(btn)) return closeMenu();
    if (!info) return;
    menu = openMenu(sections(), {
      anchor: btn,
      placement: 'top-start',
      boundary: o.boundary,
      minWidth: 280,
      className: 'context-menu',
      header: popoverHeader(info),
      onClose: () => (menu = null),
    });
  });

  return {
    set(next: ContextInfo | null) {
      info = next ? normalizeContext(next) : null;
      render();
    },
    get: () => info,
  };
}

// ---------- Compaction divider ----------

/** "Context compacted · 14.2k → 2.1k tokens" over a thin rule; the chevron opens the summary (collapsed by default). */
export function createCompactionDivider(c: CompactionInfo): HTMLDetailsElement {
  const el = document.createElement('details');
  el.className = 'compaction';
  if (c?.id) el.dataset.compactionId = String(c.id);
  const before = Math.max(0, Math.round(Number(c?.tokensBefore) || 0));
  const after = Math.max(0, Math.round(Number(c?.tokensAfter) || 0));
  const label = `Context compacted · ${formatCount(before)} → ${formatCount(after)} tokens`;
  const folded = Math.max(0, Math.round(Number(c?.messages) || 0));
  const meta: string[] = [c?.reason === 'auto' ? 'Compacted automatically near the context limit' : 'Compacted with /compact'];
  if (folded) meta.push(`${folded} earlier message${folded === 1 ? '' : 's'} summarised`);
  const at = Number(c?.createdAt);
  if (at > 0) meta.push(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  el.innerHTML =
    `<summary><span class="compaction-rule"></span>` +
    `<span class="compaction-label"><span class="compaction-icon">${icon('fold', 14)}</span><span class="compaction-text">${escapeHtml(label)}</span>` +
    `<span class="compaction-chev">${icon('chevron-down', 14)}</span></span><span class="compaction-rule"></span></summary>` +
    `<div class="compaction-card"><div class="compaction-meta">${escapeHtml(meta.join(' · '))}</div>` +
    `<div class="md compaction-summary">${renderMarkdown(typeof c?.summary === 'string' && c.summary.trim() ? c.summary : '_No summary was kept._')}</div></div>`;
  return el;
}
