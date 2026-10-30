// Tool rows: `[chevron] [tool icon] Verb  argument  …  meta`, with per-tool bodies (diffs, commands,
// file views, outputs) and a small cache of known file contents so edit diffs can show real line numbers.

import { basename, escapeHtml, formatCount, formatDuration } from './dom.js';
import { lineDiff, numberRows, renderDiff, diffStats, statHtml, type DiffRow } from './diff.js';
import { highlight, langFromPath } from './highlight.js';
import { icon, type IconName } from './icons.js';
import { artifactIcon } from './artifacts.js';
import { cleanTasks, taskProgress, taskSnapshot, taskSummary } from './tasks.js';

export type Args = Record<string, unknown>;

export function asArgs(raw: unknown): Args {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' ? (v as Args) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Args) : {};
}

const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
const short = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** "example.com/docs", "playground/page.html" (file URLs keep the last two path segments) */
export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    if (x.protocol === 'file:') return decodeURIComponent(x.pathname.split('/').filter(Boolean).slice(-2).join('/')) || u;
    if (x.protocol === 'http:' || x.protocol === 'https:') return `${x.host}${x.pathname === '/' ? '' : x.pathname}${x.search}`.replace(/\/$/, '');
  } catch {
    /* not a URL */
  }
  return u;
}

const quoted = (s: string, n = 60): string => (s ? `"${short(s, n)}"` : '');

