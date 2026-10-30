import type {
  AgentEvent,
  AppConfig,
  ArtifactInfo,
  BrowserState,
  ChangeDiff,
  ChangeEntry,
  ChangesApi,
  CompactionInfo,
  ContextInfo,
  FileHit,
  ImageAttachment,
  McpApi,
  McpServerInfo,
  ModelCapabilities,
  OpenAgentApi,
  PermissionMode,
  PlanInfo,
  ProjectRules,
  QueuedMessage,
  RewindResult,
  RulesApi,
  SendResult,
  SessionMeta,
  SkillInfo,
  TaskItem,
  TerminalApi,
  TerminalTabInfo,
  TranscriptItem,
} from '../shared/types';
import { brandMark, hydrateIcons, icon, type IconName } from './icons.js';
import { basename, copyWithFeedback, escapeHtml, formatCount, isTextField } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { lineDiff, numberRows, parseEditPreview, renderDiff, setDiffBaseDir } from './diff.js';
import { highlight } from './highlight.js';
import { approvalTitle, asArgs, createToolCard, displayPath, editStartLine, fileLines, forgetFile, groupSummary, mcpParts, resetFileCache, setToolCwd, statusVerb, type ToolCard } from './tools.js';
import { closeMenu, initTooltips, isMenuOpen, menuAnchoredTo, openMenu, type MenuItem, type MenuSection } from './popover.js';
import { MODE_CHIP_CLASSES, MODE_CYCLE, MODES, modeOf, nextMode } from './modes.js';
import { createPlanCard, type PlanCard, type PlanDecision } from './plan.js';
import { createChangesPane, mockChangesSource, type ConfirmOptions } from './changes.js';
import { createTerminalPane, mockTerminalSource, type MockTerminalSource } from './terminal.js';
import { attachmentLabel, createAttachmentTray, dataUrlToBlob, imageType, type AddResult, type ImageInput } from './attachments.js';
import { createArtifactCard, type ArtifactAction, type ArtifactCard } from './artifacts.js';
import { createQueueList } from './queue.js';
import { createCompactionDivider, createContextMeter, normalizeContext } from './context.js';
import { createMcpPanel, mcpCardHtml, mockMcpSource, type MockMcpSource } from './mcp.js';
import { appendWithMentions, createMentionPicker, normalizeMention } from './mentions.js';
import { createRulesPanel, mockRulesSource } from './rules.js';
import { cleanTasks, createTaskList } from './tasks.js';

declare global {
  interface Window {
    oc: OpenAgentApi;
    __oc_debug?: {
      /**
       * A user bubble, optionally with images (data: URLs), the mentioned paths a reloaded transcript would carry and
       * the checkpoint index (turn) that gives it a Rewind action (clicking it really rewinds the current session)
       */
      user(text: string, images?: string[], mentions?: string[], turn?: number): void;
      /** Shows the task list card with these tasks (an empty list or null hides it); nothing reaches the main process */
      tasks(tasks: TaskItem[] | null): void;
      renderMarkdown(md: string): void;
      emit(ev: AgentEvent): void;
      /** Feeds the Diff pane from memory instead of oc.changes (pass null to go back to the real tracker) */
      mockChanges(list: ChangeEntry[] | null, diffs?: Record<string, Partial<ChangeDiff>>): void;
      terminal: {
        /** A terminal tab's text (scrollback and screen, wrapped rows joined); the active tab by default */
        screen(id?: string): string;
        /** The terminal tabs in strip order */
        tabs(): TerminalTabInfo[];
        /** true: an in-memory fake shell instead of oc.terminal (echo, pwd, cd, ls, clear, colors, sleep N, exit); false: the real one again */
        mock(on: boolean): void;
        /** Types into a tab as the user would (the active tab by default), e.g. "echo hi\r" */
        input(text: string, id?: string): void;
      };
      /** Adds an image to the composer through the same pipeline as paste, drop and the picker */
      attach(dataUrl: string, name?: string): Promise<ImageAttachment>;
      /** The composer's attachments, in order */
      attachments(): ImageAttachment[];
      /** Messages waiting in the queue, oldest first */
      queue(): QueuedMessage[];
      mcp: {
        /** Settings → MCP servers (and /mcp) show these servers from memory instead of oc.mcp; actions change only that copy. null goes back to oc.mcp */
        mock(servers: McpServerInfo[] | null): void;
      };
      /** Sets the context meter directly (null hides it) */
      context(info: ContextInfo | null): void;
      files: {
        /** The @ picker shows these hits (whatever the query, up to its limit) instead of asking oc.files.search; null goes back to it */
        mock(hits: FileHit[] | null): void;
      };
      rules: {
        /** Settings → Permissions shows these rules from memory instead of oc.rules; removing one changes only that copy. null goes back to oc.rules */
        mock(rules: ProjectRules | null): void;
      };
    };
  }
}

const oc = window.oc;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

hydrateIcons();

const shell = document.querySelector<HTMLElement>('.shell')!;
const contentEl = document.querySelector<HTMLElement>('.content')!;
const transcriptWrap = document.querySelector<HTMLElement>('.transcript-wrap')!;
const messagesEl = $('messages');
const emptyState = $('empty-state');
const inputEl = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send-btn');
const stopBtn = $<HTMLButtonElement>('stop-btn');
const statusLine = $('status-line');
const statusText = $('status-text');
const statusTime = $('status-time');
const statusTokens = $('status-tokens');
const modeBtn = $<HTMLButtonElement>('mode-btn');
const modelBtn = $<HTMLButtonElement>('model-btn');
const cwdBtn = $<HTMLButtonElement>('cwd-btn');
const cwdLabel = $('cwd-label');
const sessionTitle = $('session-title');
const sessionList = $('session-list');
const sessionSearch = $<HTMLInputElement>('session-search');
const newSessionBtn = $<HTMLButtonElement>('new-session-btn');
const slashMenu = $('slash-menu');
const mentionMenu = $('mention-menu');
const settingsDialog = $<HTMLDialogElement>('settings');
const settingsForm = $<HTMLFormElement>('settings-form');
const settingsBody = $('settings-body');
const settingsStatus = $('settings-status');
const shortcutsDialog = $<HTMLDialogElement>('shortcuts');
const sidePane = $('side-pane');
const browserPane = $('browser-pane');
const diffPane = $('diff-pane');
const paneTabBrowser = $<HTMLButtonElement>('pane-tab-browser');
const paneTabDiff = $<HTMLButtonElement>('pane-tab-diff');
const diffToggle = $<HTMLButtonElement>('diff-toggle');
const diffCountBadges = [$('diff-count'), $('pane-diff-count')];
const terminalPaneEl = $('terminal-pane');
const paneTabTerminal = $<HTMLButtonElement>('pane-tab-terminal');
const terminalToggle = $<HTMLButtonElement>('terminal-toggle');
const terminalBusyDots = [$('terminal-busy'), $('pane-terminal-busy')];
const browsingPill = $('browsing-pill');
const confirmDialog = $<HTMLDialogElement>('confirm-dialog');
const statusHint = $('status-hint');
const browserView = $('browser-view');
const urlEl = $<HTMLInputElement>('url');
const backBtn = $<HTMLButtonElement>('back-btn');
const fwdBtn = $<HTMLButtonElement>('fwd-btn');
const reloadBtn = $<HTMLButtonElement>('reload-btn');
const openExternalBtn = $<HTMLButtonElement>('open-external-btn');
const browserTitle = $('browser-title');
const browserToggle = $<HTMLButtonElement>('browser-toggle');
const resizer = $('pane-resizer');
const placeholder = browserView.querySelector<HTMLElement>('.browser-placeholder');
const attachBtn = $<HTMLButtonElement>('attach-btn');
const attachInput = $<HTMLInputElement>('attach-input');
const attachNote = $('attach-note');
const queueEl = $('queue');
const taskListEl = $('task-list');
const lightbox = $<HTMLDialogElement>('lightbox');
const lightboxImg = $<HTMLImageElement>('lightbox-img');
const lightboxCaption = $('lightbox-caption');
const contextMeterBtn = $<HTMLButtonElement>('context-meter');

$('empty-mark').innerHTML = brandMark(40);

let config: AppConfig;
let running = false;
let runStartedAt = 0;
let timer: number | undefined;
let currentSessionId = '';
let runningSessionId = '';
let sessions: SessionMeta[] = [];
const toolCards = new Map<string, ToolCard>();
let lastToolCard: ToolCard | null = null;
let pendingApproval: { name: string; cancel: (reason: string) => void; allow: () => void } | null = null;
let stick = true;
let runOutputTokens = 0;
/** From a confirmed Rewind until the transcript is back: sending and other rewinds wait */
let rewinding = false;
/** Bumped by every tasks_updated event (and the debug hook), so a session read that started earlier cannot overwrite the list */
let tasksEpoch = 0;
/** Bumped by every turn sync and every re-render, so a transcript read that started earlier is dropped */
let turnSync = 0;
/** Paths picked from the @ menu in this window: their tokens become chips in the bubbles sent from here (even @Makefile) */
const pickedPaths = new Set<string>();

const tray = createAttachmentTray({
  root: $('attachments'),
  onChange: () => {
    updateSendButton();
    if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
    void refreshVisionNote();
  },
  onPreview: (a) => openLightbox(a.dataUrl, a.name, attachmentLabel(a)),
  onFocusComposer: () => inputEl.focus(),
});

const queueList = createQueueList({
  root: queueEl,
  unqueue: async (msg, button) => {
    try {
      if (typeof oc.unqueue !== 'function') throw new Error('No handler registered');
      if (await oc.unqueue(msg.id)) return true;
      showInlineError(button, 'Already handed to the agent, so it can no longer be removed.');
    } catch (err) {
      showInlineError(button, `Couldn't remove the message: ${cleanError(err)}`);
    }
    return false;
  },
  onChange: () => syncQueueHeight(),
});

/** The agent's task list, pinned above the queue and the status line (tasks_updated, SessionMeta.tasks) */
const taskList = createTaskList({ root: taskListEl, onChange: () => syncTaskHeight() });

/** A task list from an event or the debug hook. */
function showTasks(tasks: unknown): void {
  tasksEpoch++;
  taskList.set(cleanTasks(tasks));
}

/** The current session's task list from its meta (on load and after switching), unless an event came in since `epoch`. */
function showSessionTasks(meta: SessionMeta | null | undefined, epoch: number): void {
  if (!meta || meta.id !== currentSessionId || epoch !== tasksEpoch) return;
  taskList.set(cleanTasks(meta.tasks));
}

/** True when the composer has text, images or images still being processed. */
function composerHasContent(): boolean {
  return Boolean(inputEl.value.trim()) || tray.items().length > 0 || tray.pending() > 0;
}

/** Nothing typed and nothing attached (keys like y/n/Enter then go to an approval or plan card). */
function composerEmpty(): boolean {
  return !inputEl.value && tray.items().length === 0 && tray.pending() === 0;
}

// ---------- Errors shown next to the control that failed ----------

function cleanError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error:\s*)+/, '');
  if (/No handler registered/.test(msg)) return 'this needs the updated app. Restart OpenAgent and try again.';
  return msg;
}

let inlineError: HTMLElement | null = null;
let inlineErrorTimer: number | undefined;
function showInlineError(anchor: HTMLElement, message: string): void {
  inlineError?.remove();
  window.clearTimeout(inlineErrorTimer);
  const el = document.createElement('div');
  el.className = 'inline-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w));
  let top = r.bottom + 6;
  const view = browserViewRect();
  if (top + hgt > window.innerHeight - 8 || (view && left < view.right && left + w > view.left && top < view.bottom && top + hgt > view.top)) top = r.top - 6 - hgt;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
  inlineError = el;
  inlineErrorTimer = window.setTimeout(() => {
    el.remove();
    if (inlineError === el) inlineError = null;
  }, 5000);
}

function dialogOpen(): boolean {
  return settingsDialog.open || shortcutsDialog.open || confirmDialog.open || lightbox.open;
}

function browserViewRect(): DOMRect | null {
  if (shell.classList.contains('browser-hidden') || dialogOpen()) return null;
  return browserView.getBoundingClientRect();
}

initTooltips(browserViewRect);

// ---------- Transcript ----------

const jumpBtn = $<HTMLButtonElement>('jump-latest');
function showJump(v: boolean): void {
  jumpBtn.hidden = !v;
}
jumpBtn.onclick = () => scrollToBottom(true);

messagesEl.addEventListener(
  'scroll',
  () => {
    stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 64;
    if (stick) showJump(false);
  },
  { passive: true },
);

/** Follows new content while the user is at the bottom; otherwise offers a "Jump to latest" pill instead of yanking the view. */
function scrollToBottom(force = false): void {
  if (force) stick = true;
  if (stick) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    showJump(false);
  } else if (messagesEl.scrollHeight > messagesEl.clientHeight) showJump(true);
}

function addNode(el: HTMLElement): void {
  emptyState.hidden = true;
  el.classList.add('fade-in');
  messagesEl.appendChild(el);
  scrollToBottom();
}

/** An image shown in a user bubble: a data: URL, plus what is known about it (live sends know more than a reloaded transcript). */
interface BubbleImage {
  src: string;
  name?: string;
  width?: number;
  height?: number;
  /** Shown under the image in the lightbox */
  caption?: string;
}

function bubbleImage(a: ImageAttachment): BubbleImage {
  return { src: a.dataUrl, name: a.name, width: a.width, height: a.height, caption: attachmentLabel(a) };
}

/** What each user bubble was sent with: Copy copies it, and live bubbles are matched to transcript items by it. */
const userTextByMessage = new WeakMap<HTMLElement, string>();

interface UserMessageOptions {
  /** The message's checkpoint (TranscriptItem.turn): the bubble gets a Rewind action */
  turn?: number;
  /** A command handled here (/compact, /mcp, …) or a message the main process did not take: no transcript item matches it */
  local?: boolean;
}

const REWIND_BUTTON = `<button type="button" class="icon-btn sm msg-rewind" aria-label="Rewind to this message" data-tip="Rewind">${icon('rotate-ccw', 14)}</button>`;

/** Gives a user bubble its checkpoint and the Rewind action, or takes both away (undefined). */
function setTurn(msg: HTMLElement, turn: number | undefined): void {
  const actions = msg.querySelector<HTMLElement>(':scope > .msg-actions');
  const btn = actions?.querySelector<HTMLElement>('.msg-rewind');
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    delete msg.dataset.turn;
    btn?.remove();
    return;
  }
  msg.dataset.turn = String(turn);
  if (!btn) actions?.insertAdjacentHTML('beforeend', REWIND_BUTTON);
}

