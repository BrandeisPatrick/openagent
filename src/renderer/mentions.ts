// @ file mentions: the picker above the composer (typing "@" searches the working directory, with the slash
// menu's look and keys) and the chips that @path tokens become in user bubbles.

import type { FileHit } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';

// ---------- Tokens ----------

/** The @-token around the caret: `start` is the "@", the query runs from after it (and an opening quote) to the caret. */
export interface MentionToken {
  start: number;
  /** Where the token ends: the caret, or further on when the caret sits inside a token */
  end: number;
  query: string;
  /** @"… (a path with spaces) */
  quoted: boolean;
}

/**
 * The @-token being typed at `caret`, if any. The "@" has to start a word: the start of the text, or after
 * whitespace, "(" or ",", so e-mail addresses and npm@1.2 never open the picker. Unquoted queries end at
 * whitespace; @"… may contain spaces up to the closing quote.
 */
export function mentionAt(value: string, caret: number): MentionToken | null {
  const before = value.slice(0, caret);
  if (before.lastIndexOf('@') < 0) return null;
  const after = value.slice(caret);
  let m = /(?:^|[\s(,])@"([^"\n]*)$/.exec(before);
  if (m) {
    const rest = /^[^"\n]*"?/.exec(after)?.[0] ?? '';
    return { start: caret - m[1].length - 2, end: caret + rest.length, query: m[1], quoted: true };
  }
  m = /(?:^|[\s(,])@([^\s"]*)$/.exec(before);
  if (m) {
    const rest = /^[^\s"]*/.exec(after)?.[0] ?? '';
    return { start: caret - m[1].length - 1, end: caret + rest.length, query: m[1], quoted: false };
  }
  return null;
}

/** What the picker inserts: "@src/main.ts", "@docs/" for a folder, '@"My Notes/a b.md"' when the path has spaces. */
export function mentionText(hit: Pick<FileHit, 'path' | 'isDir'>): string {
  let p = hit.path.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (hit.isDir) p += '/';
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

/** A path as mentions are compared: relative to the working directory, without "./" or a trailing "/". */
export function normalizeMention(p: string, cwd = ''): string {
  let s = String(p).trim();
  const base = cwd.replace(/\/+$/, '');
  if (base && s.startsWith(`${base}/`)) s = s.slice(base.length + 1);
  return s.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/** Drops malformed hits and fills name and dir from the path when they are missing (debug mocks pass just paths). */
export function cleanHits(list: unknown): FileHit[] {
  if (!Array.isArray(list)) return [];
  const out: FileHit[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const h = raw as Partial<FileHit>;
    const given = typeof h.path === 'string' ? h.path.replace(/\\/g, '/').replace(/^\.\/+/, '') : '';
    const path = given.replace(/\/+$/, '');
    if (!path) continue;
    const slash = path.lastIndexOf('/');
    out.push({
      path,
      name: typeof h.name === 'string' && h.name ? h.name : path.slice(slash + 1),
      dir: typeof h.dir === 'string' ? h.dir.replace(/\/+$/, '') : slash > 0 ? path.slice(0, slash) : '',
      isDir: h.isDir === true || given.endsWith('/'),
    });
  }
  return out;
}

// ---------- Chips in user bubbles ----------

/** "@" at the start of a word (never after a word character, so a@b.com stays text), then @"…" or a run of path characters. */
const TOKEN_RE = /(^|[\s(\[{,;:'"`])@(?:"([^"\n]+)"|([^\s"'`()[\]{}<>,;]+))/g;

export interface MentionChipOptions {
  /** Paths whose contents went to the model (a reloaded transcript item): only these tokens become chips */
  mentions?: string[] | null;
  /** Paths picked from the @ menu in this window: chips even when they don't look like paths (@Makefile) */
  known?: ReadonlySet<string>;
  /** The working directory, so absolute mentions match relative tokens */
  cwd?: string;
}

/**
 * Appends `text` to `parent` as text nodes, with @path tokens as .mention chips (title = the path). The text
 * itself is unchanged (chips hold the token as typed), so textContent still equals `text`. Without a mentions
 * list, tokens that look like paths are chipped: @"…", or a token with "/" or "." in it.
 */
export function appendWithMentions(parent: Node, text: string, opts: MentionChipOptions = {}): void {
  const cwd = opts.cwd ?? '';
  const listed = Array.isArray(opts.mentions)
    ? new Set(opts.mentions.filter((p): p is string => typeof p === 'string').map((p) => normalizeMention(p, cwd)).filter(Boolean))
    : null;
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = (m.index ?? 0) + m[1].length;
    const quoted = m[2] !== undefined;
    let path = quoted ? m[2] : m[3];
    // A sentence's full stop or colon after the path is not part of it.
    if (!quoted) path = path.replace(/[.:!?]+$/, '');
    const key = normalizeMention(path, cwd);
    if (!key) continue;
    const chip = listed ? listed.has(key) : quoted || /[/.]/.test(path) || Boolean(opts.known?.has(key));
    if (!chip) continue;
    const token = quoted ? `@"${path}"` : `@${path}`;
    if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
    const span = document.createElement('span');
    span.className = 'mention';
    span.title = path;
    span.textContent = token;
    parent.appendChild(span);
    last = at + token.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// ---------- The picker ----------

export interface MentionPickerOptions {
  /** #input */
  input: HTMLTextAreaElement;
  /** #mention-menu (styled like the slash menu) */
  menu: HTMLElement;
  /** oc.files.search or the debug mock; null when the running app has no file search */
  search: (query: string, limit: number) => Promise<FileHit[]> | null;
  /** The picker is about to show (the composer closes its slash menu) */
  onOpen?: () => void;
  /** A hit was inserted into the composer */
  onInsert?: (hit: FileHit) => void;
}

export interface MentionPicker {
  /** After the text changed: opens, updates or closes the picker for the token at the caret */
  sync(): void;
  /** After the caret moved: follows the token while the picker is active and closes once the caret leaves it (never opens it) */
  follow(): void;
  /** ↑ ↓ move, ↵ and Tab insert, Esc closes; true when the key was used. Does nothing while the picker is hidden. */
  handleKey(e: KeyboardEvent): boolean;
  isOpen(): boolean;
  close(): void;
  /** The rows on screen */
  hits(): FileHit[];
}

const LIMIT = 30;
const DEBOUNCE_MS = 80;
const FOOT =
  '<div class="slash-foot"><span><kbd>↵</kbd><kbd>tab</kbd> insert</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>';

export function createMentionPicker(o: MentionPickerOptions): MentionPicker {
  const { input, menu } = o;
  /** The token being completed; null while the picker is idle */
  let token: MentionToken | null = null;
  let shown: FileHit[] = [];
  let index = 0;
  /** Bumped whenever the query changes or the picker closes, so late answers are dropped */
  let seq = 0;
  let timer: number | undefined;
  /** The query whose results are shown or on their way */
  let pending: string | null = null;

  const hide = () => {
    menu.hidden = true;
    menu.innerHTML = '';
    shown = [];
  };

  const close = () => {
    window.clearTimeout(timer);
    seq++;
    token = null;
    pending = null;
    hide();
  };

  const highlight = () => {
    const rows = menu.querySelectorAll<HTMLElement>('.mention-item');
    rows.forEach((row, i) => {
      row.classList.toggle('active', i === index);
      row.setAttribute('aria-selected', String(i === index));
    });
    rows[index]?.scrollIntoView({ block: 'nearest' });
  };

  const accept = (i = index) => {
    const hit = shown[i];
    const t = token;
    if (!hit || !t) return;
    const text = `${mentionText(hit)} `;
    const value = input.value;
    // An existing space after the token is reused, so the caret ends up after exactly one space.
    const end = value.charAt(t.end) === ' ' ? t.end + 1 : t.end;
    close();
    input.focus();
    input.setSelectionRange(t.start, end);
    // insertText keeps the edit on the undo stack (⌘Z brings the @query back); assigning value is the fallback.
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok || input.value !== value.slice(0, t.start) + text + value.slice(end)) {
      input.value = value.slice(0, t.start) + text + value.slice(end);
      const caret = t.start + text.length;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    o.onInsert?.(hit);
  };

  const render = () => {
    menu.innerHTML = '';
    const scroll = document.createElement('div');
    scroll.className = 'slash-scroll';
    scroll.insertAdjacentHTML('beforeend', '<div class="slash-label">Files</div>');
    shown.forEach((hit, i) => {
      const row = document.createElement('div');
      row.className = 'slash-item mention-item' + (i === index ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === index));
      row.dataset.path = hit.path;
      row.dataset.kind = hit.isDir ? 'dir' : 'file';
      row.innerHTML =
        `<span class="mention-icon">${icon(hit.isDir ? 'folder' : 'file', 14)}</span>` +
        `<span class="mention-name">${escapeHtml(hit.name)}${hit.isDir ? '<span class="mention-slash">/</span>' : ''}</span>` +
        (hit.dir ? `<span class="mention-dir"><bdi>${escapeHtml(hit.dir)}</bdi></span>` : '');
      row.onmousedown = (e) => {
        e.preventDefault();
        accept(i);
      };
      row.onmousemove = () => {
        if (index !== i) {
          index = i;
          highlight();
        }
      };
      scroll.appendChild(row);
    });
    menu.appendChild(scroll);
    menu.insertAdjacentHTML('beforeend', FOOT);
    if (menu.hidden) o.onOpen?.();
    menu.hidden = false;
    highlight();
  };

  const search = (query: string) => {
    if (query === pending) return;
    pending = query;
    window.clearTimeout(timer);
    const my = ++seq;
    timer = window.setTimeout(async () => {
      let list: FileHit[] = [];
      try {
        const req = o.search(query, LIMIT);
        if (!req) {
          // No file search in this app: stay idle until the next keystroke.
          if (my === seq) close();
          return;
        }
        list = cleanHits(await req);
      } catch {
        list = [];
      }
      if (my !== seq || !token) return;
      shown = list.slice(0, LIMIT);
      index = 0;
      if (shown.length) render();
      else hide();
    }, DEBOUNCE_MS);
  };

  const sync = () => {
    const caret = input.selectionStart ?? 0;
    const t = input.selectionStart === input.selectionEnd ? mentionAt(input.value, caret) : null;
    if (!t) {
      if (token || !menu.hidden) close();
      return;
    }
    token = t;
    search(t.query);
  };

  return {
    sync,
    follow() {
      if (token) sync();
    },
    handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && token && menu.hidden) {
        // Nothing on screen yet: cancel the search, but let Esc do its usual job (stop a run).
        close();
        return false;
      }
      if (menu.hidden || !shown.length || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        highlight();
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        accept();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      }
      return false;
    },
    isOpen: () => !menu.hidden,
    close,
    hits: () => shown.slice(),
  };
}