/** "browser_select_option" → "Select option" */
function humanize(name: string): string {
  const s = name.replace(/^browser_/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstString(a: Args): string {
  for (const v of Object.values(a)) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

export interface ToolLabel {
  verb: string;
  arg: string;
  icon: IconName;
  mono: boolean;
  /** Full text for the argument's tooltip when `arg` is shortened */
  title?: string;
  /** The verb is a tool's own name (MCP tools), shown in the mono face */
  verbMono?: boolean;
  /** MCP tools: the server's name, shown as a badge after the argument */
  server?: string;
}

// ---------- MCP tools (mcp__<server>__<tool>, as Claude Code names them) ----------

export interface McpToolName {
  server: string;
  tool: string;
}

/** "mcp__github__search_issues" → { server: "github", tool: "search_issues" }; null for built-in tools. */
export function mcpParts(name: string): McpToolName | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Verb = the tool's own name; argument = its first string argument, else the arguments as compact JSON. */
function mcpLabel(p: McpToolName, a: Args): ToolLabel {
  const base = { verb: p.tool, verbMono: true, icon: 'plug' as const, server: p.server };
  const first = firstString(a);
  if (first) {
    const line = first.replace(/\s+/g, ' ').trim();
    return { ...base, arg: short(line, 80), title: line.length > 80 || line !== first ? short(first, 2000) : undefined, mono: false };
  }
  if (!Object.keys(a).length) return { ...base, arg: '', mono: true };
  const json = JSON.stringify(a);
  return { ...base, arg: short(json, 80), title: json.length > 80 ? short(JSON.stringify(a, null, 2), 2000) : undefined, mono: true };
}

function browserLabel(name: string, a: Args): ToolLabel | null {
  switch (name) {
    case 'browser_navigate': {
      const url = str(a, 'url').trim();
      if (url === 'back') return { verb: 'Go back', arg: '', icon: 'arrow-left', mono: false };
      if (url === 'forward') return { verb: 'Go forward', arg: '', icon: 'arrow-right', mono: false };
      if (url && (/\s/.test(url) || !/[.:/]/.test(url))) return { verb: 'Search the web', arg: quoted(url, 80), icon: 'search', mono: false, title: url };
      return { verb: 'Open', arg: shortUrl(url), icon: 'globe', mono: true, title: url };
    }
    case 'browser_click': {
      const target = str(a, 'element') || str(a, 'description') || str(a, 'text');
      const where = str(a, 'ref') || (a.x !== undefined && a.y !== undefined ? `at ${a.x}, ${a.y}` : '');
      return { verb: a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click', arg: target ? quoted(target) : where, icon: 'mouse-pointer', mono: !target && /^ref_/.test(where) };
    }
    case 'browser_type': {
      const text = str(a, 'text');
      return { verb: a.submit ? 'Type and submit' : 'Type', arg: quoted(text, 80), icon: 'keyboard', mono: false, title: text };
    }
    case 'browser_press_key': return { verb: 'Press', arg: str(a, 'key') || str(a, 'keys'), icon: 'keyboard', mono: true };
    case 'browser_scroll': {
      const dir = str(a, 'direction');
      const amount = Number(a.amount);
      return { verb: 'Scroll', arg: dir ? `${dir}${amount > 0 ? ` ${amount}px` : ''}` : str(a, 'ref'), icon: 'scroll', mono: false };
    }
    case 'browser_wait_for': {
      const text = str(a, 'text');
      const sel = str(a, 'selector') || str(a, 'ref');
      const secs = Number(a.seconds ?? a.time) || Number(a.ms ?? a.timeout_ms ?? a.milliseconds) / 1000;
      const arg = text ? quoted(text) : sel || str(a, 'url') || str(a, 'title') || (secs > 0 ? `${Math.round(secs * 10) / 10}s` : firstString(a));
      return { verb: 'Wait for', arg, icon: 'refresh', mono: Boolean(!text && sel) };
    }
    case 'browser_find': return { verb: 'Find on page', arg: quoted(str(a, 'query')), icon: 'search', mono: false };
    case 'browser_read_page': return { verb: 'Read page outline', arg: str(a, 'filter') === 'all' ? 'all elements' : '', icon: 'eye', mono: false };
    case 'browser_get_text': return { verb: 'Read page text', arg: '', icon: 'eye', mono: false };
    case 'browser_screenshot': return { verb: 'Screenshot', arg: '', icon: 'camera', mono: false };
    case 'browser_eval': return { verb: 'Run JS', arg: short(str(a, 'code').split('\n')[0], 80), icon: 'code', mono: true };
    default:
      if (name.startsWith('browser_')) return { verb: humanize(name), arg: short(firstString(a), 80), icon: 'globe', mono: false };
      return null;
  }
}

export function toolLabel(name: string, a: Args): ToolLabel {
  const mcp = mcpParts(name);
  if (mcp) return mcpLabel(mcp, a);
  const browser = browserLabel(name, a);
  if (browser) return browser;
  switch (name) {
    case 'read_file': return { verb: 'Read', arg: displayPath(str(a, 'path')), title: str(a, 'path'), icon: 'file-text', mono: true };
    case 'write_file': return { verb: 'Write', arg: displayPath(str(a, 'path')), title: str(a, 'path'), icon: 'file-plus', mono: true };
    case 'edit_file': return { verb: 'Edit', arg: displayPath(str(a, 'path')), title: str(a, 'path'), icon: 'pencil', mono: true };
    case 'list_directory': return { verb: 'List', arg: displayPath(str(a, 'path') || '.'), title: str(a, 'path') || '.', icon: 'folder', mono: true };
    case 'glob': return { verb: 'Glob', arg: str(a, 'pattern'), icon: 'search', mono: true };
    case 'grep': return { verb: 'Search', arg: str(a, 'pattern'), icon: 'search-code', mono: true };
    case 'bash': return { verb: 'Bash', arg: short(str(a, 'command').split('\n')[0], 120), icon: 'terminal', mono: true };
    case 'terminal_run': return { verb: 'Terminal', arg: short(str(a, 'command').split('\n')[0], 120), title: str(a, 'command'), icon: 'terminal', mono: true };
    case 'terminal_read': return { verb: 'Read terminal', arg: tabArg(a) || 'active tab', icon: 'terminal', mono: Boolean(tabArg(a)) };
    case 'terminal_list': return { verb: 'Terminal tabs', arg: '', icon: 'list', mono: false };
    case 'terminal_stop': return { verb: 'Stop in terminal', arg: tabArg(a), icon: 'square', mono: true };
    case 'skill': return { verb: 'Skill', arg: '/' + str(a, 'name'), icon: 'sparkles', mono: true };
    case 'create_artifact': {
      const title = str(a, 'title').trim();
      return { verb: 'Artifact', arg: short(title, 80), title: title || undefined, icon: artifactIcon(str(a, 'kind')), mono: false };
    }
    case 'update_tasks': {
      const summary = taskSummary(cleanTasks(a.tasks));
      return { verb: 'Tasks', arg: short(summary, 80), title: summary.length > 80 ? summary : undefined, icon: 'list-checks', mono: false };
    }
    default: return { verb: name, arg: short(JSON.stringify(a), 80), icon: 'code', mono: true };
  }
}

// ---------- Where the browser ended up (for "→ Sign-up form" metas) ----------

export interface PageInfo {
  title: string;
  url: string;
}

const SCHEME = /^(?:https?|file|about|data|chrome):/i;

/** The page a browser tool result reports, e.g. "Now at: Sign-up form (file:///…/form.html)". */
export function pageFromResult(r: string): PageInfo | null {
  let m = /Now at:\s*([^\n]+)/.exec(r);
  if (m) {
    let t = m[1].trim();
    let url = '';
    const paren = /\s*[(<]((?:https?|file|about|data):[^)>\s]*)[)>]\s*\.?$/i.exec(t);
    const dash = /^(.*?)\s+[—–-]\s+((?:https?|file|about):\S+?)\.?$/i.exec(t);
    const urlFirst = /^((?:https?|file|about):\S+?)\s+[—–-]\s+(.*)$/i.exec(t);
    if (paren) {
      url = paren[1];
      t = t.slice(0, paren.index).trim();
    } else if (urlFirst) {
      url = urlFirst[1];
      t = urlFirst[2];
    } else if (dash) {
      t = dash[1];
      url = dash[2];
    }
    t = t.replace(/^["“](.*)["”]\.?$/, '$1').replace(/\.$/, '').trim();
    if (SCHEME.test(t) && !url) {
      url = t;
      t = '';
    }
    return t || url ? { title: t, url } : null;
  }
  m = /Now at ((?:https?|file|about|data):\S+?)(?: — "([^"\n]*)")?\.?\s*$/im.exec(r);
  if (m) return { url: m[1], title: m[2] ?? '' };
  m = /Page is now (\S+?)\.?\s*$/im.exec(r);
  if (m) return { url: m[1], title: '' };
  return null;
}

let lastPage = '';

function pageMeta(name: string, r: string): string {
  const page = pageFromResult(r);
  if (!page) return '';
  const key = page.url || page.title;
  const changed = key !== lastPage;
  lastPage = key;
  if (name !== 'browser_navigate' && !changed) return '';
  const label = page.title || shortUrl(page.url);
  return `<span class="meta-page" title="${escapeHtml([page.title, page.url].filter(Boolean).join(' · '))}">→ ${escapeHtml(short(label, 40))}</span>`;
}

function browserMeta(name: string, a: Args, r: string): string {
  switch (name) {
    case 'browser_find': {
      if (/^No (?:match|element|result)/i.test(r.trim())) return 'no matches';
      const n = r.split('\n').filter((l) => /\[?ref_\w+\]?/.test(l)).length || r.split('\n').filter((l) => l.trim()).length;
      return `${n} match${n === 1 ? '' : 'es'}`;
    }
    case 'browser_read_page': {
      const n = r.split('\n').filter((l) => /\[ref_\w+\]/.test(l)).length;
      return n ? `${n} element${n === 1 ? '' : 's'}` : 'ok';
    }
    case 'browser_get_text': {
      const body = r.replace(/^URL:[^\n]*\nTitle:[^\n]*\n\n?/, '');
      return `${formatCount(body.length)} chars`;
    }
    case 'browser_screenshot': {
      const m = /\((\d+)\s*[x×]\s*(\d+)\)/.exec(r);
      return m ? `${m[1]}×${m[2]}` : 'ok';
    }
    case 'browser_eval': {
      const first = r.trim().split('\n')[0] ?? '';
      return first ? `<span class="meta-value" title="${escapeHtml(short(r.trim(), 400))}">= ${escapeHtml(short(first, 32))}</span>` : 'ok';
    }
    case 'browser_scroll': {
      const m = /y=(\d+) of (\d+)(?: \(viewport (\d+)\))?/.exec(r);
      const page = pageMeta(name, r);
      if (page) return page;
      if (m) {
        const max = Math.max(1, Number(m[2]) - Number(m[3] ?? 0));
        return `${Math.min(100, Math.round((Number(m[1]) / max) * 100))}% down`;
      }
      return 'ok';
    }
    default: {
      const page = pageMeta(name, r);
      if (page) return page;
      return name === 'browser_type' && a.submit ? 'submitted' : 'ok';
    }
  }
}

/** Status-line verb while a tool runs. */
export function statusVerb(name: string): string {
  if (name === 'bash') return 'Running bash…';
  if (name === 'read_file') return 'Reading…';
  if (name === 'write_file') return 'Writing…';
  if (name === 'edit_file') return 'Editing…';
  if (name === 'grep' || name === 'glob') return 'Searching…';
  if (name === 'list_directory') return 'Listing…';
  if (name === 'skill') return 'Loading skill…';
  if (name === 'terminal_run') return 'Running in the terminal…';
  if (name === 'terminal_read') return 'Reading the terminal…';
  if (name === 'terminal_list') return 'Listing terminals…';
  if (name === 'terminal_stop') return 'Stopping the command…';
  if (name === 'create_artifact') return 'Making the artifact…';
  if (name === 'update_tasks') return 'Updating tasks…';
  if (name.startsWith('browser_')) return 'Browsing…';
  const mcp = mcpParts(name);
  if (mcp) return `Calling ${mcp.server}…`;
  return `Running ${name}…`;
}

const KNOWN_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'list_directory', 'glob', 'grep', 'bash', 'skill', 'create_artifact', 'update_tasks',
  'terminal_run', 'terminal_read', 'terminal_list', 'terminal_stop',
  'browser_navigate', 'browser_get_text', 'browser_read_page', 'browser_find', 'browser_click',
  'browser_type', 'browser_press_key', 'browser_scroll', 'browser_screenshot', 'browser_eval', 'browser_wait_for',
]);