function turnOf(msg: HTMLElement): number | null {
  const v = msg.dataset.turn;
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * A user bubble. @path tokens become chips: with `mentions` (a reloaded transcript item) exactly the paths whose
 * contents went to the model, otherwise tokens that look like paths and paths picked from the @ menu. Hovering (or
 * focusing) it shows Copy and, once it has a checkpoint, Rewind.
 */
function addUserMessage(text: string, images: BubbleImage[] = [], mentions?: string[] | null, opts: UserMessageOptions = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const shown = images.filter((im) => im && typeof im.src === 'string' && im.src);
  if (shown.length) {
    bubble.classList.add('has-images');
    if (!text) bubble.classList.add('images-only');
    const grid = document.createElement('div');
    grid.className = `bubble-images${shown.length > 1 ? ' multi' : ''}`;
    shown.forEach((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bubble-image';
      b.setAttribute('aria-label', `Open ${im.name || `image ${i + 1}`}`);
      const img = document.createElement('img');
      img.alt = im.name || 'Attached image';
      img.draggable = false;
      if (im.width && im.height) {
        img.width = im.width;
        img.height = im.height;
      }
      img.addEventListener('load', () => scrollToBottom(), { once: true });
      img.src = im.src;
      b.appendChild(img);
      b.onclick = () => openLightbox(im.src, im.name, im.caption);
      grid.appendChild(b);
    });
    bubble.appendChild(grid);
  }
  if (text) appendWithMentions(bubble, text, { mentions: Array.isArray(mentions) ? mentions : null, known: pickedPaths, cwd: config?.workingDirectory ?? '' });
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  // An images-only message has no text to copy (the row stays empty, and hidden, unless it gets Rewind)
  if (text) actions.innerHTML = `<button type="button" class="icon-btn sm msg-copy" aria-label="Copy message" data-tip="Copy">${icon('copy', 14)}</button>`;
  el.append(bubble, actions);
  userTextByMessage.set(el, text);
  if (opts.local) el.dataset.local = 'true';
  setTurn(el, opts.turn);
  addNode(el);
  scrollToBottom(true);
  return el;
}

function addSystemMessage(text: string, kind: 'info' | 'error' | 'notice' = 'info'): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg system${kind === 'info' ? '' : ` ${kind}`}`;
  el.innerHTML = `${icon(kind === 'error' ? 'circle-alert' : 'info', kind === 'error' ? 16 : 14)}<span>${escapeHtml(text)}</span>`;
  addNode(el);
  return el;
}

/** A left-aligned notice card rendered from Markdown (used for /skills). */
function addNoticeCard(markdown: string): void {
  const el = document.createElement('div');
  el.className = 'msg system notice card';
  el.innerHTML = `<div class="md">${renderMarkdown(markdown)}</div>`;
  addNode(el);
}

/** The divider where earlier messages were folded into a summary (live compact_end, or a reloaded transcript). */
function addCompaction(info: CompactionInfo): void {
  if (!info || typeof info !== 'object') return;
  endAssistant();
  finishThinking();
  addNode(createCompactionDivider(info));
}

// Assistant text streams into one message; rendering is batched to one Markdown pass per frame.
const rawByMessage = new WeakMap<HTMLElement, string>();
let currentAssistant: { el: HTMLElement; md: HTMLElement; raw: string } | null = null;
let renderQueued = false;

function ensureAssistant(): { el: HTMLElement; md: HTMLElement; raw: string } {
  if (!currentAssistant) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const md = document.createElement('div');
    md.className = 'md';
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button type="button" class="icon-btn sm msg-copy" aria-label="Copy message" data-tip="Copy">${icon('copy', 14)}</button>`;
    el.append(md, actions);
    currentAssistant = { el, md, raw: '' };
    addNode(el);
  }
  return currentAssistant;
}

/**
 * Streaming text is re-rendered at most every STREAM_RENDER_MS (about ten times a second), not on every animation
 * frame: the whole reply goes through the Markdown renderer each time, and a local model's token rate makes a
 * per-frame render pure CPU and GPU waste the reader cannot see.
 */
const STREAM_RENDER_MS = 90;
let lastAssistantRender = 0;

function flushAssistant(): void {
  renderQueued = false;
  if (!currentAssistant) return;
  lastAssistantRender = performance.now();
  currentAssistant.md.innerHTML = renderMarkdown(currentAssistant.raw);
  scrollToBottom();
}

function appendAssistantText(delta: string): void {
  const a = ensureAssistant();
  a.raw += delta;
  rawByMessage.set(a.el, a.raw);
  if (renderQueued) return;
  renderQueued = true;
  // A long reply costs more per render (every code block is highlighted again), so the interval grows with it.
  const interval = STREAM_RENDER_MS + Math.min(400, a.raw.length / 40);
  const wait = Math.max(0, interval - (performance.now() - lastAssistantRender));
  window.setTimeout(() => requestAnimationFrame(flushAssistant), wait);
}

function endAssistant(): void {
  if (currentAssistant) {
    currentAssistant.md.innerHTML = renderMarkdown(currentAssistant.raw);
    scrollToBottom();
  }
  currentAssistant = null;
}

messagesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const codeCopy = t.closest<HTMLElement>('.code-copy');
  if (codeCopy) {
    const code = codeCopy.closest('.code-block')?.querySelector('code');
    if (code) void copyWithFeedback(codeCopy, code.textContent ?? '');
    return;
  }
  const msgCopy = t.closest<HTMLElement>('.msg-copy');
  if (msgCopy) {
    const msg = msgCopy.closest<HTMLElement>('.msg.assistant, .msg.user');
    if (msg?.classList.contains('user')) void copyWithFeedback(msgCopy, userTextByMessage.get(msg) ?? msg.querySelector('.bubble')?.textContent ?? '');
    else if (msg) void copyWithFeedback(msgCopy, rawByMessage.get(msg) ?? msg.querySelector('.md')?.textContent ?? '');
    return;
  }
  const rewindBtn = t.closest<HTMLElement>('.msg-rewind');
  if (rewindBtn) {
    const msg = rewindBtn.closest<HTMLElement>('.msg.user');
    if (msg) void rewindTo(msg, rewindBtn);
    return;
  }
  const outCopy = t.closest<HTMLElement>('.out-copy');
  if (outCopy) {
    e.preventDefault();
    const pre = outCopy.parentElement?.querySelector('pre');
    if (pre) void copyWithFeedback(outCopy, pre.textContent ?? '');
    return;
  }
  const image = t.closest<HTMLImageElement>('img.shot[data-lightbox]');
  if (image) openLightbox(image.src, image.alt);
});

// Thinking: "Thinking…" while it streams, then "Thought for 12s".
let currentThinking: { el: HTMLDetailsElement; label: HTMLElement; body: HTMLElement; raw: string; startedAt: number } | null = null;

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function appendThinking(delta: string): void {
  if (!currentThinking) {
    endAssistant();
    const el = document.createElement('details');
    el.className = 'thinking live';
    el.innerHTML =
      `<summary><span class="tool-chevron">${icon('chevron-right')}</span><span class="think-icon">${icon('lightbulb')}</span>` +
      `<span class="think-label">Thinking<span class="ellipsis"><i>.</i><i>.</i><i>.</i></span></span></summary><div class="body"></div>`;
    currentThinking = { el, label: el.querySelector('.think-label')!, body: el.querySelector('.body')!, raw: '', startedAt: Date.now() };
    addNode(el);
  }
  currentThinking.raw += delta;
  thinkPending += delta;
  if (thinkQueued) return;
  thinkQueued = true;
  window.setTimeout(() => requestAnimationFrame(flushThinking), STREAM_RENDER_MS);
}

// Thinking arrives token by token; the text is appended in batches so the block is not rebuilt and re-laid-out per token.
let thinkPending = '';
let thinkQueued = false;

function flushThinking(): void {
  thinkQueued = false;
  if (!currentThinking || !thinkPending) {
    thinkPending = '';
    return;
  }
  currentThinking.body.appendChild(document.createTextNode(thinkPending));
  thinkPending = '';
  if (currentThinking.el.open) currentThinking.body.scrollTop = currentThinking.body.scrollHeight;
  scrollToBottom();
}

function finishThinking(): void {
  if (!currentThinking) return;
  if (thinkPending) {
    currentThinking.body.appendChild(document.createTextNode(thinkPending));
    thinkPending = '';
  }
  if (!currentThinking.raw.trim()) {
    // Some models open and close an empty think block; there is nothing to show.
    currentThinking.el.remove();
    currentThinking = null;
    return;
  }
  currentThinking.el.classList.remove('live');
  currentThinking.label.textContent = `Thought for ${seconds(Date.now() - currentThinking.startedAt)}`;
  currentThinking = null;
}

// Tool rows, and groups of 3+ consecutive read/search rows.
function updateGroup(group: Element | null): void {
  if (!group) return;
  const cards = [...group.querySelectorAll<HTMLElement>(':scope > .group-body > .tool')];
  const names = cards.map((c) => c.dataset.tool ?? '');
  group.querySelector('.group-verb')!.textContent = groupSummary(names);
  // A group of MCP calls only shows the plug; anything else the files icon.
  const kind: IconName = names.length && names.every((n) => mcpParts(n)) ? 'plug' : 'files';
  const groupIcon = group.querySelector<HTMLElement>('.group-icon')!;
  if ((groupIcon.dataset.kind ?? 'files') !== kind) {
    groupIcon.dataset.kind = kind;
    groupIcon.innerHTML = icon(kind);
  }
  const busy = cards.some((c) => c.querySelector('.tool-status.spin'));
  const failed = cards.filter((c) => c.querySelector('.tool-status.err')).length;
  group.querySelector('.group-icon')!.className = `group-icon${busy ? ' spin' : failed ? ' err' : ''}`;
  group.querySelector('.group-meta')!.innerHTML = failed ? `<span class="meta-err">${failed} failed</span>` : '';
}

function maybeGroup(cardEl: HTMLElement): void {
  if (!cardEl.classList.contains('groupable')) return;
  const run: HTMLElement[] = [cardEl];
  let node = cardEl.previousElementSibling as HTMLElement | null;
  while (node && (node.classList.contains('thinking') || node.classList.contains('groupable'))) {
    run.unshift(node);
    node = node.previousElementSibling as HTMLElement | null;
  }
  if (node?.classList.contains('tool-group')) {
    const body = node.querySelector(':scope > .group-body')!;
    for (const n of run) body.appendChild(n);
    updateGroup(node);
    return;
  }
  while (run.length && !run[0].classList.contains('tool')) run.shift();
  if (run.filter((n) => n.classList.contains('tool')).length < 3) return;
  const group = document.createElement('details');
  group.className = 'tool-group';
  group.innerHTML =
    `<summary><span class="tool-chevron">${icon('chevron-right')}</span><span class="group-icon">${icon('files')}</span>` +
    `<span class="tool-verb group-verb"></span><span class="tool-meta group-meta"></span></summary><div class="group-body"></div>`;
  run[0].before(group);
  const body = group.querySelector(':scope > .group-body')!;
  for (const n of run) body.appendChild(n);
  updateGroup(group);
}

function addToolCard(name: string, args: unknown, id?: string): ToolCard {
  endAssistant();
  finishThinking();
  const card = createToolCard(name, args);
  if (id) toolCards.set(id, card);
  lastToolCard = card;
  addNode(card.el);
  maybeGroup(card.el);
  return card;
}

function finishToolCard(ev: { id?: string; name: string; result: string; ok: boolean; image?: string; durationMs?: number }, known?: ToolCard): void {
  const card = known ?? (ev.id ? toolCards.get(ev.id) : undefined);
  if (!card) return;
  card.finish({ result: ev.result, ok: ev.ok, image: ev.image, durationMs: ev.durationMs });
  if (ev.id) toolCards.delete(ev.id);
  updateGroup(card.el.closest('.tool-group'));
  scrollToBottom();
}

// Approval card: Claude's wording, keys shown inside the buttons, collapses to one line once decided.
function addApprovalCard(ev: Extract<AgentEvent, { type: 'approval_request' }>, synthetic = false): void {
  endAssistant();
  finishThinking();
  pendingApproval?.cancel('Superseded');
  const card = lastToolCard && lastToolCard.running && lastToolCard.name === ev.name ? lastToolCard : null;
  const el = document.createElement('div');
  const reason = typeof ev.reason === 'string' ? ev.reason.trim() : '';
  el.className = 'approval' + (reason ? ' flagged' : '');
  const mcp = mcpParts(ev.name);
  const iconName: IconName = mcp ? 'plug' : ev.name === 'bash' || ev.name === 'terminal_run' ? 'terminal' : ev.name === 'edit_file' ? 'pencil' : ev.name === 'write_file' ? 'file-plus' : 'shield-check';
  if (mcp) el.classList.add('mcp');
  const reasonHtml = reason
    ? `<div class="reason">${icon('triangle-alert', 14)}<span>${escapeHtml(`${ev.mode === 'auto' ? 'Auto mode paused' : 'Paused'}: ${reason}`)}</span></div>`
    : '';
  el.innerHTML = `<div class="approval-head"><span class="approval-icon">${icon(iconName)}</span><div class="approval-heading"><div class="title">${escapeHtml(
    approvalTitle(ev.name, ev.detail, card?.args),
  )}</div>${reasonHtml}</div></div>`;
  const body = document.createElement('div');
  body.className = 'approval-body';
  let subject = ev.name;
  if (mcp) {
    // The arguments, pretty-printed by the main process, in the same mono block as a command.
    subject = `${mcp.tool} · ${mcp.server}`;
    const json = typeof ev.detail === 'string' ? ev.detail.trim() : '';
    body.innerHTML = json && json !== '{}' ? `<div class="cmd json"><code>${highlight(json, 'json')}</code></div>` : '<div class="tool-note">No arguments</div>';
  } else if (ev.name === 'bash' || ev.name === 'terminal_run') {
    subject = ev.detail.split('\n')[0];
    body.innerHTML = `<div class="cmd"><span class="cmd-prompt">$</span><code>${highlight(ev.detail, 'sh')}</code></div>`;
  } else if (ev.name === 'edit_file' && parseEditPreview(ev.detail)) {
    const p = parseEditPreview(ev.detail)!;
    subject = basename(p.path);
    let rows = lineDiff(p.oldText, p.newText);
    const at = editStartLine(p.path, p.oldText);
    if (at !== undefined) rows = numberRows(rows, at);
    body.appendChild(renderDiff(displayPath(p.path), rows));
  } else if (ev.name === 'write_file' && card && typeof card.args.content === 'string') {
    const path = typeof card.args.path === 'string' ? card.args.path : ev.detail.split('\n')[0];
    subject = basename(path);
    body.appendChild(renderDiff(displayPath(ev.detail.split('\n')[0] || path), numberRows(fileLines(card.args.content).map((t) => ({ kind: 'add' as const, text: t })), 1)));
  } else {
    if (ev.name === 'write_file') subject = basename(ev.detail.split('\n')[0]);
    const pre = document.createElement('pre');
    pre.className = 'args';
    pre.textContent = ev.name === 'write_file' || ev.name === 'edit_file' ? ev.detail.replace(/^[^\n]+/, (line) => displayPath(line)) : ev.detail;
    body.appendChild(pre);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const button = (label: string, key: string, cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `<span>${escapeHtml(label)}</span><kbd>${key}</kbd>`;
    return b;
  };
  const alwaysLabel = typeof ev.alwaysLabel === 'string' && ev.alwaysLabel.trim() ? ev.alwaysLabel.trim() : 'Allow for this session';
  const projectLabel = typeof ev.projectLabel === 'string' && ev.projectLabel.trim() ? ev.projectLabel.trim() : 'Always allow for this project';
  const deny = button('Deny', 'n', 'btn');
  const always = button(alwaysLabel, 'a', 'btn');
  const project = button(projectLabel, 'p', 'btn');
  const allow = button('Allow', '↵', 'btn primary');
  always.classList.add('always');
  project.classList.add('project');
  // The "don't ask again" answers stack on the left with equal widths; Deny and Allow stay at the bottom right
  // (on a narrow card they wrap below). A label cut short shows in full as a tooltip.
  for (const b of [always, project]) {
    b.addEventListener('pointerover', () => {
      const label = b.querySelector('span');
      if (label && label.scrollWidth > label.clientWidth + 1) b.dataset.tip = label.textContent ?? '';
      else delete b.dataset.tip;
    });
  }
  const remember = document.createElement('div');
  remember.className = 'row-always';
  remember.append(always, project);
  const decision = document.createElement('div');
  decision.className = 'row-main';
  decision.append(deny, allow);
  row.append(remember, decision);
  el.append(body, row);

  /** once: this action only; session: "allow … for this session"; project: saved for the working directory */
  type Answer = 'once' | 'session' | 'project';
  let settled = false;
  const collapse = (text: string, ok: boolean) => {
    el.classList.add('done');
    el.innerHTML = `<div class="decided"><span class="${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x')}</span><span>${escapeHtml(text)}</span>${
      subject ? `<span>·</span><code>${escapeHtml(subject)}</code>` : ''
    }</div>`;
  };
  const decide = async (ok: boolean, answer: Answer = 'once') => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    pendingApproval = null;
    const kind: Answer = ok ? answer : 'once';
    collapse(!ok ? 'Denied' : kind === 'session' ? alwaysLabel.replace(/^Allow\b/, 'Allowed') : kind === 'project' ? 'Allowed · saved for this project' : 'Allowed', ok);
    if (running) setStatusText(baseVerb());
    if (synthetic) return;
    const before = currentMode();
    try {
      const next = kind === 'project' ? await oc.respondApproval(ev.id, true, true, 'project') : await oc.respondApproval(ev.id, ok, kind === 'session');
      if (next && typeof next === 'object' && 'permissionMode' in next) config = next;
      else if (kind !== 'once') config = await oc.getConfig();
    } catch (err) {
      addSystemMessage(`Couldn't send your answer: ${cleanError(err)}`, 'error');
      return;
    }
    applyConfigToUi();
    announceMode(before);
    // The new rule shows in Settings → Permissions.
    if (kind === 'project') void rulesPanel.refresh();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (dialogOpen() || isMenuOpen()) return;
    const t = e.target as HTMLElement;
    if (isTextField(t) && !(t === inputEl && composerEmpty())) return;
    const k = e.key;
    if (k === 'Enter' && (t instanceof HTMLButtonElement || t.closest('[role="tab"]'))) return;
    let action: (() => void) | null = null;
    if (k === 'y' || k === 'Y' || k === 'Enter') action = () => void decide(true);
    else if (k === 'n' || k === 'N' || k === 'Escape') action = () => void decide(false);
    else if (k === 'a' || k === 'A') action = () => void decide(true, 'session');
    else if (k === 'p' || k === 'P') action = () => void decide(true, 'project');
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  document.addEventListener('keydown', onKey, true);
  pendingApproval = {
    name: ev.name,
    cancel: (why: string) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      pendingApproval = null;
      collapse(why, false);
    },
    allow: () => void decide(true),
  };
  allow.onclick = () => void decide(true);
  always.onclick = () => void decide(true, 'session');
  project.onclick = () => void decide(true, 'project');
  deny.onclick = () => void decide(false);
  addNode(el);
  scrollToBottom(true);
}

