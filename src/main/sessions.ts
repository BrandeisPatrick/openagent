import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { CompactionInfo, PlanInfo, SessionMeta, TaskItem, TranscriptItem, ArtifactInfo } from '../shared/types';
import type { Snapshot } from './changes';
import { isCompactPreamble } from './compact';
import { FILE_BLOCK_RE, mentionedPaths } from './mentions';

export type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  forkedFrom?: string;
  /** Set once the user renamed the session or a title was generated; save() then stops deriving one. */
  titleLocked?: boolean;
  messages: Msg[];
  /** Plans proposed in plan mode, by id */
  plans?: Record<string, PlanInfo>;
  /** Artifacts the model created with create_artifact (see artifacts.ts) */
  artifacts?: Record<string, ArtifactInfo>;
  /** Files the agent changed: content before the first change (see changes.ts) */
  changes?: Record<string, Snapshot>;
  /** Compactions in order; each keeps the messages it folded so the transcript can still show them */
  compactions?: StoredCompaction[];
  /** Size of the last request the model saw (prompt + reply), and the message index it covered; drives the context meter */
  lastPrompt?: { tokens: number; at: number };
  /** One checkpoint per user message of the live conversation, for rewinding (see rewindSession) */
  turns?: Turn[];
  /** The agent's task list (update_tasks) */
  tasks?: TaskItem[];
}

/** A checkpoint: where a user message sits in `messages` and what files looked like when the agent first touched them after it. */
export interface Turn {
  /** Index of the user message in Session.messages */
  at: number;
  createdAt: number;
  /** What the user typed (without inlined skill or file blocks), for the composer */
  text: string;
  /** Absolute path → content before the first write or edit in this turn; null when the file did not exist */
  files: Record<string, string | null>;
  /** Files the turn changed but could not snapshot (too large or not text) */
  skipped?: string[];
  /** The agent's task list when the turn started (restored by a rewind) */
  tasks?: TaskItem[];
}

const SNAPSHOT_LIMIT = 2 * 1024 * 1024;

/** Records a file's content on the turn before the agent's first change to it in that turn. */
export function turnSnapshot(turn: Turn, absPath: string): void {
  const key = path.resolve(absPath);
  if (key in turn.files || turn.skipped?.includes(key)) return;
  let buf: Buffer;
  try {
    const st = fs.statSync(key);
    if (!st.isFile() || st.size > SNAPSHOT_LIMIT) {
      (turn.skipped ??= []).push(key);
      return;
    }
    buf = fs.readFileSync(key);
  } catch {
    turn.files[key] = null; // the agent is about to create it
    return;
  }
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) {
    (turn.skipped ??= []).push(key);
    return;
  }
  turn.files[key] = buf.toString('utf8');
}

export interface RewindOutcome {
  text: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Puts the session back to the checkpoint `turnIndex`: files the agent wrote or edited from then on go back to their
 * content at that point (a file that did not exist is removed), and the messages from that user message on are dropped.
 * Returns the message's text so it can be edited and sent again. Paths in the result are relative to `cwd`.
 */
export function rewindSession(s: Session, cwd: string, turnIndex: number): RewindOutcome {
  const turns = s.turns ?? [];
  const turn = turns[turnIndex];
  if (!turn || turn.at > s.messages.length) throw new Error('That message can no longer be rewound to.');
  // The content to restore is what the earliest affected turn saw: nothing changed it between that point and the checkpoint.
  const target = new Map<string, string | null>();
  const skipped = new Set<string>();
  for (let i = turnIndex; i < turns.length; i++) {
    for (const [abs, content] of Object.entries(turns[i].files)) if (!target.has(abs)) target.set(abs, content);
    for (const abs of turns[i].skipped ?? []) if (!target.has(abs)) skipped.add(abs);
  }
  const rel = (abs: string) => path.relative(cwd, abs) || abs;
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [abs, content] of target) {
    try {
      if (content === null) {
        fs.rmSync(abs, { force: true });
        deleted.push(rel(abs));
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        restored.push(rel(abs));
      }
    } catch (err) {
      console.warn('[rewind] could not restore', abs, err);
      skipped.add(abs);
    }
  }
  s.messages.splice(turn.at);
  s.turns = turns.slice(0, turnIndex);
  s.tasks = turn.tasks?.length ? structuredClone(turn.tasks) : undefined;
  if (s.lastPrompt && s.lastPrompt.at > s.messages.length) delete s.lastPrompt;
  return { text: turn.text, restored: restored.sort(), deleted: deleted.sort(), skipped: [...skipped].map(rel).sort() };
}