/** Tools whose consecutive rows collapse into one "Read 4 files" group (MCP tools join them: "Called 3 tools on github"). */
export const GROUPABLE = new Set(['read_file', 'glob', 'grep', 'list_directory']);

export function isGroupable(name: string): boolean {
  return GROUPABLE.has(name) || mcpParts(name) !== null;
}

export function groupSummary(names: string[]): string {
  const count = (n: string) => names.filter((x) => x === n).length;
  const reads = count('read_file');
  const searches = count('grep') + count('glob');
  const lists = count('list_directory');
  const mcp = names.map(mcpParts).filter((p): p is McpToolName => p !== null);
  const other = names.length - reads - searches - lists - mcp.length;
  const parts: string[] = [];
  if (reads) parts.push(`read ${reads} file${reads === 1 ? '' : 's'}`);
  if (searches) parts.push(`ran ${searches} search${searches === 1 ? '' : 'es'}`);
  if (lists) parts.push(`listed ${lists} director${lists === 1 ? 'y' : 'ies'}`);
  if (mcp.length) {
    const servers = new Set(mcp.map((p) => p.server));
    parts.push(`called ${mcp.length} tool${mcp.length === 1 ? '' : 's'} on ${servers.size === 1 ? [...servers][0] : `${servers.size} servers`}`);
  }
  if (other > 0) parts.push(`used ${other} other tool${other === 1 ? '' : 's'}`);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Known file contents (for real line numbers in edit diffs) ----------

const files = new Map<string, string>();
let cwd = '';

export function setToolCwd(dir: string): void {
  cwd = dir.replace(/\/+$/, '');
}
export function resetFileCache(): void {
  files.clear();
  lastPage = '';
}
/** Drops one file's cached content (e.g. after it was reverted on disk). */
export function forgetFile(path: string): void {
  files.delete(fileKey(path));
}
/** The working directory and its /private twin (macOS resolves /tmp and /var through /private). */
function cwdVariants(): string[] {
  if (!cwd) return [];
  const v = [cwd];
  if (cwd.startsWith('/private/')) v.push(cwd.slice('/private'.length));
  else if (/^\/(tmp|var|etc)\//.test(cwd)) v.push('/private' + cwd);
  return v;
}

const HOME_RE = /^\/Users\/[^/]+/;

/** A path for display: relative to the working directory, ~ for home, middle-truncated past `max` with the file name kept. */
export function displayPath(p: string, max = 56): string {
  let s = (p ?? '').trim();
  if (!s) return '';
  for (const c of cwdVariants()) {
    if (s === c) return '.';
    if (s.startsWith(c + '/')) {
      s = s.slice(c.length + 1);
      break;
    }
  }
  s = s.replace(HOME_RE, '~');
  if (s.length <= max) return s;
  const parts = s.split('/');
  if (parts.length <= 2) return '…' + s.slice(-(max - 1));
  let tail = parts[parts.length - 1];
  let i = parts.length - 2;
  while (i > 0 && tail.length + parts[i].length + 1 <= max - 4) {
    tail = `${parts[i]}/${tail}`;
    i--;
  }
  return `${parts[0]}/…/${tail}`;
}

/** Shortens absolute working-directory paths inside tool output for display (the model still sees the full text). */
export function stripCwd(text: string): string {
  let t = text;
  for (const c of cwdVariants()) t = t.split(c + '/').join('');
  return t;
}

function fileKey(p: string): string {
  let k = p.trim().replace(/^\.\//, '');
  if (cwd && k.startsWith(cwd + '/')) k = k.slice(cwd.length + 1);
  return k;
}
/** 1-based line where `snippet` starts in the cached file, if the file is known and the snippet occurs in it. */
function startLine(path: string, snippet: string): number | undefined {
  const content = files.get(fileKey(path));
  if (content === undefined || !snippet) return undefined;
  const at = content.indexOf(snippet);
  if (at < 0) return undefined;
  return content.slice(0, at).split('\n').length;
}

const READ_LINE = /^\s*(\d+)\| ?(.*)$/;

function rememberRead(path: string, result: string, args: Args): void {
  if (Number(args.offset) > 1 || /\n…\(\d+ lines total/.test(result) || /…\[truncated \d+ more characters\]$/.test(result)) return;
  const lines = result.split('\n');
  const text: string[] = [];
  for (const l of lines) {
    const m = READ_LINE.exec(l);
    if (!m) return;
    text.push(m[2]);
  }
  files.set(fileKey(path), text.join('\n'));
}

// ---------- Cards ----------

export interface ToolResult {
  result: string;
  ok: boolean;
  image?: string;
  durationMs?: number;
}

export interface ToolCard {
  el: HTMLDetailsElement;
  name: string;
  args: Args;
  running: boolean;
  finish(res: ToolResult): void;
  /** The run ended before this tool reported back */
  interrupt(): void;
}

function outBlock(text: string, cls = ''): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'out' + (cls ? ` ${cls}` : '');
  wrap.innerHTML = `<button type="button" class="out-copy icon-btn sm" aria-label="Copy output" data-tip="Copy">${icon('copy', 14)}</button>`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  wrap.appendChild(pre);
  return wrap;
}

function codeView(numbers: string[], code: string, lang: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'code-view';
  el.innerHTML = `<pre class="gutter">${numbers.join('\n')}</pre><pre class="code"><code>${highlight(code, lang)}</code></pre>`;
  return el;
}

function argsBlock(a: Args, raw: unknown): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'args';
  pre.innerHTML = highlight(typeof raw === 'string' ? raw : JSON.stringify(a, null, 2), 'json');
  return pre;
}

/** Lines of a file's content, without the empty "line" after a trailing newline. */
export function fileLines(content: string): string[] {
  return content.replace(/\n$/, '').split('\n');
}

const clip = (s: string, n = 20_000): string => (s.length > n ? s.slice(0, n) + '\n…' : s);

function bashParts(result: string): { output: string; code: string | null } {
  const m = /\n?\[exit code: ([^\]]+)\]\s*$/.exec(result);
  const output = m ? result.slice(0, m.index) : result;
  return { output, code: m ? m[1] : null };
}

// ---------- Terminal pane tools ----------

/** tab_id as the model sent it (some models send a number) */
function tabArg(a: Args): string {
  const v = a.tab_id;
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

interface TerminalRun {
  tab: string;
  output: string;
  /** "0", "1", … or "unknown" once the command finished */
  code: string | null;
  /** "15 s" when the command was still running at the timeout */
  runningAfter: string | null;
  /** The shell itself exited */
  shellExit: string | null;
  /** A shell without integration: output captured once it went quiet, exit code unknown */
  noIntegration: boolean;
}

/** terminal_run's result: "[terminal tab-2 (zsh)]\n<output>\n[exit code: 0]", or one of its other last lines. */
function terminalRunParts(result: string): TerminalRun {
  let rest = result;
  let tab = '';
  const head = /^\[terminal (\S+) \([^)\n]*\)\]\n?/.exec(rest);
  if (head) {
    tab = head[1];
    rest = rest.slice(head[0].length);
  }
  const r: TerminalRun = { tab, output: rest, code: null, runningAfter: null, shellExit: null, noIntegration: false };
  const tail = /(?:^|\n)\[([^\]\n]*)\]\s*$/.exec(rest);
  if (!tail) return r;
  let m: RegExpExecArray | null;
  if ((m = /^exit code: (.+)$/.exec(tail[1]))) r.code = m[1].trim();
  else if ((m = /^still running after ([\d.]+ ?s)\b/.exec(tail[1]))) r.runningAfter = m[1];
  else if ((m = /^the shell exited with code (-?\d+)/.exec(tail[1]))) r.shellExit = m[1];
  else if (/^output stopped; exit code unknown/.test(tail[1])) r.noIntegration = true;
  else return r;
  r.output = rest.slice(0, tail.index);
  return r;
}