// Plan cards: the newest proposed plan has the buttons; Enter builds and Esc keeps planning while it is the last card.
const KEEP_PLACEHOLDER = 'Tell OpenAgent what to change in the plan…';
const DEFAULT_PLACEHOLDER = inputEl.placeholder;
const RUNNING_PLACEHOLDER = 'Send a message — it reaches the agent after its current step';
/** The placeholder while no run is going (the default, or the "keep planning" prompt) */
let basePlaceholder = DEFAULT_PLACEHOLDER;

function setBasePlaceholder(text: string): void {
  basePlaceholder = text;
  syncPlaceholder();
}

function syncPlaceholder(): void {
  inputEl.placeholder = running ? RUNNING_PLACEHOLDER : basePlaceholder;
}
const planCards = new Map<string, PlanCard>();
let activePlan: PlanCard | null = null;

function addPlanCard(plan: PlanInfo, opts: { synthetic?: boolean; interactive?: boolean } = {}): PlanCard | null {
  if (!plan || typeof plan !== 'object' || !plan.id) return null;
  endAssistant();
  finishThinking();
  const existing = planCards.get(plan.id);
  if (existing) {
    existing.update(plan);
    return existing;
  }
  const interactive = opts.interactive ?? plan.status === 'proposed';
  if (interactive) activePlan?.retire();
  const card = createPlanCard(plan, {
    interactive,
    respond: (c, decision, btn) => respondPlan(c, decision, btn, Boolean(opts.synthetic)),
    modeLabel: (d) => MODES[d === 'build-acceptEdits' ? 'acceptEdits' : 'ask'].label,
  });
  planCards.set(plan.id, card);
  if (interactive) activePlan = card;
  addNode(card.el);
  return card;
}

async function respondPlan(card: PlanCard, decision: PlanDecision, btn: HTMLElement, synthetic: boolean): Promise<boolean> {
  if (!synthetic) {
    try {
      if (typeof oc.plan?.respond !== 'function') throw new Error('No handler registered');
      await oc.plan.respond(card.plan.id, decision);
    } catch (err) {
      showInlineError(btn, `Couldn't ${decision === 'keep' ? 'send the plan back' : 'start building'}: ${cleanError(err)}`);
      return false;
    }
  }
  if (card === activePlan && (statusState === 'plan-ready' || statusState === 'plan-wait')) setStatus('off');
  if (decision === 'keep') {
    setBasePlaceholder(KEEP_PLACEHOLDER);
    if (!dialogOpen()) inputEl.focus();
  } else if (!synthetic) {
    const before = currentMode();
    try {
      config = await oc.getConfig();
      applyConfigToUi();
    } catch {
      /* the chip catches up on the next config read */
    }
    if (currentMode() === 'plan' && before === 'plan') {
      // An older main process does not switch modes itself.
      showInlineError(modeBtn, 'Still in Plan mode: switch the mode to let OpenAgent make changes.');
    }
  }
  return true;
}

// Artifact cards: one per artifact id; an update refreshes the existing card in place.
const artifactCards = new Map<string, ArtifactCard>();

function addArtifactCard(info: ArtifactInfo, opts: { updated?: boolean } = {}): ArtifactCard | null {
  if (!info || typeof info !== 'object' || !info.id) return null;
  const existing = artifactCards.get(info.id);
  if (existing) {
    const newer = Number(info.version) > Number(existing.info.version);
    existing.update(info, newer || Boolean(opts.updated));
    return existing;
  }
  endAssistant();
  finishThinking();
  const card = createArtifactCard(info, { act: artifactAction, updated: Boolean(opts.updated) || Number(info.version) > 1 });
  artifactCards.set(info.id, card);
  addNode(card.el);
  return card;
}

const ARTIFACT_VERBS: Record<ArtifactAction, string> = { open: 'open', saveAs: 'save', reveal: 'reveal' };

async function artifactAction(card: ArtifactCard, action: ArtifactAction, button: HTMLButtonElement): Promise<string | boolean> {
  const api = oc.artifacts;
  try {
    if (!api || typeof api[action] !== 'function') throw new Error('No handler registered');
    if (action === 'open') {
      await api.open(card.info.id);
      showPaneTab('browser');
      return true;
    }
    if (action === 'saveAs') {
      const saved = await api.saveAs(card.info.id);
      if (!saved) return false;
      button.dataset.tip = `Saved to ${saved}`;
      return 'Saved';
    }
    await api.reveal(card.info.id);
    return true;
  } catch (err) {
    showInlineError(button, `Couldn't ${ARTIFACT_VERBS[action]} the artifact: ${cleanError(err)}`);
    return false;
  }
}

/** True when nothing but quiet notices follows the card in the transcript. */
function isLastCard(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.matches('.msg.user, .msg.assistant, .tool, .tool-group, .approval, .plan-card, .artifact-card, .thinking')) return false;
  }
  return true;
}

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    if (!activePlan?.pending() || running || pendingApproval) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (dialogOpen() || isMenuOpen() || !slashMenu.hidden || titleEditing) return;
    const t = e.target as HTMLElement;
    if (isTextField(t) && !(t === inputEl && composerEmpty())) return;
    if (composerHasContent()) return;
    if (e.key === 'Enter' && (t instanceof HTMLButtonElement || t.closest('[role="tab"]'))) return;
    if (!isLastCard(activePlan.el)) return;
    e.preventDefault();
    e.stopPropagation();
    void activePlan.decide(e.key === 'Enter' ? 'build-ask' : 'keep');
  },
  true,
);

function clearMessages(): void {
  showJump(false);
  messagesEl.querySelectorAll(':scope > :not(#empty-state)').forEach((n) => n.remove());
  emptyState.hidden = false;
  currentAssistant = null;
  currentThinking = null;
  thinkPending = '';
  lastToolCard = null;
  toolCards.clear();
  hiddenTools.clear();
  planCards.clear();
  artifactCards.clear();
  activePlan = null;
  turnSync++;
  setBasePlaceholder(DEFAULT_PLACEHOLDER);
  if (statusState !== 'run') setStatus('off');
  clearBrowsing();
  resetFileCache();
  stick = true;
}

function renderTranscript(items: TranscriptItem[]): void {
  clearMessages();
  // Only the newest plan can still be decided, and only if nothing was said after it.
  let lastPlan = -1;
  let lastUser = -1;
  items.forEach((item, i) => {
    if (item.role === 'plan') lastPlan = i;
    else if (item.role === 'user') lastUser = i;
  });
  items.forEach((item, i) => {
    if (item.role === 'user') {
      const images = Array.isArray(item.images) ? item.images.filter((src): src is string => typeof src === 'string' && Boolean(src)) : [];
      addUserMessage(item.text ?? '', images.map((src) => ({ src })), Array.isArray(item.mentions) ? item.mentions : null, { turn: item.turn });
    } else if (item.role === 'assistant') {
      appendAssistantText(item.text);
      endAssistant();
    } else if (item.role === 'plan') {
      addPlanCard(item.plan, { interactive: i === lastPlan && i > lastUser && item.plan?.status === 'proposed' });
    } else if (item.role === 'artifact') {
      addArtifactCard(item.artifact);
    } else if (item.role === 'compaction') {
      addCompaction(item.compaction);
    } else if (item.role === 'tool') {
      if (item.name === 'submit_plan' && item.ok) return;
      const card = addToolCard(item.name, item.args);
      finishToolCard({ name: item.name, result: item.result, ok: item.ok }, card);
    }
  });
  scrollToBottom(true);
}

// ---------- Rewind: user bubbles carry their checkpoint (turn); Rewind goes back to it ----------

const REWIND_DESCRIPTION =
  'Files the agent wrote or edited after it go back to how they were, the later messages are removed, and the message returns to the composer. Changes made by commands are not undone.';

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Gives the bubbles on screen their checkpoints from the transcript the main process holds: the newest transcript
 * message goes to the newest bubble with the same text, and so on backwards. Bubbles without a match (and commands
 * handled here) get none.
 */
function applyTurns(items: TranscriptItem[]): void {
  const users = items.filter((it): it is Extract<TranscriptItem, { role: 'user' }> => it?.role === 'user');
  const bubbles = [...messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user:not([data-local])')];
  const turns = new Map<HTMLElement, number | undefined>();
  let end = bubbles.length - 1;
  for (let i = users.length - 1; i >= 0 && end >= 0; i--) {
    const text = typeof users[i].text === 'string' ? users[i].text : '';
    let j = end;
    while (j >= 0 && !sameText(userTextByMessage.get(bubbles[j]) ?? '', text)) j--;
    if (j < 0) continue;
    turns.set(bubbles[j], users[i].turn);
    end = j - 1;
  }
  for (const el of messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user')) setTurn(el, turns.get(el));
}

/** After a run (or a fork): the bubbles learn their checkpoints from the transcript, read back from the main process. */
async function syncTurns(): Promise<void> {
  const my = ++turnSync;
  const id = currentSessionId;
  if (!id || running || typeof oc.sessions?.switch !== 'function') return;
  let items: TranscriptItem[];
  try {
    items = await oc.sessions.switch(id);
  } catch {
    return; // a new run started meanwhile; its end syncs again
  }
  if (my !== turnSync || id !== currentSessionId || running || rewinding || !Array.isArray(items)) return;
  applyTurns(items);
}

/** A compaction folded the conversation: none of the earlier messages can be rewound to any more. */
function clearTurns(): void {
  turnSync++;
  for (const el of messagesEl.querySelectorAll<HTMLElement>(':scope > .msg.user[data-turn]')) setTurn(el, undefined);
}

/** Rewind waits for an idle agent: its buttons are hidden during a run, a compaction or another rewind. */
function syncBusyUi(): void {
  shell.classList.toggle('rewind-off', running || compacting !== null || rewinding);
  taskList.setRunning(running);
}

function setRewinding(v: boolean): void {
  rewinding = v;
  syncBusyUi();
}

/** "Rewound · 2 files restored · 1 removed", and the paths for its tooltip. */
function rewindNotice(res: RewindResult): { text: string; tip: string } {
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && Boolean(p)) : []);
  const restored = paths(res.restored);
  const removed = paths(res.deleted);
  const skipped = paths(res.skipped);
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (restored.length) parts.push(`${files(restored.length)} restored`);
  if (removed.length) parts.push(parts.length ? `${removed.length} removed` : `${files(removed.length)} removed`);
  if (skipped.length) parts.push(parts.length ? `${skipped.length} could not be restored` : `${files(skipped.length)} could not be restored`);
  const list = (label: string, a: string[]) => (a.length ? `${label}: ${a.slice(0, 8).join(', ')}${a.length > 8 ? ` and ${a.length - 8} more` : ''}` : '');
  return {
    text: `Rewound · ${parts.length ? parts.join(' · ') : 'no files changed'}`,
    tip: [list('Restored', restored), list('Removed', removed), list('Not restored', skipped)].filter(Boolean).join('\n'),
  };
}

/** The rewound message's images go back into the composer with its text. */
async function restoreImages(srcs: string[]): Promise<void> {
  const inputs: ImageInput[] = [];
  srcs.forEach((src, i) => {
    try {
      inputs.push({ blob: dataUrlToBlob(src), name: srcs.length > 1 ? `Image ${i + 1}` : 'Image' });
    } catch {
      /* not a data: URL the tray can read */
    }
  });
  if (inputs.length) await attachImages(inputs);
}

/** The bubble's Rewind: confirm, rewind the session to the message's checkpoint, and hand the message back to the composer. */
async function rewindTo(msg: HTMLElement, button: HTMLElement): Promise<void> {
  const turn = turnOf(msg);
  if (turn === null || rewinding) return;
  const busy = () => {
    if (!running && !compacting) return false;
    showInlineError(button.isConnected && button.offsetParent ? button : sendBtn, running ? 'Rewinding has to wait for the run to finish (or stop it with Esc).' : 'Rewinding has to wait for the compaction to finish.');
    return true;
  };
  if (busy()) return;
  if (typeof oc.sessions?.rewind !== 'function') {
    addSystemMessage('Rewinding needs the updated app. Restart OpenAgent and try again.', 'error');
    return;
  }
  const ok = await confirmAction({ title: 'Rewind to this message?', description: REWIND_DESCRIPTION, confirmLabel: 'Rewind', danger: true });
  if (!ok || rewinding || !msg.isConnected || busy()) return;
  const images = [...msg.querySelectorAll<HTMLImageElement>('.bubble-image img')].map((img) => img.getAttribute('src') ?? '').filter((src) => src.startsWith('data:image/'));
  setRewinding(true);
  let res: RewindResult;
  try {
    res = await oc.sessions.rewind(turn);
    if (!res || typeof res !== 'object' || !Array.isArray(res.transcript)) throw new Error('The app did not answer.');
  } catch (err) {
    setRewinding(false);
    addSystemMessage(`Couldn't rewind: ${cleanError(err)}`, 'error');
    return;
  }
  setRewinding(false);
  renderTranscript(res.transcript);
  if (res.session && typeof res.session === 'object' && res.session.id === currentSessionId) showTasks(res.session.tasks);
  const notice = rewindNotice(res);
  const note = addSystemMessage(notice.text, 'notice');
  if (notice.tip) note.querySelector('span')?.setAttribute('data-tip', notice.tip);
  // The message comes back into the composer (after anything already typed there), caret at the end.
  restoreComposerText(typeof res.text === 'string' ? res.text : '');
  if (images.length) void restoreImages(images);
  if (!dialogOpen()) inputEl.focus();
  void refreshSessions();
  void changesPane.refresh();
  void refreshContext();
}