export interface StoredCompaction extends CompactionInfo {
  folded: Msg[];
}

/** The public part of a stored compaction (without the folded messages). */
export function compactionInfo(c: StoredCompaction): CompactionInfo {
  const { folded: _folded, ...info } = c;
  return info;
}

/** The most recently proposed plan of a session, if any. */
export function latestPlan(s: Session): PlanInfo | undefined {
  let best: PlanInfo | undefined;
  for (const p of Object.values(s.plans ?? {})) if (!best || p.createdAt > best.createdAt) best = p;
  return best;
}

const NEW_TITLE = 'New session';
const MAX_TITLE = 80;

/** First `max` characters of s, without splitting a surrogate pair (emoji). */
export function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

const SKILL_BLOCK = /\n*<skill name="[^"]*">[\s\S]*?<\/skill>\s*$/;

/** Strips the inlined skill body and @-mentioned file blocks from a user message so the transcript shows what the user typed. */
export function displayText(content: unknown): string {
  const strip = (s: string) => s.replace(SKILL_BLOCK, '').replace(FILE_BLOCK_RE, '');
  if (typeof content === 'string') return strip(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? strip(String((part as { text: string }).text)) : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** The raw text of a user message (string content, or its text parts). */
function rawText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: string }).text) : '')).join('\n');
  return '';
}

/** Data URLs of the images in a user message's content parts. */
export function imageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const url = part && typeof part === 'object' && 'image_url' in part ? (part as { image_url?: { url?: string } }).image_url?.url : undefined;
    if (typeof url === 'string' && url.startsWith('data:image/')) out.push(url);
  }
  return out;
}

export function toMeta(s: Session): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    forkedFrom: s.forkedFrom,
    messageCount: s.messages.length,
    titleLocked: s.titleLocked === true,
    plan: latestPlan(s),
    changedFiles: Object.keys(s.changes ?? {}).length,
    artifacts: Object.keys(s.artifacts ?? {}).length,
    compactions: s.compactions?.length ?? 0,
    tasks: s.tasks?.length ? s.tasks.map((t) => ({ ...t })) : undefined,
  };
}

/** The whole conversation for the renderer: folded messages, a divider per compaction, then the live messages. */
export function toTranscript(s: Session): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const c of s.compactions ?? []) {
    appendTranscript(s, c.folded, items);
    items.push({ role: 'compaction', compaction: compactionInfo(c) });
  }
  // Only the live messages have checkpoints; folded ones cannot be rewound to.
  const turnByAt = new Map<number, number>();
  (s.turns ?? []).forEach((t, i) => turnByAt.set(t.at, i));
  appendTranscript(s, s.messages, items, turnByAt);
  return items;
}

function appendTranscript(s: Session, messages: Msg[], items: TranscriptItem[], turnByAt?: Map<number, number>): void {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, typeof m.content === 'string' ? m.content : String(m.content));
  messages.forEach((m, index) => {
    if (m.role === 'user') {
      if (isCompactPreamble(m)) return;
      const text = displayText(m.content);
      if (text.startsWith('[Screenshot returned by') || text.startsWith('You returned an empty response.')) return;
      const images = imageUrls(m.content);
      const mentions = mentionedPaths(rawText(m.content));
      const item: Extract<TranscriptItem, { role: 'user' }> = { role: 'user', text };
      if (images.length) item.images = images;
      if (mentions.length) item.mentions = mentions;
      const turn = turnByAt?.get(index);
      if (turn !== undefined) item.turn = turn;
      items.push(item);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) items.push({ role: 'assistant', text });
      for (const call of m.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        const result = results.get(call.id) ?? '(no result)';
        const ok = !/^(Error:|User denied|Not permitted|Tool call was interrupted)/.test(result);
        if (call.function.name === 'submit_plan') {
          const plan = planForCall(s, call.function.arguments);
          if (plan) {
            items.push({ role: 'plan', plan });
            continue;
          }
        }
        if (call.function.name === 'create_artifact' && ok) {
          const id = /\bid: ([\w-]+)/.exec(result)?.[1];
          const artifact = id ? s.artifacts?.[id] : undefined;
          if (artifact) {
            items.push({ role: 'artifact', artifact });
            continue;
          }
        }
        items.push({ role: 'tool', name: call.function.name, args: call.function.arguments, result, ok });
      }
    }
  });
}