/** terminal_read's result: "[terminal tab-2 (zsh) · running: npm run dev · cwd ~/x]\n<lines>". */
function terminalReadParts(result: string): { tab: string; body: string; empty: boolean } {
  const nl = result.indexOf('\n');
  const m = /^\[terminal (\S+) \([^)]*\)(?: · .*)?\]$/.exec(nl < 0 ? result : result.slice(0, nl));
  const body = m ? (nl < 0 ? '' : result.slice(nl + 1)) : result;
  return { tab: m ? m[1] : '', body, empty: !body.trim() || body.trim() === '(the screen is empty)' };
}

const countLines = (s: string): number => (s.trim() ? s.replace(/\n$/, '').split('\n').length : 0);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function terminalMeta(name: string, a: Args, r: string): string[] {
  switch (name) {
    case 'terminal_run': {
      const p = terminalRunParts(r);
      const parts = p.tab ? [escapeHtml(p.tab)] : [];
      const n = countLines(p.output);
      if (p.runningAfter) parts.push('still running');
      else if (p.shellExit !== null) parts.push(`shell exited (${escapeHtml(p.shellExit)})`);
      else if (p.noIntegration) parts.push('exit code unknown');
      else if (p.code !== null && /^-?\d+$/.test(p.code) && p.code !== '0') parts.push(`<span class="meta-err">exit ${escapeHtml(short(p.code, 24))}</span>`);
      else if (p.code !== null) parts.push(`${p.code === '0' ? 'exit 0' : 'done'}${n ? ` · ${plural(n, 'line')}` : ''}`);
      else if (n) parts.push(plural(n, 'line'));
      return parts;
    }
    case 'terminal_read': {
      const p = terminalReadParts(r);
      const parts = p.tab && !tabArg(a) ? [escapeHtml(p.tab)] : [];
      parts.push(p.empty ? 'empty screen' : plural(countLines(p.body), 'line'));
      return parts;
    }
    case 'terminal_list': {
      const n = /^No terminal tabs/.test(r.trim()) ? 0 : countLines(r);
      return [n ? plural(n, 'tab') : 'no tabs'];
    }
    case 'terminal_stop':
      return ['sent Ctrl-C'];
    default:
      return [];
  }
}