// ---------- Run state ----------

let sendShowsStop: boolean | null = null;
function updateSendButton(): void {
  sendBtn.disabled = running ? false : !composerHasContent();
  if (sendShowsStop === running) return;
  sendShowsStop = running;
  sendBtn.innerHTML = icon(running ? 'square' : 'arrow-up');
  sendBtn.classList.toggle('stop', running);
  sendBtn.setAttribute('aria-label', running ? 'Stop' : 'Send');
  sendBtn.dataset.tip = running ? 'Stop' : 'Send';
  sendBtn.dataset.tipKbd = running ? 'esc' : '↵';
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// The status line: the run (spinner, verb, elapsed, tokens, esc) or, after a plan, a quiet line with the keys.
type StatusState = 'off' | 'run' | 'plan-ready' | 'plan-wait';
let statusState: StatusState = 'off';
let statusTimer: number | undefined;

function setStatus(state: StatusState, text?: string): void {
  statusState = state;
  window.clearTimeout(statusTimer);
  statusLine.hidden = state === 'off';
  statusLine.classList.toggle('idle', state !== 'run');
  statusHint.hidden = state !== 'plan-wait' || composerHasContent();
  if (text !== undefined) statusText.textContent = text;
}

function setStatusText(text: string): void {
  if (statusState === 'run' && statusText.textContent !== text) statusText.textContent = text;
}

/** "Working…", or "Planning…" in plan mode */
function baseVerb(): string {
  return currentMode() === 'plan' ? 'Planning…' : 'Working…';
}

function showPlanReady(): void {
  setStatus('plan-ready', 'Plan ready for review');
  statusTimer = window.setTimeout(() => {
    if (statusState !== 'plan-ready') return;
    if (activePlan?.pending() && isLastCard(activePlan.el)) setStatus('plan-wait', 'Waiting for plan approval');
    else setStatus('off');
  }, 2500);
}

/** Ends the plan status line once the plan was decided elsewhere. */
function syncPlanStatus(): void {
  if ((statusState === 'plan-ready' || statusState === 'plan-wait') && !activePlan?.pending()) setStatus('off');
}

/**
 * Spinners rotate through one 8-per-second timer and a CSS variable instead of CSS animations: Chromium ticks a
 * running animation on every frame whether or not it changes, which costs a few percent of CPU for the whole run.
 */
let spinTimer: number | undefined;
let spinStep = 0;
function syncSpin(): void {
  const want = (running || compacting !== null) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (want && spinTimer === undefined) {
    spinTimer = window.setInterval(() => {
      spinStep = (spinStep + 1) % 12;
      // Set on each spinner, never on the document: a root-level change recalculates styles for the whole transcript.
      const deg = `${spinStep * 30}deg`;
      document.querySelectorAll<HTMLElement>('.spinner, .tool-status.spin, .group-icon.spin').forEach((el) => el.style.setProperty('--spin', deg));
    }, 125);
  } else if (!want && spinTimer !== undefined) {
    window.clearInterval(spinTimer);
    spinTimer = undefined;
  }
}

function setRunning(v: boolean): void {
  running = v;
  updateSendButton();
  syncPlaceholder();
  syncBusyUi();
  syncSpin();
  if (v) {
    runStartedAt = Date.now();
    setStatus('run', baseVerb());
    statusTime.textContent = '0s';
    statusTokens.hidden = true;
    runOutputTokens = 0;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      statusTime.textContent = elapsed(Date.now() - runStartedAt);
    }, 1000);
  } else {
    if (statusState === 'run') setStatus('off');
    if (timer) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }
  void refreshSessions();
}

// ---------- Compaction: the status line while the conversation is summarised, /compact and "Compact now" ----------

const COMPACTING_TEXT = 'Compacting context…';
/**
 * A compaction in progress. standalone: started outside a run (/compact, "Compact now"), so the status line is
 * shown for it alone (with its own elapsed time and the stop button, since abort cancels it) without counting as
 * a run. Otherwise it is an auto-compaction inside a run, which only swaps the status text until it ends.
 */
let compacting: { reason: 'auto' | 'manual'; standalone: boolean; prevText: string } | null = null;
/** Set when a compact_end with an error arrives, so oc.compact()'s own error is not shown a second time */
let compactErrorShown = false;

function startCompaction(reason: 'auto' | 'manual'): void {
  if (running) {
    const prev = statusText.textContent ?? '';
    compacting = { reason, standalone: false, prevText: prev && prev !== COMPACTING_TEXT ? prev : baseVerb() };
    setStatusText(COMPACTING_TEXT);
  } else {
    compacting = { reason, standalone: true, prevText: '' };
    runStartedAt = Date.now();
    setStatus('run', COMPACTING_TEXT);
    statusTime.textContent = '0s';
    statusTokens.hidden = true;
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      statusTime.textContent = elapsed(Date.now() - runStartedAt);
    }, 1000);
  }
  statusLine.classList.add('compacting');
  syncBusyUi();
  syncSpin();
}

function endCompaction(): void {
  const c = compacting;
  compacting = null;
  statusLine.classList.remove('compacting');
  syncBusyUi();
  syncSpin();
  if (!c) return;
  if (running) {
    // The previous verb comes back (the next event of the run replaces it as usual).
    if (statusText.textContent === COMPACTING_TEXT) setStatusText(c.prevText || baseVerb());
    return;
  }
  if (statusState === 'run') setStatus('off');
  if (timer) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

/** /compact and the context meter's "Compact now": failures show as an error notice in the transcript. */
async function compactNow(focus?: string): Promise<void> {
  if (typeof oc.compact !== 'function') {
    addSystemMessage('Compacting needs the updated app. Restart OpenAgent and try again.', 'error');
    return;
  }
  compactErrorShown = false;
  let res: { ok: boolean; error?: string };
  try {
    const r = await oc.compact(focus || undefined);
    res = r && typeof r === 'object' ? r : { ok: false, error: 'The app did not answer.' };
  } catch (err) {
    res = { ok: false, error: cleanError(err) };
  }
  if (!res.ok && !compactErrorShown) addSystemMessage(res.error || "Couldn't compact the conversation.", 'error');
}

/** The context meter: from 'context' events, oc.context() after a reload or session switch, and the debug hook. */
const contextMeter = createContextMeter({
  button: contextMeterBtn,
  boundary: transcriptWrap,
  busy: () => running || compacting !== null,
  compact: () => void compactNow(),
  openSettings: () => openSettings(config?.provider === 'portkey' ? 'portkey-contextWindow' : 'ollama-numCtx'),
});

async function refreshContext(): Promise<void> {
  if (typeof oc.context !== 'function') return;
  try {
    contextMeter.set(normalizeContext(await oc.context()));
  } catch {
    /* no session yet, or an older app: the meter waits for a context event */
  }
}

/** The context window the status line's token counter compares against. */
function contextLimit(): number {
  const known = contextMeter.get()?.limit;
  if (known) return known;
  if (!config) return 0;
  return config.provider === 'ollama' ? Number(config.ollama.numCtx) || 0 : Number(config.portkey.contextWindow) || 0;
}

/** True from Enter until the main process has answered, so a double Enter cannot send twice. */
let sending = false;

async function send(): Promise<void> {
  if (sending || rewinding || !composerHasContent()) return;
  sending = true;
  try {
    // Images still being scaled down go along once they are ready.
    if (tray.pending()) await tray.idle();
    await sendComposer();
  } finally {
    sending = false;
    updateSendButton();
  }
}

async function sendToAgent(text: string, images: ImageAttachment[]): Promise<SendResult> {
  try {
    const res = await oc.send(text, images.length ? images : undefined);
    return res && typeof res === 'object' ? res : { ok: false, error: 'The app did not answer.' };
  } catch (err) {
    return { ok: false, error: cleanError(err) };
  }
}

/** Puts text back into the composer, on a new line after anything already typed. */
function restoreComposerText(text: string): void {
  if (!text) return;
  mentionPicker.close();
  const current = inputEl.value.replace(/\s+$/, '');
  inputEl.value = current ? `${current}\n${text}` : text;
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
  autosize();
}

/** Messages that did not reach the agent go back into the composer, text and images. */
function returnToComposer(messages: QueuedMessage[]): void {
  let left = 0;
  for (const m of messages) {
    restoreComposerText(typeof m.text === 'string' ? m.text : '');
    if (Array.isArray(m.attachments) && m.attachments.length) left += tray.restore(m.attachments);
  }
  if (left) showInlineError(attachBtn, `${left} image${left === 1 ? '' : 's'} did not fit: a message can have up to 8.`);
  // Focus comes to the composer unless the user is typing somewhere else (a terminal, the search field, the URL bar).
  const active = document.activeElement;
  if (!dialogOpen() && !titleEditing && (active === inputEl || !isTextField(active))) inputEl.focus();
}

/** While a run is in progress the message waits in the queue until the agent's next step. */
async function queueMessage(text: string, images: ImageAttachment[]): Promise<void> {
  const res = await sendToAgent(text, images);
  const sent = images.map((a) => a.id);
  if (res.ok && res.queued && res.id) {
    queueList.add({ id: res.id, text, attachments: images, createdAt: Date.now() });
    tray.clear(sent);
  } else if (res.ok) {
    // The run ended in the meantime, so the message started a new one.
    endAssistant();
    addUserMessage(text, images.map(bubbleImage));
    runningSessionId = currentSessionId;
    tray.clear(sent);
  } else {
    restoreComposerText(text);
    showInlineError(sendBtn, `Couldn't queue the message: ${res.error ?? 'unknown error'}`);
  }
}

async function sendComposer(): Promise<void> {
  const text = inputEl.value.trim();
  const images = tray.items();
  if (!text && !images.length) return;
  inputEl.value = '';
  autosize();
  hideSlashMenu();
  mentionPicker.close();
  const compactCmd = images.length ? null : /^\/compact(?:\s+([\s\S]*))?$/.exec(text);
  if (compactCmd) {
    if (running || compacting) {
      // Not sent anywhere: it goes back into the composer for after the run.
      restoreComposerText(text);
      showInlineError(sendBtn, running ? 'Compacting has to wait for the run to finish (or stop it with Esc).' : 'The conversation is already being compacted.');
      return;
    }
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    await compactNow(compactCmd[1]?.trim());
    return;
  }
  if (!images.length && text === '/mcp') {
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    await addMcpCard();
    return;
  }
  if (!images.length && (text === '/skills' || text === '/help')) {
    endAssistant();
    addUserMessage(text, [], null, { local: true });
    const list = await oc.skills.list();
    addNoticeCard(
      list.length
        ? `**Skills**\n\n${list.map((sk) => `- \`/${sk.name}\` ${sk.description || 'No description'} *(${sk.source})*`).join('\n')}`
        : 'No skills found. Add a folder with a `SKILL.md` under `.openagent/skills` in your project or `~/.openagent/skills`.',
    );
    return;
  }
  if (running) return queueMessage(text, images);
  // Replying instead of approving sends the plan back, with this message as the feedback (as in Claude Code).
  if (activePlan?.pending()) await activePlan.decide('keep');
  setBasePlaceholder(DEFAULT_PLACEHOLDER);
  if (statusState !== 'run') setStatus('off');
  const bubble = addUserMessage(text, images.map(bubbleImage));
  endAssistant();
  runningSessionId = currentSessionId;
  const res = await sendToAgent(text, images);
  const sent = images.map((a) => a.id);
  if (res.ok && res.queued && res.id) {
    // A run was already going (e.g. this window was reloaded during one): the message waits in the queue instead.
    bubble.remove();
    if (!messagesEl.querySelector(':scope > :not(#empty-state)')) emptyState.hidden = false;
    queueList.add({ id: res.id, text, attachments: images, createdAt: Date.now() });
    tray.clear(sent);
  } else if (res.ok) tray.clear(sent);
  else {
    // Not in the conversation, so there is nothing to rewind to
    bubble.dataset.local = 'true';
    addSystemMessage(res.error ?? 'Could not start the run.', 'error');
  }
}

// Browser tools: an "Agent is browsing" pill while one runs, and the Browser tab comes forward.
const browsingTools = new Set<string>();
function clearBrowsing(): void {
  browsingTools.clear();
  browsingPill.hidden = true;
}

/** Tool calls that do not get a row (the plan and artifacts arrive as cards instead), with their arguments. */
const hiddenTools = new Map<string, unknown>();
const CARD_TOOLS = new Set(['submit_plan', 'create_artifact']);

function handleEvent(ev: AgentEvent, synthetic = false): void {
  switch (ev.type) {
    case 'run_start':
      runningSessionId = currentSessionId;
      setRunning(true);
      break;
    case 'thinking_delta':
      setStatusText('Thinking…');
      appendThinking(ev.text);
      break;
    case 'thinking_done':
      finishThinking();
      break;
    case 'text_delta':
      setStatusText(currentMode() === 'plan' ? 'Planning…' : 'Responding…');
      finishThinking();
      appendAssistantText(ev.text);
      break;
    case 'text_done':
      endAssistant();
      break;
    case 'tool_start': {
      const id = ev.id ?? ev.name;
      if (CARD_TOOLS.has(ev.name)) {
        hiddenTools.set(id, ev.args);
        setStatusText(ev.name === 'submit_plan' ? 'Writing the plan…' : statusVerb(ev.name));
        break;
      }
      setStatusText(statusVerb(ev.name));
      if (ev.name.startsWith('browser_')) {
        browsingTools.add(id);
        browsingPill.hidden = false;
        if (paneVisible && paneTab !== 'browser') showPaneTab('browser');
      } else if (ev.name.startsWith('terminal_')) {
        // Same rule as the browser: a visible pane comes to the Terminal tab (without opening a shell of its own;
        // terminal_run opens the agent's tab); a hidden pane stays hidden.
        if (paneVisible && paneTab !== 'terminal') {
          terminalPane.holdAutoOpen();
          showPaneTab('terminal');
        }
        const tabId = asArgs(ev.args).tab_id;
        if (typeof tabId === 'string' || typeof tabId === 'number') terminalPane.select(String(tabId).trim());
      }
      addToolCard(ev.name, ev.args, ev.id);
      break;
    }
    case 'tool_end': {
      const id = ev.id ?? ev.name;
      if (hiddenTools.has(id)) {
        const args = hiddenTools.get(id);
        hiddenTools.delete(id);
        // A plan or artifact that could not be made is shown as a failed row, so the error is visible.
        const failed = !ev.ok || (ev.name === 'create_artifact' && /^\s*Error\b/.test(String(ev.result ?? '')));
        if (failed) finishToolCard({ ...ev, ok: false, id: undefined }, addToolCard(ev.name, args));
        if (ev.name !== 'submit_plan') setStatusText(baseVerb());
        break;
      }
      if (browsingTools.delete(id)) browsingPill.hidden = browsingTools.size === 0;
      finishToolCard(ev);
      setStatusText(baseVerb());
      break;
    }
    case 'usage': {
      const prompt = Number(ev.promptTokens) || 0;
      const completion = Number(ev.completionTokens) || 0;
      runOutputTokens += completion;
      const context = prompt + completion;
      const limit = contextLimit();
      statusTokens.textContent = `${formatCount(context)} tokens`;
      statusTokens.dataset.tip = `Context ${formatCount(context)}${limit ? ` of ${formatCount(limit)}` : ''} · Output ${formatCount(runOutputTokens)} this run`;
      statusTokens.classList.toggle('near-limit', limit > 0 && context / limit >= 0.85);
      statusTokens.hidden = !running;
      break;
    }
    case 'approval_request':
      setStatusText('Waiting for approval');
      addApprovalCard(ev, synthetic);
      break;
    case 'plan_proposed':
      setStatusText('Plan ready for review');
      addPlanCard(ev.plan, { synthetic });
      scrollToBottom(true);
      if (!running) showPlanReady();
      break;
    case 'changes_updated':
      changesPane.updated(Number(ev.count));
      break;
    case 'context':
      contextMeter.set(normalizeContext(ev.context));
      break;
    case 'compact_start':
      startCompaction(ev.reason === 'auto' ? 'auto' : 'manual');
      break;
    case 'compact_end':
      endCompaction();
      if (ev.compaction && typeof ev.compaction === 'object') {
        addCompaction(ev.compaction);
        // The checkpoints pointed into the folded messages
        clearTurns();
      } else if (ev.error) {
        compactErrorShown = true;
        addSystemMessage(String(ev.error), 'error');
      }
      break;
    case 'queue_delivered': {
      const msg = queueList.remove(ev.id);
      if (msg) {
        finishThinking();
        endAssistant();
        addUserMessage(msg.text ?? '', (Array.isArray(msg.attachments) ? msg.attachments : []).map(bubbleImage));
      }
      break;
    }
    case 'queue_dropped': {
      const msg = queueList.remove(ev.id);
      if (msg) returnToComposer([msg]);
      break;
    }
    case 'tasks_updated':
      showTasks(ev.tasks);
      break;
    case 'artifact':
      if (!ev.artifact?.id) break;
      addArtifactCard(ev.artifact, { updated: ev.action === 'updated' });
      // The main process has already shown the artifact in the browser view; bring the Browser tab forward.
      showPaneTab('browser');
      break;
    case 'error':
      addSystemMessage(ev.message, ev.kind === 'notice' ? 'notice' : 'error');
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|Could not reach|network/i.test(ev.message)) void checkConnection();
      break;
    case 'session_changed':
      onSessionChanged(ev.session);
      break;
    case 'run_end':
      finishThinking();
      endAssistant();
      pendingApproval?.cancel('Interrupted');
      // An auto-compaction belongs to the run; its compact_end (if one still comes) only adds the divider or error.
      if (compacting && !compacting.standalone) {
        compacting = null;
        statusLine.classList.remove('compacting');
      }
      setRunning(false);
      for (const card of toolCards.values()) {
        card.interrupt();
        updateGroup(card.el.closest('.tool-group'));
      }
      toolCards.clear();
      hiddenTools.clear();
      clearBrowsing();
      if (ev.reason === 'aborted') addSystemMessage('Interrupted.');
      if (ev.reason === 'max_turns') addSystemMessage('Stopped: reached the max tool turns limit (raise it in Settings).');
      if (ev.reason === 'plan') showPlanReady();
      {
        // Queued messages normally come back through queue_dropped before this; anything still listed goes back too.
        const left = queueList.clear();
        if (left.length) returnToComposer(left);
      }
      if (!dialogOpen() && !titleEditing && !isTextField(document.activeElement)) inputEl.focus();
      // The messages of this run now have checkpoints (a debug run_end renders only)
      if (!synthetic) void syncTurns();
      break;
  }
}
oc.onAgentEvent((ev) => handleEvent(ev));

// ---------- Composer ----------

// @ file mentions: the picker searches the working directory (oc.files.search, or the debug mock).
let debugFiles: FileHit[] | null = null;

function searchFiles(query: string, limit: number): Promise<FileHit[]> | null {
  if (debugFiles) return Promise.resolve(debugFiles.slice(0, limit));
  const api = oc.files;
  return api && typeof api.search === 'function' ? api.search(query, limit) : null;
}

const mentionPicker = createMentionPicker({
  input: inputEl,
  menu: mentionMenu,
  search: searchFiles,
  // Only one menu at a time above the composer.
  onOpen: () => hideSlashMenu(),
  onInsert: (hit) => pickedPaths.add(normalizeMention(hit.path)),
});

function autosize(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(240, Math.max(40, inputEl.scrollHeight))}px`;
  updateSendButton();
}

sendBtn.onclick = () => (running ? void oc.abort() : void send());
stopBtn.onclick = () => void oc.abort();
$('composer').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) {
    e.preventDefault();
    inputEl.focus();
  }
});
inputEl.addEventListener('input', () => {
  autosize();
  mentionPicker.sync();
  void updateSlashMenu();
  if (statusState === 'plan-wait') statusHint.hidden = composerHasContent();
});
inputEl.addEventListener('blur', () =>
  setTimeout(() => {
    hideSlashMenu();
    if (document.activeElement !== inputEl) mentionPicker.close();
  }, 150),
);
// The picker follows the caret within its token and closes once the caret leaves it.
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
inputEl.addEventListener('keyup', (e) => {
  if (CARET_KEYS.has(e.key)) mentionPicker.follow();
});
inputEl.addEventListener('click', () => mentionPicker.follow());
inputEl.addEventListener('keydown', (e) => {
  // ↑ ↓ ↵ Tab Esc go to the @ picker while it shows rows; otherwise Enter sends as usual.
  if (mentionPicker.handleKey(e)) return;
  if (!slashMenu.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      acceptSlashSelection();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideSlashMenu();
      return;
    }
  }
  if (e.key === '?' && composerEmpty() && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (e.key === 'Backspace' && !inputEl.value && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
    const items = tray.items();
    if (items.length) {
      e.preventDefault();
      tray.remove(items[items.length - 1].id);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
});

// ---------- Image attachments: paste, drop (below) and the paperclip ----------

/** Adds images to the composer; problems show next to the paperclip. */
async function attachImages(inputs: ImageInput[]): Promise<AddResult> {
  const res = await tray.add(inputs);
  if (res.errors.length) showInlineError(attachBtn, res.errors.length > 1 ? `${res.errors[0]} (+${res.errors.length - 1} more)` : res.errors[0]);
  return res;
}

/** Chrome names a raw clipboard bitmap "image.png"; files copied in Finder keep their own names. */
function pastedName(file: File): string {
  const name = file.name.trim();
  return !name || /^image\.(?:png|jpe?g|gif|webp)$/i.test(name) ? 'Pasted image' : name;
}

function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  let files = [...data.files];
  if (!files.length) {
    files = [...data.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.filter((f) => imageType(f) !== '');
}

inputEl.addEventListener('paste', (e) => {
  const images = clipboardImages(e.clipboardData);
  if (!images.length) return;
  e.preventDefault();
  void attachImages(images.map((f) => ({ blob: f, name: pastedName(f) })));
});

attachBtn.onclick = () => attachInput.click();
attachInput.addEventListener('change', () => {
  const files = [...(attachInput.files ?? [])];
  attachInput.value = '';
  if (files.length) void attachImages(files.map((f) => ({ blob: f, name: f.name || 'Image' })));
  inputEl.focus();
});

// The vision note: shown while images are attached and the configured model cannot see them.
const capsCache = new Map<string, ModelCapabilities>();
const capsInFlight = new Map<string, Promise<ModelCapabilities | null>>();
let visionCheck = 0;

function currentModel(): string {
  return config.provider === 'ollama' ? config.ollama.model : config.portkey.model;
}

function fetchCapabilities(key: string): Promise<ModelCapabilities | null> {
  let p = capsInFlight.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (typeof oc.modelCapabilities !== 'function') return null;
        const caps = await oc.modelCapabilities();
        if (!caps || typeof caps !== 'object') return null;
        // Filed under the model the answer is about (the config may have changed meanwhile).
        capsCache.set(caps.provider && caps.model ? `${caps.provider}|${caps.model}` : key, caps);
        return caps;
      } catch {
        return null; // not cached: asked again next time
      } finally {
        capsInFlight.delete(key);
      }
    })();
    capsInFlight.set(key, p);
  }
  return p;
}