/** The stored plan that a submit_plan call produced (matched by title and body), or a synthetic proposed one. */
function planForCall(s: Session, rawArgs: string): PlanInfo | null {
  let args: { title?: unknown; markdown?: unknown } = {};
  try {
    args = JSON.parse(rawArgs) as typeof args;
  } catch {
    return null;
  }
  const markdown = typeof args.markdown === 'string' ? args.markdown.trim() : '';
  if (!markdown) return null;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Plan';
  const stored = Object.values(s.plans ?? {}).find((p) => p.markdown === markdown && p.title === clip(title, MAX_TITLE));
  return stored ?? { id: '', title, markdown, status: 'proposed', createdAt: s.updatedAt };
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
        if (s && s.id && Array.isArray(s.messages)) this.sessions.set(s.id, s);
      } catch (err) {
        console.warn(`[sessions] could not read ${file}:`, err);
      }
    }
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].filter((s) => s.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt).map(toMeta);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** New empty session. It is only written to disk once it has messages. */
  create(): Session {
    const now = Date.now();
    const s: Session = { id: randomUUID(), title: NEW_TITLE, createdAt: now, updatedAt: now, messages: [] };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Copy of a session, including its full history, that continues independently. */
  fork(id: string): Session {
    const src = this.sessions.get(id);
    if (!src) throw new Error(`No session ${id}`);
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      title: src.title === NEW_TITLE ? NEW_TITLE : `${src.title} (fork)`,
      createdAt: now,
      updatedAt: now,
      forkedFrom: src.id,
      titleLocked: src.titleLocked,
      messages: structuredClone(src.messages),
      plans: src.plans ? structuredClone(src.plans) : undefined,
      changes: src.changes ? structuredClone(src.changes) : undefined,
      compactions: src.compactions ? structuredClone(src.compactions) : undefined,
      lastPrompt: src.lastPrompt ? { ...src.lastPrompt } : undefined,
      turns: src.turns ? structuredClone(src.turns) : undefined,
      tasks: src.tasks ? structuredClone(src.tasks) : undefined,
    };
    this.sessions.set(s.id, s);
    if (s.messages.length) this.save(s);
    return s;
  }

  delete(id: string): void {
    this.sessions.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  /**
   * Sets a user-chosen title and locks it so neither save() nor title generation replaces it.
   * Mutates the stored Session object, which is the same object the agent holds for the current session.
   */
  rename(id: string, title: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No session ${id}`);
    const clean = clip(String(title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE).trim();
    if (!clean) throw new Error('A session title cannot be empty.');
    s.title = clean;
    s.titleLocked = true;
    this.save(s, false);
    return s;
  }

  /** Writes the session to disk. `touch` bumps updatedAt (the sidebar's sort key); renames pass false. */
  save(s: Session, touch = true): void {
    if (touch) s.updatedAt = Date.now();
    if (!s.titleLocked && s.title === NEW_TITLE) {
      const first = (s.compactions?.[0]?.folded ?? s.messages).find((m) => m.role === 'user' && !isCompactPreamble(m));
      if (first) {
        const text = displayText(first.content).replace(/\s+/g, ' ').trim();
        if (text) s.title = text.length > 48 ? text.slice(0, 47) + '…' : text;
      }
    }
    if (!s.messages.length) return;
    fs.writeFileSync(path.join(this.dir, `${s.id}.json`), JSON.stringify(s));
  }
}