/** The body of a finished terminal_* row (errors and denials are handled before). */
function terminalBody(name: string, body: HTMLElement, r: string): void {
  const note = (text: string) => body.insertAdjacentHTML('beforeend', `<div class="tool-note">${escapeHtml(text)}</div>`);
  if (name === 'terminal_run') {
    const p = terminalRunParts(r);
    const output = stripCwd(p.output).replace(/\n$/, '');
    if (output.trim()) body.appendChild(outBlock(clip(output)));
    else if (p.shellExit === null) note(p.runningAfter ? 'No output yet' : 'No output');
    const tab = p.tab || 'its tab';
    if (p.runningAfter) note(`Still running in ${tab} after ${p.runningAfter}; the Terminal pane shows what it prints next.`);
    else if (p.shellExit !== null) note(`The shell in ${tab} exited with code ${p.shellExit}.`);
    else if (p.noIntegration) note('Exit code unknown: this shell has no shell integration, so the output was taken once it went quiet.');
  } else if (name === 'terminal_read') {
    const p = terminalReadParts(r);
    if (p.empty) note('The screen is empty');
    else body.appendChild(outBlock(clip(stripCwd(p.body).replace(/\n$/, ''))));
  } else if (name === 'terminal_list') {
    if (/^No terminal tabs/.test(r.trim()) || !r.trim()) note('No terminal tabs are open');
    else body.appendChild(outBlock(clip(r.replace(/\n$/, ''))));
  } else if (r.trim()) note(r.trim());
}