async function refreshVisionNote(): Promise<void> {
  const my = ++visionCheck;
  if (!config || (!tray.items().length && !tray.pending())) {
    attachNote.hidden = true;
    return;
  }
  const key = `${config.provider}|${currentModel()}`;
  const caps = capsCache.get(key) ?? (await fetchCapabilities(key));
  if (my !== visionCheck) return;
  if (caps?.vision !== false || `${config.provider}|${currentModel()}` !== key) {
    attachNote.hidden = true;
    return;
  }
  const model = caps.model || currentModel() || 'This model';
  attachNote.innerHTML =
    `${icon('triangle-alert', 14)}<span>${escapeHtml(model)} can't see images. Switch to a vision model such as llava, qwen2.5vl or gemma3 in ` +
    `<button type="button" class="link-btn">Settings</button>.</span>`;
  attachNote.querySelector<HTMLButtonElement>('.link-btn')!.onclick = () => openSettings();
  attachNote.hidden = false;
}

// ---------- Image lightbox ----------

function openLightbox(src: string, name?: string, caption?: string): void {
  if (!src || dialogOpen()) return;
  closeMenu();
  lightboxImg.src = src;
  lightboxImg.alt = name || 'Attached image';
  lightboxCaption.textContent = caption || name || '';
  lightboxCaption.hidden = !lightboxCaption.textContent;
  oc.browser.setVisible(false);
  lightbox.showModal();
  lightbox.focus({ preventScroll: true });
}
$('lightbox-close').onclick = () => lightbox.close();
// A click anywhere but on the image closes it (the backdrop counts as the dialog itself).
lightbox.addEventListener('click', (e) => {
  if (e.target !== lightboxImg) lightbox.close();
});
lightbox.addEventListener('close', () => {
  lightboxImg.removeAttribute('src');
  syncBrowserView();
});

// ---------- Queue ----------

/** The queue floats above the status line; the transcript leaves room for it so the last message stays visible. */
function syncQueueHeight(): void {
  const h = queueEl.hidden ? 0 : Math.ceil(queueEl.getBoundingClientRect().height);
  transcriptWrap.style.setProperty('--queue-h', `${h}px`);
  if (stick) scrollToBottom();
}
new ResizeObserver(() => syncQueueHeight()).observe(queueEl);

/** The task card floats above the queue and the status line; the transcript leaves room for it too. */
function syncTaskHeight(): void {
  const h = taskListEl.hidden ? 0 : Math.ceil(taskListEl.getBoundingClientRect().height);
  transcriptWrap.style.setProperty('--tasks-h', `${h}px`);
  if (stick) scrollToBottom();
}
new ResizeObserver(() => syncTaskHeight()).observe(taskListEl);

function focusSearch(): void {
  if (shell.classList.contains('sidebar-collapsed')) toggleSidebar();
  sessionSearch.focus();
  sessionSearch.select();
}

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  // In a terminal, Esc and Ctrl combinations belong to the shell (xterm sends them on); ⌘ shortcuts still work.
  const inTerminal = terminalPane.hasFocus();
  if (inTerminal && (e.key === 'Escape' || (e.ctrlKey && !e.metaKey))) return;
  if (e.key === 'Escape' && (running || compacting?.standalone) && !pendingApproval && !isMenuOpen() && !dialogOpen()) {
    void oc.abort();
  } else if (e.key === 'Tab' && e.shiftKey && document.activeElement === inputEl) {
    e.preventDefault();
    void toggleMode();
  } else if (e.key === 'F2' && !meta) {
    e.preventDefault();
    startTitleEdit();
  } else if (!meta) {
    return;
  } else if (k === 'n' && !e.shiftKey) {
    e.preventDefault();
    void newSession();
  } else if (k === 'b' && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
  } else if (k === 'b' && e.shiftKey) {
    e.preventDefault();
    togglePane('browser');
  } else if (k === 'd' && e.shiftKey) {
    e.preventDefault();
    togglePane('diff');
  } else if (k === 't' && e.shiftKey) {
    e.preventDefault();
    toggleTerminal();
  } else if (k === 't') {
    e.preventDefault();
    openNewTerminal();
  } else if (e.key === ',') {
    e.preventDefault();
    openSettings();
  } else if (e.key === '/' || e.key === '?') {
    e.preventDefault();
    openShortcuts();
  } else if (k === 'k') {
    e.preventDefault();
    if (inTerminal) terminalPane.clearActive();
    else {
      closeMenu();
      inputEl.focus();
    }
  } else if (k === 'f' && !e.shiftKey) {
    e.preventDefault();
    focusSearch();
  }
});

function currentMode(): PermissionMode {
  return modeOf(config);
}

/** Posts the "Permission mode: …" notice when the mode differs from `before`. */
function announceMode(before: PermissionMode): void {
  const now = currentMode();
  if (now === before) return;
  if (now !== 'plan' && basePlaceholder === KEEP_PLACEHOLDER) setBasePlaceholder(DEFAULT_PLACEHOLDER);
  addSystemMessage(`Permission mode: ${MODES[now].label}. ${MODES[now].hint}.`, 'notice');
}

async function setMode(mode: PermissionMode): Promise<void> {
  const before = currentMode();
  try {
    config = await oc.setConfig({ ...config, permissionMode: mode, autoApprove: mode === 'bypass' });
  } catch (err) {
    showInlineError(modeBtn, `Couldn't change the mode: ${cleanError(err)}`);
    return;
  }
  applyConfigToUi();
  if (currentMode() !== mode) showInlineError(modeBtn, `${MODES[mode].label} needs the updated app. Restart OpenAgent and try again.`);
  if (currentMode() === 'bypass') pendingApproval?.allow();
  announceMode(before);
}

async function toggleMode(): Promise<void> {
  await setMode(nextMode(currentMode()));
}

modeBtn.onclick = () => {
  if (menuAnchoredTo(modeBtn)) return closeMenu();
  const mode = currentMode();
  const item = (m: PermissionMode): MenuItem => {
    const info = MODES[m];
    return {
      label: info.label,
      description: info.desc,
      icon: info.icon,
      tone: info.tone === 'neutral' ? undefined : info.tone,
      danger: m === 'bypass',
      checked: m === mode,
      onSelect: () => {
        inputEl.focus();
        if (m !== currentMode()) void setMode(m);
      },
    };
  };
  openMenu([{ label: 'Permission mode', items: MODE_CYCLE.map(item) }, { items: [item('bypass')] }], {
    anchor: modeBtn,
    placement: 'top-start',
    boundary: transcriptWrap,
    minWidth: 300,
    className: 'mode-menu',
    footer: '<kbd>⇧</kbd><kbd>Tab</kbd><span>cycles every mode except Bypass</span>',
  });
};

async function setModel(model: string): Promise<void> {
  config = await oc.setConfig({ ...config, ollama: { ...config.ollama, model } });
  applyConfigToUi();
  inputEl.focus();
  void refreshContext();
}

modelBtn.onclick = async () => {
  if (menuAnchoredTo(modelBtn)) return closeMenu();
  const settingsItem: MenuItem = { label: 'Settings…', icon: 'settings', hint: '⌘,', onSelect: openSettings };
  const opts = { anchor: modelBtn, placement: 'top-start' as const, boundary: transcriptWrap, minWidth: 260 };
  if (config.provider === 'portkey') {
    openMenu([{ label: 'Portkey', items: [{ label: config.portkey.model || 'No model set', checked: Boolean(config.portkey.model), disabled: !config.portkey.model }] }, { items: [settingsItem] }], opts);
    return;
  }
  const current = config.ollama.model;
  const section = (models: string[], note?: string): MenuSection => ({
    label: 'Ollama',
    items: models.map((m) => ({ label: m, checked: m === current, onSelect: () => void (m === current ? inputEl.focus() : setModel(m)) })),
    note,
  });
  const menu = openMenu([section(current ? [current] : [], 'Loading models…'), { items: [settingsItem] }], opts);
  try {
    const models = await oc.listOllamaModels();
    if (!menuAnchoredTo(modelBtn)) return;
    const list = !current || models.includes(current) ? models : [current, ...models];
    menu.update([section(list, models.length ? undefined : 'No local models. Try: ollama pull qwen3:8b'), { items: [settingsItem] }]);
  } catch {
    if (menuAnchoredTo(modelBtn)) menu.update([section(current ? [current] : [], 'Could not reach Ollama. Is it running? Start it with: ollama serve'), { items: [settingsItem] }]);
  }
};

// ---------- Header / config ----------

/** "~/Documents/openagent"; long paths keep the root and the last two folders: "~/…/audit/playground". */
function shortPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+/, '~');
  if (home.length <= 40) return home;
  const parts = home.split('/');
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : home;
}

function applyConfigToUi(): void {
  const model = config.provider === 'ollama' ? config.ollama.model : config.portkey.model;
  modelBtn.innerHTML = `<span class="chip-label">${escapeHtml(model || 'Choose a model')}</span><span class="chev">${icon('chevron-down', 14)}</span>`;
  modelBtn.dataset.tip = config.provider === 'ollama' ? `Ollama · ${config.ollama.baseURL}` : `Portkey · ${config.portkey.baseURL}`;
  const mode = currentMode();
  const info = MODES[mode];
  modeBtn.innerHTML = `${icon(info.icon)}<span class="chip-label">${escapeHtml(info.label)}</span><span class="chev">${icon('chevron-down', 14)}</span>`;
  modeBtn.dataset.tip = info.desc;
  modeBtn.dataset.mode = mode;
  modeBtn.setAttribute('aria-label', `Permission mode: ${info.label}`);
  for (const c of MODE_CHIP_CLASSES) modeBtn.classList.toggle(c, c === info.chipClass);
  cwdLabel.textContent = shortPath(config.workingDirectory);
  cwdBtn.dataset.tip = `${config.workingDirectory} · click to change`;
  setToolCwd(config.workingDirectory);
  setDiffBaseDir(config.workingDirectory);
  document.documentElement.dataset.theme = config.theme === 'system' ? '' : config.theme;
  const connKey = `${config.provider}|${config.ollama.baseURL}|${config.ollama.model}`;
  if (connKey !== lastConnKey) {
    lastConnKey = connKey;
    void checkConnection();
  }
  void refreshVisionNote();
}

// ---------- Provider connection banner ----------

const connBanner = $('conn-banner');
const connText = $('conn-text');
let lastConnKey = '';
let connCheck = 0;

/** Shows a banner when Ollama is unreachable or the configured model is not downloaded; silent otherwise. */
async function checkConnection(): Promise<void> {
  const my = ++connCheck;
  if (config.provider !== 'ollama') {
    connBanner.hidden = true;
    return;
  }
  try {
    const models = await oc.listOllamaModels();
    if (my !== connCheck) return;
    const m = config.ollama.model;
    const have = (x: string) => x === m || x === `${m}:latest` || m === `${x}:latest`;
    if (m && models.length && !models.some(have)) {
      connText.textContent = `Ollama is running, but ${m} is not downloaded. Run: ollama pull ${m}`;
      connBanner.hidden = false;
    } else connBanner.hidden = true;
  } catch {
    if (my !== connCheck) return;
    connText.textContent = `Can't reach Ollama at ${config.ollama.baseURL.replace(/\/v1\/?$/, '')}. Start it with "ollama serve", then retry.`;
    connBanner.hidden = false;
  }
}
$('conn-retry').onclick = () => void checkConnection();
$('conn-settings').onclick = () => openSettings();

cwdBtn.onclick = async () => {
  const dir = await oc.chooseDirectory();
  if (dir) {
    config = await oc.getConfig();
    applyConfigToUi();
    addSystemMessage(`Working directory set to ${dir}`, 'notice');
  }
};

/** Keeps the native browser view glued to its slot while something animates the layout. */
function trackBounds(ms: number): void {
  const end = performance.now() + ms;
  const step = () => {
    reportBounds();
    if (performance.now() < end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toggleSidebar(): void {
  shell.classList.toggle('sidebar-collapsed');
  try {
    localStorage.setItem('sidebar', shell.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
  } catch {
    /* ignore */
  }
  trackBounds(260);
}
$('sidebar-toggle').onclick = toggleSidebar;


// Inline title editing (click or F2; Enter saves, Escape cancels)
let titleEditing = false;

function setTitle(text: string): void {
  if (!titleEditing) sessionTitle.textContent = text;
  document.title = text && text !== 'New session' ? `${text} — OpenAgent` : 'OpenAgent';
}

async function renameSession(id: string, title: string, anchor: HTMLElement): Promise<boolean> {
  try {
    if (typeof oc.sessions.rename !== 'function') throw new Error('No handler registered');
    const meta = await oc.sessions.rename(id, title);
    const i = sessions.findIndex((s) => s.id === id);
    if (i >= 0) sessions[i] = meta;
    if (id === currentSessionId) setTitle(meta.title);
    renderSessionList();
    return true;
  } catch (err) {
    showInlineError(anchor, `Couldn't rename: ${cleanError(err)}`);
    return false;
  }
}

function startTitleEdit(): void {
  if (titleEditing || !currentSessionId) return;
  titleEditing = true;
  const original = sessionTitle.textContent ?? '';
  sessionTitle.contentEditable = 'plaintext-only';
  sessionTitle.classList.add('editing');
  sessionTitle.focus();
  const range = document.createRange();
  range.selectNodeContents(sessionTitle);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const finish = async (save: boolean) => {
    if (!titleEditing) return;
    titleEditing = false;
    sessionTitle.removeEventListener('keydown', onKey);
    sessionTitle.removeEventListener('blur', onBlur);
    sessionTitle.contentEditable = 'false';
    sessionTitle.classList.remove('editing');
    sessionTitle.scrollLeft = 0;
    const next = (sessionTitle.textContent ?? '').replace(/\s+/g, ' ').trim();
    sessionTitle.textContent = original;
    if (!save || !next || next === original) return;
    sessionTitle.textContent = next;
    const ok = await renameSession(currentSessionId, next, sessionTitle);
    if (!ok) sessionTitle.textContent = original;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void finish(true);
      inputEl.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
      inputEl.focus();
    }
  };
  const onBlur = () => void finish(true);
  sessionTitle.addEventListener('keydown', onKey);
  sessionTitle.addEventListener('blur', onBlur);
}
sessionTitle.addEventListener('click', () => startTitleEdit());
sessionTitle.addEventListener('keydown', (e) => {
  if (!titleEditing && e.key === 'Enter') {
    e.preventDefault();
    startTitleEdit();
  }
});

// ---------- Sessions ----------

function groupLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - 86_400_000) return 'Yesterday';
  if (ts >= startOfToday - 6 * 86_400_000) return 'Previous 7 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Re-reads the session list and the current session; returns the current session's meta. */
async function refreshSessions(): Promise<SessionMeta | null> {
  const [list, current] = await Promise.all([oc.sessions.list(), oc.sessions.current()]);
  if (!current) return null;
  currentSessionId = current.id;
  sessions = list.some((m) => m.id === current.id) ? list : [current, ...list];
  setTitle(current.title);
  renderSessionList();
  applySessionPlan(current);
  return current;
}

/** The session's newest plan may have been decided in the main process (e.g. by a build run): update its card. */
function applySessionPlan(meta: SessionMeta): void {
  if (meta.id !== currentSessionId || !meta.plan?.id) return;
  planCards.get(meta.plan.id)?.update(meta.plan);
  syncPlanStatus();
}

function onSessionChanged(meta: SessionMeta): void {
  const i = sessions.findIndex((s) => s.id === meta.id);
  if (i >= 0) sessions[i] = { ...sessions[i], ...meta };
  if (meta.id === currentSessionId) setTitle(meta.title);
  renderSessionList();
  applySessionPlan(meta);
  void refreshSessions();
}

// Inline rename in the sidebar survives list re-renders (e.g. the switch triggered by the first click of a double-click).
let rowRename: { id: string; value: string; fresh: boolean } | null = null;

function mountRowRename(row: HTMLElement): void {
  if (!rowRename) return;
  const state = rowRename;
  const label = row.querySelector('.label');
  if (!label) return;
  row.classList.add('renaming');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = state.value;
  input.setAttribute('aria-label', 'Session title');
  input.spellcheck = false;
  label.replaceWith(input);
  row.querySelector('.trail')?.setAttribute('hidden', '');
  input.focus();
  if (state.fresh) input.select();
  state.fresh = false;
  const done = async (save: boolean) => {
    if (rowRename !== state) return;
    rowRename = null;
    const next = input.value.replace(/\s+/g, ' ').trim();
    const before = sessions.find((s) => s.id === state.id)?.title ?? '';
    renderSessionList();
    if (save && next && next !== before) {
      const fresh = sessionList.querySelector<HTMLElement>(`.session-item[data-id="${CSS.escape(state.id)}"]`);
      await renameSession(state.id, next, fresh ?? sessionList);
    }
  };
  input.addEventListener('input', () => (state.value = input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void done(false);
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (input.isConnected) void done(true);
    }, 0),
  );
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

function startRowRename(id: string): void {
  const meta = sessions.find((s) => s.id === id);
  if (!meta) return;
  rowRename = { id, value: meta.title, fresh: true };
  renderSessionList();
}

function openSessionMenu(m: SessionMeta, anchor: HTMLElement | { x: number; y: number }, row: HTMLElement): void {
  row.classList.add('menu-open');
  openMenu(
    [
      {
        items: [
          { label: 'Rename', icon: 'pencil', hint: 'F2', onSelect: () => startRowRename(m.id) },
          { label: 'Fork', icon: 'git-branch', disabled: running, onSelect: () => void forkSession(m.id) },
        ],
      },
      { items: [{ label: 'Delete', icon: 'trash', danger: true, disabled: running, onSelect: () => void deleteSession(m.id) }] },
    ],
    { anchor, placement: 'bottom-start', minWidth: 200, onClose: () => row.classList.remove('menu-open') },
  );
}

function renderSessionList(): void {
  const q = sessionSearch.value.trim().toLowerCase();
  sessionList.innerHTML = '';
  let lastGroup = '';
  let shown = 0;
  for (const m of sessions) {
    if (q && !m.title.toLowerCase().includes(q)) continue;
    shown++;
    const group = groupLabel(m.updatedAt);
    if (group !== lastGroup) {
      const g = document.createElement('div');
      g.className = 'session-group';
      g.textContent = group;
      sessionList.appendChild(g);
      lastGroup = group;
    }
    const isRunning = running && m.id === runningSessionId;
    const row = document.createElement('div');
    row.className = 'session-item' + (m.id === currentSessionId ? ' active' : '') + (isRunning ? ' running' : '');
    row.dataset.id = m.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (m.id === currentSessionId) row.setAttribute('aria-current', 'true');
    const meta = isRunning
      ? '<span class="trail-meta"><span class="spinner sm" aria-label="Running"></span></span>'
      : m.forkedFrom
        ? `<span class="trail-meta fork-mark" data-tip="Forked session">${icon('git-branch', 14)}</span>`
        : '';
    row.innerHTML =
      `<span class="label">${escapeHtml(m.title)}</span>` +
      `<span class="trail">${meta}<button type="button" class="icon-btn sm row-more" aria-label="Session actions" aria-haspopup="menu" data-tip="More">${icon('more')}</button></span>`;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.row-more, .rename-input')) return;
      void switchSession(m.id);
    });
    row.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.row-more, .rename-input')) return;
      e.preventDefault();
      startRowRename(m.id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void switchSession(m.id);
      } else if (e.key === 'F2') {
        e.preventDefault();
        e.stopPropagation();
        startRowRename(m.id);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...sessionList.querySelectorAll<HTMLElement>('.session-item')];
        rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSessionMenu(m, { x: e.clientX, y: e.clientY }, row);
    });
    const more = row.querySelector<HTMLButtonElement>('.row-more')!;
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuAnchoredTo(more)) return closeMenu();
      openSessionMenu(m, more, row);
    });
    sessionList.appendChild(row);
    if (rowRename?.id === m.id) mountRowRename(row);
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = q ? 'No sessions match.' : 'Sessions you start appear here.';
    sessionList.appendChild(empty);
  }
}
sessionSearch.addEventListener('input', renderSessionList);
sessionSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (sessionSearch.value) {
      sessionSearch.value = '';
      renderSessionList();
    } else inputEl.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    sessionList.querySelector<HTMLElement>('.session-item')?.focus();
  }
});