function metaHtml(name: string, a: Args, res: ToolResult, edit?: DiffRow[]): string {
  const parts: string[] = [];
  const r = res.result;
  if (!res.ok) parts.push('<span class="meta-err">error</span>');
  else if (/^Not permitted/.test(r)) parts.push('<span>denied</span>');
  else {
    switch (name) {
      case 'read_file': {
        const n = r.split('\n').filter((l) => READ_LINE.test(l)).length;
        parts.push(`${n} line${n === 1 ? '' : 's'}`);
        break;
      }
      case 'write_file': {
        const n = fileLines(str(a, 'content')).length;
        parts.push(`<span class="git-add">+${n}</span> line${n === 1 ? '' : 's'}`);
        break;
      }
      case 'edit_file': {
        if (edit) {
          const st = diffStats(edit);
          parts.push(statHtml(st.added, st.removed));
        }
        break;
      }
      case 'bash': {
        const { output, code } = bashParts(r);
        const n = output.trim() ? output.replace(/\n$/, '').split('\n').filter((l) => l !== '[stderr]').length : 0;
        if (code !== null && code !== '0') parts.push(`<span class="meta-err">exit ${escapeHtml(short(code, 24))}</span>`);
        else parts.push(`exit 0${n ? ` · ${n} line${n === 1 ? '' : 's'}` : ''}`);
        break;
      }
      case 'grep':
      case 'glob': {
        let n = 0;
        if (!/^No (?:matches|files matched)/.test(r)) {
          const lines = r.split('\n');
          n = lines.filter((l) => l && !l.startsWith('…(')).length;
          const more = /…\((\d+) more matches/.exec(r);
          if (more) n += Number(more[1]);
        }
        parts.push(`${n} match${n === 1 ? '' : 'es'}`);
        break;
      }
      case 'list_directory': {
        let n = Math.max(0, r.split('\n').filter((l) => l && !l.startsWith('…(')).length - 1);
        const more = /…\((\d+) more entries/.exec(r);
        if (more) n += Number(more[1]);
        parts.push(`${n} item${n === 1 ? '' : 's'}`);
        break;
      }
      case 'skill':
        parts.push('loaded');
        break;
      case 'update_tasks': {
        const tasks = cleanTasks(a.tasks);
        if (tasks.length) parts.push(escapeHtml(taskProgress(tasks)));
        break;
      }
      case 'terminal_run':
      case 'terminal_read':
      case 'terminal_list':
      case 'terminal_stop':
        parts.push(...terminalMeta(name, a, r));
        break;
      default:
        if (name.startsWith('browser_')) {
          const meta = browserMeta(name, a, r);
          if (meta) parts.push(meta);
        } else {
          const n = r.split('\n').length;
          if (n > 1) parts.push(`${n} lines`);
        }
    }
  }
  if (typeof res.durationMs === 'number' && res.durationMs >= 0) parts.push(formatDuration(res.durationMs));
  return parts.join('<span class="meta-sep"> · </span>');
}

export function createToolCard(name: string, rawArgs: unknown): ToolCard {
  const a = asArgs(rawArgs);
  const label = toolLabel(name, a);
  const el = document.createElement('details');
  el.className = 'tool' + (isGroupable(name) ? ' groupable' : '') + (label.server ? ' mcp' : '');
  el.dataset.tool = name;
  if (label.server) el.dataset.server = label.server;
  const summary = document.createElement('summary');
  summary.innerHTML =
    `<span class="tool-chevron">${icon('chevron-right')}</span>` +
    `<span class="tool-status spin">${icon(label.icon)}</span>` +
    `<span class="tool-verb${label.verbMono ? ' mono' : ''}">${escapeHtml(label.verb)}</span>` +
    `<span class="tool-arg${label.mono ? ' mono' : ''}">${escapeHtml(label.arg)}</span>` +
    (label.server ? `<span class="tool-server" title="${escapeHtml(`MCP server: ${label.server}`)}">${escapeHtml(label.server)}</span>` : '') +
    `<span class="tool-meta"></span>`;
  if (label.arg || label.title) summary.querySelector('.tool-arg')!.setAttribute('title', label.title || label.arg);
  const body = document.createElement('div');
  body.className = 'tool-body';
  el.append(summary, body);

  // Bodies that are known before the tool runs
  let editRows: DiffRow[] | undefined;
  const path = str(a, 'path');
  if (name === 'edit_file' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    editRows = lineDiff(a.old_string, a.new_string);
    const at = startLine(path, a.old_string);
    if (at !== undefined) editRows = numberRows(editRows, at);
    body.appendChild(renderDiff(displayPath(path) || 'file', editRows));
    const st = diffStats(editRows);
    summary.querySelector('.tool-meta')!.innerHTML = statHtml(st.added, st.removed);
  } else if (name === 'write_file' && typeof a.content === 'string') {
    const rows = numberRows(fileLines(a.content).map((t) => ({ kind: 'add' as const, text: t })), 1);
    body.appendChild(renderDiff(displayPath(path) || 'file', rows));
  } else if ((name === 'bash' || name === 'terminal_run') && str(a, 'command')) {
    const cmd = document.createElement('div');
    cmd.className = 'cmd';
    cmd.innerHTML = `<span class="cmd-prompt">$</span><code>${highlight(str(a, 'command'), 'sh')}</code>`;
    body.appendChild(cmd);
  } else if (name === 'browser_eval' && str(a, 'code')) {
    body.appendChild(codeView([], str(a, 'code'), 'js'));
    body.lastElementChild!.classList.add('no-gutter');
  } else if (name === 'browser_type' && str(a, 'text').length > 80) {
    body.appendChild(outBlock(str(a, 'text'), 'note'));
  } else if (name === 'update_tasks' && Array.isArray(a.tasks)) {
    // The list as the agent set it at this point (the pinned card shows the latest one)
    body.appendChild(taskSnapshot(cleanTasks(a.tasks)));
  } else if (!KNOWN_TOOLS.has(name)) {
    // Unknown tools (or arguments that were not valid JSON): show what the model sent.
    if (Object.keys(a).length || typeof rawArgs === 'string') body.appendChild(argsBlock(a, typeof rawArgs === 'string' && !Object.keys(a).length ? rawArgs : undefined));
  }

  const card: ToolCard = {
    el,
    name,
    args: a,
    running: true,
    finish(res: ToolResult) {
      if (!card.running) return;
      card.running = false;
      const status = el.querySelector<HTMLElement>('.tool-status')!;
      status.className = `tool-status ${res.ok ? 'ok' : 'err'}`;
      if (!res.ok) status.innerHTML = icon('circle-alert');
      el.querySelector('.tool-meta')!.innerHTML = metaHtml(name, a, res, editRows);
      const denied = res.ok && /^Not permitted/.test(res.result);
      if (!res.ok || denied) {
        el.classList.toggle('denied', denied);
        body.appendChild(outBlock(clip(stripCwd(res.result)), res.ok ? 'note' : 'error'));
        if (!res.ok) el.open = true;
      } else if (name === 'read_file') {
        rememberRead(path, res.result, a);
        const lines = res.result.split('\n');
        const nums: string[] = [];
        const code: string[] = [];
        const rest: string[] = [];
        for (const l of lines) {
          const m = READ_LINE.exec(l);
          if (m && !rest.length) {
            nums.push(m[1]);
            code.push(m[2]);
          } else rest.push(l);
        }
        if (nums.length) body.appendChild(codeView(nums, clip(code.join('\n'), 60_000), langFromPath(path)));
        if (rest.join('').trim()) body.insertAdjacentHTML('beforeend', `<div class="tool-note">${escapeHtml(stripCwd(rest.join('\n')).trim())}</div>`);
      } else if (name === 'write_file') {
        files.set(fileKey(path), str(a, 'content'));
      } else if (name === 'edit_file') {
        const key = fileKey(path);
        const content = files.get(key);
        const oldS = str(a, 'old_string');
        if (content !== undefined && oldS && content.includes(oldS)) {
          files.set(key, a.replace_all ? content.split(oldS).join(str(a, 'new_string')) : content.replace(oldS, () => str(a, 'new_string')));
        } else files.delete(key);
      } else if (name === 'bash') {
        const { output } = bashParts(res.result);
        body.appendChild(output.trim() ? outBlock(clip(stripCwd(output).replace(/\n$/, ''))) : Object.assign(document.createElement('div'), { className: 'tool-note', textContent: 'No output' }));
      } else if (name.startsWith('terminal_')) {
        terminalBody(name, body, res.result);
      } else if (name === 'update_tasks' && body.querySelector('.task-snapshot')) {
        // the snapshot above says what the result text says
      } else if (res.image && !label.server) {
        // screenshots are shown below (their text only says where the file went); MCP results keep their text too
      } else if (res.result.trim()) {
        body.appendChild(outBlock(clip(stripCwd(res.result))));
      }
      if (res.image) {
        const img = document.createElement('img');
        img.src = res.image;
        img.alt = label.server ? `Image from ${label.server}` : 'Screenshot of the browser pane';
        img.className = 'shot';
        const saved = /Screenshot saved to (\S+?\.png)/.exec(res.result)?.[1];
        if (label.server) {
          // An image an MCP server returned opens in the app's lightbox (see renderer.ts)
          img.classList.add('openable');
          img.dataset.lightbox = '1';
          img.title = 'Open the image';
        } else if (saved) {
          img.classList.add('openable');
          img.title = 'Open the screenshot';
          img.addEventListener('click', () => {
            void (window as unknown as { oc: { changes: { openInEditor(p: string): Promise<void> } } }).oc.changes.openInEditor(saved);
          });
        }
        body.appendChild(img);
        el.open = true;
      }
    },
    interrupt() {
      if (!card.running) return;
      card.running = false;
      const status = el.querySelector<HTMLElement>('.tool-status')!;
      status.className = 'tool-status err';
      status.innerHTML = icon('circle-alert');
      el.querySelector('.tool-meta')!.innerHTML = '<span>interrupted</span>';
    },
  };
  return card;
}

/** Title for the approval card. */
export function approvalTitle(name: string, detail: string, args?: Args): string {
  const target = (args && str(args, 'path')) || detail.split('\n')[0] || '';
  if (name === 'bash') return 'Allow OpenAgent to run this command?';
  if (name === 'terminal_run') return 'Allow OpenAgent to run this command in the terminal?';
  if (name === 'edit_file') return `Allow OpenAgent to edit ${basename(target) || 'this file'}?`;
  if (name === 'write_file') return `Allow OpenAgent to write ${basename(target) || 'this file'}?`;
  const mcp = mcpParts(name);
  if (mcp) return `Allow OpenAgent to call ${mcp.tool} on ${mcp.server}?`;
  return `Allow OpenAgent to use ${name}?`;
}

/** Line number where an edit's old text starts, from known file contents. */
export function editStartLine(path: string, oldText: string): number | undefined {
  return startLine(path, oldText);
}