async function switchSession(id: string): Promise<void> {
  if (id === currentSessionId) return;
  if (running) {
    addSystemMessage('Stop the current run before switching sessions.', 'error');
    return;
  }
  try {
    const epoch = tasksEpoch;
    const items = await oc.sessions.switch(id);
    renderTranscript(items);
    showSessionTasks(await refreshSessions(), epoch);
    changesPane.reset();
    scrollToBottom(true);
    void refreshContext();
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
}

async function newSession(): Promise<void> {
  if (running) return;
  const epoch = tasksEpoch;
  await oc.sessions.create();
  clearMessages();
  showSessionTasks(await refreshSessions(), epoch);
  changesPane.reset();
  void refreshContext();
  inputEl.focus();
}
newSessionBtn.onclick = () => void newSession();

async function deleteSession(id: string): Promise<void> {
  if (running) return;
  const meta = id === currentSessionId ? await oc.sessions.current() : sessions.find((s) => s.id === id);
  if (meta?.messageCount && !window.confirm(`Delete "${meta.title}"? This cannot be undone.`)) return;
  try {
    const wasCurrent = id === currentSessionId;
    const epoch = tasksEpoch;
    await oc.sessions.delete(id);
    if (wasCurrent) clearMessages();
    const current = await refreshSessions();
    if (wasCurrent) showSessionTasks(current, epoch);
    if (wasCurrent) changesPane.reset();
    if (wasCurrent) void refreshContext();
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
}

async function forkSession(id: string): Promise<void> {
  if (running) return;
  try {
    const source = sessions.find((s) => s.id === id);
    const wasCurrent = id === currentSessionId;
    const epoch = tasksEpoch;
    const fork = await oc.sessions.fork(id);
    if (!wasCurrent) renderTranscript(await oc.sessions.switch(fork.id));
    showSessionTasks(await refreshSessions(), epoch);
    // The fork keeps its own checkpoints (if any): the bubbles on screen follow it
    if (wasCurrent) void syncTurns();
    changesPane.reset();
    void refreshContext();
    addSystemMessage(`Forked "${source?.title ?? 'session'}". You are now in the fork; the original is unchanged.`, 'notice');
  } catch (err) {
    addSystemMessage(cleanError(err), 'error');
  }
}


// ---------- Slash menu (skills) ----------

const BUILTINS: SkillInfo[] = [
  { name: 'skills', description: 'List available skills', path: '', source: 'bundled' },
  { name: 'compact', description: 'Summarise the conversation to free context', path: '', source: 'bundled' },
  { name: 'mcp', description: 'Show MCP servers and their tools', path: '', source: 'bundled' },
];
let slashItems: SkillInfo[] = [];
let slashIndex = 0;

function hideSlashMenu(): void {
  slashMenu.hidden = true;
  slashMenu.innerHTML = '';
  slashItems = [];
}

async function updateSlashMenu(): Promise<void> {
  const value = inputEl.value;
  const m = /^\/([\w-]*)$/.exec(value);
  if (!m) return hideSlashMenu();
  const prefix = m[1].toLowerCase();
  const skills = (await oc.skills.list()).filter((sk) => sk.name.toLowerCase().startsWith(prefix));
  if (inputEl.value !== value) return;
  const commands = BUILTINS.filter((sk) => sk.name.startsWith(prefix));
  slashItems = [...skills, ...commands];
  if (!slashItems.length) return hideSlashMenu();
  slashIndex = 0;
  slashMenu.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.className = 'slash-scroll';
  const section = (label: string, list: SkillInfo[], offset: number, builtin: boolean) => {
    if (!list.length) return;
    scroll.insertAdjacentHTML('beforeend', `<div class="slash-label">${label}</div>`);
    list.forEach((sk, k) => {
      const i = offset + k;
      const row = document.createElement('div');
      row.className = 'slash-item' + (i === slashIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.innerHTML = `<span class="name">/${escapeHtml(sk.name)}</span><span class="desc">${escapeHtml(sk.description)}</span><span class="src">${builtin ? 'command' : escapeHtml(sk.source)}</span>`;
      row.onmousedown = (e) => {
        e.preventDefault();
        slashIndex = i;
        acceptSlashSelection();
      };
      row.onmousemove = () => {
        if (slashIndex !== i) {
          slashIndex = i;
          highlightSlash();
        }
      };
      scroll.appendChild(row);
    });
  };
  section('Skills', skills, 0, false);
  section('Commands', commands, skills.length, true);
  slashMenu.appendChild(scroll);
  slashMenu.insertAdjacentHTML('beforeend', '<div class="slash-foot"><span><kbd>↵</kbd><kbd>tab</kbd> insert</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>');
  mentionPicker.close();
  slashMenu.hidden = false;
}

function highlightSlash(): void {
  slashMenu.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('active', i === slashIndex));
  slashMenu.querySelectorAll('.slash-item')[slashIndex]?.scrollIntoView({ block: 'nearest' });
}

function moveSlashSelection(delta: number): void {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  highlightSlash();
}

function acceptSlashSelection(): void {
  const sk = slashItems[slashIndex];
  if (!sk) return;
  inputEl.value = `/${sk.name} `;
  hideSlashMenu();
  autosize();
  inputEl.focus();
}

// ---------- Side pane: Browser, Diff and Terminal tabs ----------

type PaneTab = 'browser' | 'diff' | 'terminal';
let paneVisible = true;
let paneTab: PaneTab = 'browser';
const PANE_TABS: readonly (readonly [PaneTab, HTMLButtonElement])[] = [
  ['browser', paneTabBrowser],
  ['diff', paneTabDiff],
  ['terminal', paneTabTerminal],
];

function browserShown(): boolean {
  return paneVisible && paneTab === 'browser';
}

function reportBounds(): void {
  if (shell.classList.contains('browser-hidden')) return;
  const r = browserView.getBoundingClientRect();
  oc.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportBounds).observe(browserView);

/** The native browser view floats above the page: it is shown only while its tab is on screen and no dialog is open. */
function syncBrowserView(): void {
  if (browserShown() && !dialogOpen()) {
    reportBounds();
    oc.browser.setVisible(true);
    requestAnimationFrame(reportBounds);
  } else oc.browser.setVisible(false);
}

function applyPane(persist = true): void {
  const showBrowser = browserShown();
  const showDiff = paneVisible && paneTab === 'diff';
  const showTerminal = paneVisible && paneTab === 'terminal';
  if (!showBrowser) oc.browser.setVisible(false);
  // Focus would be lost with a hidden terminal: hand it back to the composer.
  if (!showTerminal && terminalPaneEl.contains(document.activeElement)) inputEl.focus();
  shell.classList.toggle('pane-hidden', !paneVisible);
  shell.classList.toggle('browser-hidden', !showBrowser);
  browserPane.hidden = paneTab !== 'browser';
  diffPane.hidden = paneTab !== 'diff';
  terminalPaneEl.hidden = paneTab !== 'terminal';
  for (const [tab, el] of PANE_TABS) {
    el.classList.toggle('active', paneTab === tab);
    el.setAttribute('aria-selected', String(paneTab === tab));
    el.tabIndex = paneTab === tab ? 0 : -1;
  }
  browserToggle.classList.toggle('active', showBrowser);
  browserToggle.setAttribute('aria-pressed', String(showBrowser));
  diffToggle.classList.toggle('active', showDiff);
  diffToggle.setAttribute('aria-pressed', String(showDiff));
  terminalToggle.classList.toggle('active', showTerminal);
  terminalToggle.setAttribute('aria-pressed', String(showTerminal));
  changesPane.setVisible(showDiff);
  terminalPane.setVisible(showTerminal);
  if (showBrowser) syncBrowserView();
  if (persist) {
    try {
      localStorage.setItem('pane', paneVisible ? 'shown' : 'hidden');
      localStorage.setItem('paneTab', paneTab);
    } catch {
      /* ignore */
    }
  }
}

/** The top-bar toggles: show the pane on that tab, or hide it when that tab is already showing. */
function togglePane(tab: PaneTab): void {
  if (paneVisible && paneTab === tab) paneVisible = false;
  else {
    paneVisible = true;
    paneTab = tab;
  }
  applyPane();
}

function showPaneTab(tab: PaneTab): void {
  if (paneVisible && paneTab === tab) return;
  paneVisible = true;
  paneTab = tab;
  applyPane();
}

browserToggle.onclick = () => togglePane('browser');
diffToggle.onclick = () => togglePane('diff');
terminalToggle.onclick = () => toggleTerminal();
paneTabBrowser.onclick = () => showPaneTab('browser');
paneTabDiff.onclick = () => showPaneTab('diff');
paneTabTerminal.onclick = () => showPaneTab('terminal');
$('pane-close').onclick = () => {
  paneVisible = false;
  applyPane();
};
// ←/→ move between the pane tabs, wrapping around.
for (const [, tabEl] of PANE_TABS) {
  tabEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = PANE_TABS.findIndex(([tab]) => tab === paneTab);
    const [next, nextEl] = PANE_TABS[(at + (e.key === 'ArrowRight' ? 1 : -1) + PANE_TABS.length) % PANE_TABS.length];
    showPaneTab(next);
    nextEl.focus();
  });
}

// Diff tab
let debugChanges: ChangesApi | null = null;

function changesSource(): ChangesApi | null {
  if (debugChanges) return debugChanges;
  const api = oc.changes;
  return api && typeof api.list === 'function' && typeof api.diff === 'function' ? api : null;
}

function setChangeCount(n: number): void {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  for (const badge of diffCountBadges) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  const files = `${count} changed file${count === 1 ? '' : 's'}`;
  diffToggle.dataset.tip = count ? `Toggle diff · ${files}` : 'Toggle diff';
  paneTabDiff.setAttribute('aria-label', count ? `Diff, ${files}` : 'Diff');
}

/** A small in-app confirmation (the native browser view is hidden while it is open). */
function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (confirmDialog.open) return Promise.resolve(false);
  closeMenu();
  $('confirm-title').textContent = opts.title;
  const desc = $('confirm-desc');
  desc.textContent = opts.description ?? '';
  desc.hidden = !opts.description;
  const ok = $<HTMLButtonElement>('confirm-ok');
  const cancel = $<HTMLButtonElement>('confirm-cancel');
  ok.textContent = opts.confirmLabel;
  ok.className = `btn ${opts.danger ? 'danger' : 'primary'}`;
  oc.browser.setVisible(false);
  confirmDialog.showModal();
  cancel.focus();
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      ok.onclick = null;
      cancel.onclick = null;
      confirmDialog.removeEventListener('close', onClose);
      if (confirmDialog.open) confirmDialog.close();
      resolve(value);
    };
    const onClose = () => finish(false);
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    confirmDialog.addEventListener('close', onClose);
  });
}
confirmDialog.addEventListener('close', syncBrowserView);
confirmDialog.addEventListener('click', (e) => {
  if (e.target === confirmDialog) confirmDialog.close();
});

const changesPane = createChangesPane({
  root: diffPane,
  list: $('change-list'),
  detail: $('change-detail'),
  empty: $('changes-empty'),
  source: changesSource,
  onCount: setChangeCount,
  onError: showInlineError,
  confirm: confirmAction,
  cleanError,
  onReverted: (entry) => forgetFile(entry.path),
});

// Terminal tab
let debugTerminal: MockTerminalSource | null = null;

function terminalSource(): TerminalApi | null {
  if (debugTerminal) return debugTerminal;
  const api = oc.terminal;
  return api && typeof api.list === 'function' && typeof api.create === 'function' && typeof api.onData === 'function' && typeof api.onTabs === 'function' ? api : null;
}

function setTerminalBusy(n: number): void {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  for (const dot of terminalBusyDots) dot.hidden = count === 0;
  terminalToggle.dataset.tip = count ? `Toggle terminal · ${count} running` : 'Toggle terminal';
  paneTabTerminal.setAttribute('aria-label', count ? `Terminal, ${count} running` : 'Terminal');
}

/** A link clicked in a terminal opens in the Browser pane. */
function openTerminalLink(url: string): void {
  showPaneTab('browser');
  void oc.browser.navigate(url).catch((err: unknown) => showInlineError(paneTabBrowser, `Couldn't open the link: ${cleanError(err)}`));
}

const terminalPane = createTerminalPane({
  root: terminalPaneEl,
  strip: $('terminal-tabs'),
  newButton: $<HTMLButtonElement>('terminal-new'),
  host: $('terminal-host'),
  empty: $('terminal-empty'),
  source: terminalSource,
  onBusy: setTerminalBusy,
  onOpenUrl: openTerminalLink,
  onError: showInlineError,
  cleanError,
});

/** ⌘⇧T and the top-bar toggle: show the terminal with the cursor in it, or hide it. */
function toggleTerminal(): void {
  togglePane('terminal');
  if (paneVisible && paneTab === 'terminal') terminalPane.focus();
}

/** ⌘T: a new shell tab (the Terminal pane is shown first). */
function openNewTerminal(): void {
  showPaneTab('terminal');
  void terminalPane.newTab();
}

const BROWSER_MIN = 360;
const TRANSCRIPT_MIN = 320;
function clampBrowserWidth(px: number): number {
  return Math.round(Math.max(BROWSER_MIN, Math.min(px, contentEl.clientWidth - TRANSCRIPT_MIN - resizer.offsetWidth)));
}
function setBrowserWidth(px: number | null): void {
  if (px === null) sidePane.style.removeProperty('--browser-w');
  else sidePane.style.setProperty('--browser-w', `${clampBrowserWidth(px)}px`);
}
window.addEventListener('resize', () => {
  const stored = sidePane.style.getPropertyValue('--browser-w');
  if (stored) setBrowserWidth(parseFloat(stored));
  reportBounds();
});

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');
  const startX = e.clientX;
  const startW = sidePane.getBoundingClientRect().width;
  const move = (ev: PointerEvent) => {
    setBrowserWidth(startW + (startX - ev.clientX));
    reportBounds();
  };
  const up = (ev: PointerEvent) => {
    if (resizer.hasPointerCapture(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId);
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('pointerup', up);
    resizer.removeEventListener('pointercancel', up);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    reportBounds();
    try {
      localStorage.setItem('browserWidth', String(Math.round(sidePane.getBoundingClientRect().width)));
    } catch {
      /* ignore */
    }
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
  resizer.addEventListener('pointercancel', up);
});
resizer.addEventListener('dblclick', () => {
  setBrowserWidth(null);
  try {
    localStorage.removeItem('browserWidth');
  } catch {
    /* ignore */
  }
  requestAnimationFrame(reportBounds);
});

function applyBrowserState(s: BrowserState): void {
  const blank = !s.url || s.url === 'about:blank';
  if (document.activeElement !== urlEl) urlEl.value = blank ? '' : s.url;
  browserTitle.textContent = s.title && s.title !== s.url ? s.title : s.loading && !blank ? 'Loading…' : '';
  backBtn.disabled = !s.canGoBack;
  fwdBtn.disabled = !s.canGoForward;
  openExternalBtn.disabled = blank;
  browserPane.classList.toggle('loading', s.loading);
  if (placeholder) placeholder.hidden = !blank;
}
oc.browser.onState(applyBrowserState);
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void oc.browser.navigate(urlEl.value);
    urlEl.blur();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    urlEl.blur();
    void oc.browser.state().then(applyBrowserState);
  }
});
urlEl.addEventListener('focus', () => urlEl.select());
document.querySelector('.url-pill')!.addEventListener('mousedown', (e) => {
  if (e.target !== urlEl) {
    e.preventDefault();
    urlEl.focus();
  }
});
backBtn.onclick = () => void oc.browser.back();
fwdBtn.onclick = () => void oc.browser.forward();
reloadBtn.onclick = () => void oc.browser.reload();
openExternalBtn.onclick = async () => {
  try {
    if (typeof oc.browser.openExternal !== 'function') throw new Error('No handler registered');
    await oc.browser.openExternal();
  } catch (err) {
    showInlineError(openExternalBtn, `Couldn't open the page: ${cleanError(err)}`);
  }
};

// ---------- Settings ----------

const field = <T extends HTMLElement = HTMLInputElement>(id: string) => $<T>(id);
let showOtherProvider = false;
let settingsScroll = 0;

function selectedProvider(): AppConfig['provider'] {
  return (settingsForm.querySelector<HTMLInputElement>('input[name=provider]:checked')?.value ?? 'ollama') as AppConfig['provider'];
}

function fillSettings(): void {
  settingsForm.querySelectorAll<HTMLInputElement>('input[name=provider]').forEach((r) => (r.checked = r.value === config.provider));
  field('ollama-baseURL').value = config.ollama.baseURL;
  field('ollama-model').value = config.ollama.model;
  field('ollama-numCtx').value = String(config.ollama.numCtx || 16384);
  field<HTMLSelectElement>('ollama-think').value = config.ollama.think || 'auto';
  field('portkey-baseURL').value = config.portkey.baseURL;
  field('portkey-apiKey').value = config.portkey.apiKey;
  field('portkey-model').value = config.portkey.model;
  field('portkey-contextWindow').value = String(config.portkey.contextWindow || 128000);
  field('portkey-virtualKey').value = config.portkey.virtualKey;
  field('portkey-provider').value = config.portkey.provider;
  field('portkey-providerApiKey').value = config.portkey.providerApiKey;
  field('portkey-configId').value = config.portkey.configId;
  field('maxTurns').value = String(config.maxTurns);
  field<HTMLSelectElement>('theme').value = config.theme || 'system';
  field('sendScreenshots').checked = config.sendScreenshotsToModel;
  field('autoTitles').checked = config.autoTitles !== false;
  field('autoCompact').checked = config.autoCompact !== false;
  field('notifications').checked = config.notifications !== false;
  field<HTMLTextAreaElement>('systemPromptExtra').value = config.systemPromptExtra;
  mcpPanel.resetMessages();
  rulesPanel.resetMessages();
  settingsStatus.textContent = '';
  settingsStatus.classList.remove('error');
  showOtherProvider = false;
  toggleProviderFields();
}

function toggleProviderFields(): void {
  const provider = selectedProvider();
  const otherName = provider === 'ollama' ? 'Portkey' : 'Ollama';
  $('ollama-fields').hidden = provider !== 'ollama' && !showOtherProvider;
  $('portkey-fields').hidden = provider !== 'portkey' && !showOtherProvider;
  $('other-provider-text').textContent = showOtherProvider ? `${otherName} settings are shown so you can fill them in ahead of time.` : `${otherName} settings are hidden.`;
  $('show-other-provider').textContent = showOtherProvider ? 'Hide' : 'Show';
}
settingsForm.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', toggleProviderFields));
$('show-other-provider').onclick = () => {
  showOtherProvider = !showOtherProvider;
  toggleProviderFields();
};

/** The form's values over the loaded config (mcpServers, mcpTrusted and allowRules belong to the main process and pass through as loaded). */
function readSettings(): AppConfig {
  return {
    ...config,
    provider: selectedProvider(),
    ollama: {
      ...config.ollama,
      baseURL: field('ollama-baseURL').value.trim() || 'http://localhost:11434/v1',
      model: field('ollama-model').value.trim(),
      numCtx: Math.max(2048, Number(field('ollama-numCtx').value) || 16384),
      think: (field<HTMLSelectElement>('ollama-think').value as 'auto' | 'on' | 'off') || 'auto',
    },
    portkey: {
      ...config.portkey,
      baseURL: field('portkey-baseURL').value.trim() || 'https://api.portkey.ai/v1',
      apiKey: field('portkey-apiKey').value.trim(),
      model: field('portkey-model').value.trim(),
      virtualKey: field('portkey-virtualKey').value.trim(),
      provider: field('portkey-provider').value.trim(),
      providerApiKey: field('portkey-providerApiKey').value.trim(),
      configId: field('portkey-configId').value.trim(),
      contextWindow: Math.max(1024, Math.round(Number(field('portkey-contextWindow').value) || 128000)),
    },
    maxTurns: Math.max(1, Number(field('maxTurns').value) || 40),
    theme: (field<HTMLSelectElement>('theme').value as AppConfig['theme']) || 'system',
    sendScreenshotsToModel: field('sendScreenshots').checked,
    autoTitles: field('autoTitles').checked,
    autoCompact: field('autoCompact').checked,
    notifications: field('notifications').checked,
    systemPromptExtra: field<HTMLTextAreaElement>('systemPromptExtra').value,
  };
}

async function refreshModels(): Promise<void> {
  const list = $<HTMLDataListElement>('ollama-models');
  const hint = $('ollama-hint');
  try {
    config = { ...config, ollama: { ...config.ollama, baseURL: field('ollama-baseURL').value.trim() || config.ollama.baseURL } };
    await oc.setConfig(config);
    const models = await oc.listOllamaModels();
    list.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
    hint.textContent = models.length ? `${models.length} local model${models.length === 1 ? '' : 's'}: ${models.join(', ')}` : 'Ollama is running but has no models. Try: ollama pull qwen3:8b';
  } catch (err) {
    hint.textContent = `Could not reach Ollama (${cleanError(err)}). Is it running? Start it with: ollama serve`;
  }
}
$('refresh-models').onclick = () => void refreshModels();

/** Scrolls the open dialog so the section (or the field holding the element) is at the top. */
function scrollSettingsTo(id: string): void {
  const el = document.getElementById(id);
  if (!el || !settingsBody.contains(el)) return;
  const target = el.matches('.set-section') ? el : el.closest<HTMLElement>('.field, .switch-row') ?? el;
  // Layout offsets (#settings-body is the offset parent), not client rects: the dialog is still scaling in.
  let top = 0;
  for (let n: HTMLElement | null = target; n && n !== settingsBody; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
  settingsBody.scrollTop = top - (target.matches('.set-section') ? 0 : 16);
  settingsScroll = settingsBody.scrollTop;
}

/** Opens Settings where it was last scrolled, or at `scrollTo` (an element id, e.g. "mcp-section"). */
function openSettings(scrollTo?: string): void {
  const target = typeof scrollTo === 'string' ? scrollTo : '';
  if (settingsDialog.open) {
    if (target) scrollSettingsTo(target);
    return;
  }
  if (confirmDialog.open) return;
  closeMenu();
  if (shortcutsDialog.open) shortcutsDialog.close();
  fillSettings();
  oc.browser.setVisible(false);
  settingsDialog.showModal();
  settingsDialog.focus({ preventScroll: true });
  settingsBody.scrollTop = settingsScroll;
  if (target) scrollSettingsTo(target);
  void refreshModels();
  void mcpPanel.refresh();
  void rulesPanel.refresh();
}
/** Closes the dialog, remembering where it was scrolled (a closed dialog no longer has a scroll position). */
function closeSettings(): void {
  settingsScroll = settingsBody.scrollTop;
  settingsDialog.close();
}
$('settings-btn').onclick = () => openSettings();
$('settings-cancel').onclick = closeSettings;
$('settings-close').onclick = closeSettings;
settingsBody.addEventListener('scroll', () => (settingsScroll = settingsBody.scrollTop), { passive: true });
settingsDialog.addEventListener('cancel', () => (settingsScroll = settingsBody.scrollTop));
settingsDialog.addEventListener('close', syncBrowserView);
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // MCP and rule changes made while the dialog was open went straight to the main process: pass its current lists through.
    await syncOwnedConfig();
    config = await oc.setConfig(readSettings());
    applyConfigToUi();
    closeSettings();
    void refreshContext();
  } catch (err) {
    settingsStatus.textContent = `Could not save: ${cleanError(err)}`;
    settingsStatus.classList.add('error');
  }
});

// ---------- MCP servers (Settings section and /mcp) ----------

let debugMcp: MockMcpSource | null = null;
let mcpUnsubscribe: (() => void) | null = null;

function mcpSource(): McpApi | null {
  if (debugMcp) return debugMcp;
  const api = oc.mcp;
  return api && typeof api.list === 'function' ? api : null;
}

/**
 * mcpServers, mcpTrusted and allowRules are managed by the main process: keep this window's copy current so saving
 * Settings (or any other setConfig) passes them through unchanged.
 */
async function syncOwnedConfig(): Promise<void> {
  try {
    const latest = await oc.getConfig();
    if (latest && typeof latest === 'object') {
      config = {
        ...config,
        mcpServers: latest.mcpServers ?? config.mcpServers,
        mcpTrusted: latest.mcpTrusted ?? config.mcpTrusted,
        allowRules: latest.allowRules ?? config.allowRules,
      };
    }
  } catch {
    /* the next full read catches up */
  }
}

const mcpPanel = createMcpPanel({
  els: {
    list: $('mcp-list'),
    status: $('mcp-status'),
    name: $<HTMLInputElement>('mcp-name'),
    nameLabel: $('mcp-name-label'),
    spec: $<HTMLTextAreaElement>('mcp-spec'),
    env: $<HTMLTextAreaElement>('mcp-env'),
    scope: $<HTMLSelectElement>('mcp-scope'),
    add: $<HTMLButtonElement>('mcp-add-btn'),
    error: $('mcp-add-error'),
  },
  source: mcpSource,
  confirm: confirmAction,
  cleanError,
  onMutated: () => void syncOwnedConfig(),
  projectDir: () => config?.workingDirectory ?? '',
});

/** Follows the list the source pushes whenever a server's status or tools change (oc.mcp, or the debug mock). */
function subscribeMcp(): void {
  mcpUnsubscribe?.();
  mcpUnsubscribe = null;
  const api = mcpSource();
  if (!api || typeof api.onServers !== 'function') return;
  try {
    const off = api.onServers((list) => {
      mcpPanel.render(list);
      if (!debugMcp) void syncOwnedConfig();
    });
    mcpUnsubscribe = typeof off === 'function' ? off : null;
  } catch {
    /* an older app without the event */
  }
}

/** /mcp: the servers with their status and tool names (or how to add one), and a way into Settings. */
async function addMcpCard(): Promise<void> {
  const api = mcpSource();
  let servers: McpServerInfo[] = mcpPanel.servers();
  let note: string | undefined;
  if (!api) note = 'MCP servers need the updated app. Restart OpenAgent and try again.';
  else {
    try {
      servers = await api.list();
      mcpPanel.render(servers);
    } catch (err) {
      note = `Couldn't load the servers: ${cleanError(err)}`;
    }
  }
  const el = document.createElement('div');
  el.className = 'msg system notice card mcp-card';
  el.innerHTML = `${mcpCardHtml(servers, note)}<div class="mcp-card-foot"><button type="button" class="link-btn mcp-manage">Manage in Settings…</button></div>`;
  el.querySelector<HTMLButtonElement>('.mcp-manage')!.onclick = () => openSettings('mcp-section');
  addNode(el);
}

// ---------- Permissions: "Always allow … for this project" rules (Settings section) ----------

let debugRules: RulesApi | null = null;

function rulesSource(): RulesApi | null {
  if (debugRules) return debugRules;
  const api = oc.rules;
  return api && typeof api.list === 'function' ? api : null;
}

const rulesSection = $('rules-section');
const rulesPanel = createRulesPanel({
  els: {
    cwd: $('rules-cwd'),
    list: $('rules-list'),
    programs: $('rules-programs'),
    reasons: $('rules-reasons'),
    mcp: $('rules-mcp'),
    edits: $('rules-edits'),
    empty: rulesSection.querySelector<HTMLElement>('.rules-empty')!,
    status: $('rules-status'),
  },
  source: rulesSource,
  cleanError,
  onMutated: () => {
    if (!debugRules) void syncOwnedConfig();
  },
  projectDir: () => config?.workingDirectory ?? '',
});

// ---------- Shortcuts sheet ----------

const SHORTCUTS: [string, string[]][] = [
  ['New session', ['⌘', 'N']],
  ['Toggle sidebar', ['⌘', 'B']],
  ['Toggle browser', ['⌘', '⇧', 'B']],
  ['Toggle diff', ['⌘', '⇧', 'D']],
  ['Toggle terminal', ['⌘', '⇧', 'T']],
  ['New terminal tab', ['⌘', 'T']],
  ['Settings', ['⌘', ',']],
  ['Cycle permission mode', ['⇧', 'Tab']],
  ['Stop the run', ['Esc']],
  ['Focus the composer', ['⌘', 'K']],
  ['Clear the terminal (in a terminal)', ['⌘', 'K']],
  ['Search sessions', ['⌘', 'F']],
  ['Rename session', ['F2']],
  ['New line in the composer', ['⇧', '↵']],
  ['Mention a file', ['@']],
  ['Keyboard shortcuts', ['⌘', '/']],
];
$('shortcut-list').innerHTML = SHORTCUTS.map(([label, keys]) => `<dt>${escapeHtml(label)}</dt><dd>${keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</dd>`).join('');

function openShortcuts(): void {
  if (dialogOpen()) return;
  closeMenu();
  oc.browser.setVisible(false);
  shortcutsDialog.showModal();
  shortcutsDialog.focus({ preventScroll: true });
}
$('shortcuts-btn').onclick = openShortcuts;
$('shortcuts-close').onclick = () => shortcutsDialog.close();
shortcutsDialog.addEventListener('click', (e) => {
  if (e.target === shortcutsDialog) shortcutsDialog.close();
});
shortcutsDialog.addEventListener('close', () => {
  syncBrowserView();
  inputEl.focus();
});

// ---------- Debug hook (renders into the UI only; nothing reaches the main process) ----------

window.__oc_debug = {
  user(text: string, images?: string[], mentions?: string[], turn?: number) {
    addUserMessage(text, Array.isArray(images) ? images.map((src) => ({ src })) : [], Array.isArray(mentions) ? mentions : null, {
      turn: typeof turn === 'number' ? turn : undefined,
    });
  },
  tasks(tasks: TaskItem[] | null) {
    showTasks(Array.isArray(tasks) ? tasks : []);
  },
  renderMarkdown(md: string) {
    endAssistant();
    appendAssistantText(md);
    endAssistant();
  },
  emit(ev: AgentEvent) {
    handleEvent(ev, true);
  },
  mockChanges(list: ChangeEntry[] | null, diffs: Record<string, Partial<ChangeDiff>> = {}) {
    debugChanges = list ? mockChangesSource(list, diffs) : null;
    changesPane.reset();
  },
  terminal: {
    screen: (id?: string) => terminalPane.screenText(id),
    tabs: () => terminalPane.tabs(),
    mock(on: boolean) {
      debugTerminal?.dispose();
      debugTerminal = on ? mockTerminalSource(config?.workingDirectory || undefined) : null;
      terminalPane.reset();
    },
    input: (text: string, id?: string) => terminalPane.input(text, id),
  },
  async attach(dataUrl: string, name?: string): Promise<ImageAttachment> {
    let blob: Blob;
    try {
      blob = dataUrlToBlob(String(dataUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showInlineError(attachBtn, message);
      throw new Error(message);
    }
    const res = await attachImages([{ blob, name: name || 'Pasted image' }]);
    if (!res.added.length) throw new Error(res.errors[0] ?? 'The image was not attached.');
    return res.added[0];
  },
  attachments: () => tray.items(),
  queue: () => queueList.items(),
  mcp: {
    mock(servers: McpServerInfo[] | null) {
      debugMcp?.dispose();
      debugMcp = Array.isArray(servers) ? mockMcpSource(servers) : null;
      subscribeMcp();
      void mcpPanel.refresh();
    },
  },
  context(info: ContextInfo | null) {
    contextMeter.set(info ? normalizeContext(info) : null);
  },
  files: {
    mock(hits: FileHit[] | null) {
      debugFiles = Array.isArray(hits) ? hits.slice() : null;
      // A token already at the caret is searched again from the new source.
      mentionPicker.close();
      if (document.activeElement === inputEl) mentionPicker.sync();
    },
  },
  rules: {
    mock(rules: ProjectRules | null) {
      debugRules = rules && typeof rules === 'object' ? mockRulesSource(rules, config?.workingDirectory ?? '') : null;
      void rulesPanel.refresh();
    },
  },
};

// ---------- Init ----------

subscribeMcp();
void mcpPanel.refresh();

(async () => {
  config = await oc.getConfig();
  applyConfigToUi();
  try {
    if (localStorage.getItem('sidebar') === 'collapsed') shell.classList.add('sidebar-collapsed');
    // 'browser' is the key older builds used for the pane's visibility
    const pane = localStorage.getItem('pane') ?? localStorage.getItem('browser');
    paneVisible = pane !== 'hidden';
    const savedTab = localStorage.getItem('paneTab');
    paneTab = savedTab === 'diff' || savedTab === 'terminal' ? savedTab : 'browser';
    const w = Number(localStorage.getItem('browserWidth'));
    if (w > 0) setBrowserWidth(w);
  } catch {
    /* ignore */
  }
  applyPane(false);
  const epoch = tasksEpoch;
  showSessionTasks(await refreshSessions(), epoch);
  void changesPane.refresh();
  // After a reload the main process still holds the current session; show its transcript again.
  try {
    const current = await oc.sessions.current();
    if (current?.messageCount) renderTranscript(await oc.sessions.switch(current.id));
  } catch {
    /* a run is in progress; the transcript stays empty until the next switch */
  }
  // Messages queued before a reload are still waiting (the run may still be going).
  try {
    if (typeof oc.queue === 'function') for (const m of await oc.queue()) queueList.add(m);
  } catch {
    /* an older app without a queue */
  }
  void refreshContext();
  reportBounds();
  autosize();
  applyBrowserState(await oc.browser.state());
  inputEl.focus();
})();

// ---------- Drop files: images are attached, other files insert their paths ----------

const composerEl = $('composer');
function insertAtCursor(text: string): void {
  mentionPicker.close();
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? start;
  const before = inputEl.value.slice(0, start);
  const sep = before && !/\s$/.test(before) ? ' ' : '';
  inputEl.value = before + sep + text + inputEl.value.slice(end);
  const pos = (before + sep + text).length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  autosize();
  updateSendButton();
}
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  composerEl.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) composerEl.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  composerEl.classList.remove('dragging');
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  const images = [...files].filter((f) => imageType(f) !== '');
  if (images.length) {
    void attachImages(images.map((f) => ({ blob: f, name: f.name || 'Image' })));
    if (!dialogOpen()) inputEl.focus();
  }
  const paths = [...files]
    .filter((f) => imageType(f) === '')
    .map((f) => {
      try {
        return oc.pathForFile(f);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p));
  if (paths.length) insertAtCursor(paths.join(' ') + ' ');
});

// ---------- Empty-state suggestions ----------

const SUGGESTIONS = [
  'Explain what this project does and how it is organised',
  'Find the failing tests, fix them, and run the suite again',
  'Open https://example.com in the browser and summarise the page',
];
const suggestionsEl = $('empty-suggestions');
suggestionsEl.innerHTML = SUGGESTIONS.map((s) => `<button type="button" class="suggestion">${escapeHtml(s)}</button>`).join('');
suggestionsEl.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((b, i) => {
  b.onclick = () => {
    mentionPicker.close();
    inputEl.value = SUGGESTIONS[i];
    autosize();
    updateSendButton();
    inputEl.focus();
  };
});

export {};
