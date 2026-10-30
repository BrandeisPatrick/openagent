// Composer extras: the "#" memory shortcut (a message starting with "#" goes to the project's instructions file
// instead of the model), which file each project's "#" lines went to, ⌘↑/⌘↓ history over the messages sent in the
// session, and the detector behind Esc Esc (rewind).

// ---------- "#": add to the project's instructions ----------

/** "# always run npm test" → "always run npm test"; null when the message does not start with "#" or has nothing after it. */
export function memoryText(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t.startsWith('#')) return null;
  const rest = t.slice(1).trim();
  return rest || null;
}

/** The text as the main process writes it into the file: runs of whitespace (newlines too) become one space. */
export function oneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** The file "#" lines go to until the main process has named another (it creates OPENAGENT.md when a project has none) */
export const DEFAULT_INSTRUCTIONS_FILE = 'OPENAGENT.md';
const LABELS_KEY = 'instructionsFiles';
const MAX_PROJECTS = 50;

export interface InstructionFiles {
  /** The label oc.instructions.append last returned for this working directory, else OPENAGENT.md */
  get(cwd: string): string;
  /** Remembered per working directory (in localStorage) */
  set(cwd: string, label: string): void;
}

const validLabel = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;

export function createInstructionFiles(): InstructionFiles {
  const map = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [cwd, label] of Object.entries(raw as Record<string, unknown>)) if (cwd && validLabel(label)) map.set(cwd, label.trim());
    }
  } catch {
    /* nothing remembered */
  }
  return {
    get: (cwd: string) => map.get(cwd) ?? DEFAULT_INSTRUCTIONS_FILE,
    set(cwd: string, label: string) {
      if (!cwd || !validLabel(label)) return;
      // Most recent last; the oldest projects are forgotten first.
      map.delete(cwd);
      map.set(cwd, label.trim());
      while (map.size > MAX_PROJECTS) map.delete(map.keys().next().value as string);
      try {
        localStorage.setItem(LABELS_KEY, JSON.stringify(Object.fromEntries(map)));
      } catch {
        /* kept for this window only */
      }
    },
  };
}

// ---------- ⌘↑ / ⌘↓: the messages sent in this session ----------

export interface ComposerHistoryOptions {
  /** #input */
  input: HTMLTextAreaElement;
  /** The messages sent in the session, oldest first (the text of the user bubbles on screen) */
  entries: () => string[];
  /** The composer's text was replaced: resize it, close its menus */
  onRecall: () => void;
}

export interface ComposerHistory {
  /** ⌘↑ / ⌘↓ on the composer; true when the key was used (it then prevented the caret move) */
  handleKey(e: KeyboardEvent): boolean;
  /** Forgets the walk (the session changed); the composer keeps whatever it shows */
  reset(): void;
}

/**
 * ⌘↑ on the composer's first line (or in an empty composer) shows the previous message sent in the session, newest
 * first; ⌘↓ on the last line walks back towards the newest and then to the draft that was there before. Elsewhere
 * the keys keep moving the caret. Editing a recalled message ends the walk: the edited text is the new draft.
 */
export function createComposerHistory(o: ComposerHistoryOptions): ComposerHistory {
  let walk: { list: string[]; index: number; draft: string; shown: string } | null = null;

  /** Newest first, without empty messages and without a message repeated right after itself */
  const collect = (): string[] => {
    const all = o.entries();
    const out: string[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const t = String(all[i] ?? '').replace(/\r\n?/g, '\n');
      if (!t.trim() || out[out.length - 1] === t) continue;
      out.push(t);
    }
    return out;
  };

  const show = (text: string) => {
    const input = o.input;
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    o.onRecall();
    input.scrollTop = input.scrollHeight;
  };

  return {
    handleKey(e: KeyboardEvent): boolean {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return false;
      const input = o.input;
      const value = input.value;
      // Typed into (or replaced) since it was recalled: not walking any more.
      if (walk && value !== walk.shown) walk = null;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? value.length;
      if (e.key === 'ArrowUp') {
        if (value.slice(0, start).includes('\n')) return false;
        const list = walk?.list ?? collect();
        const next = walk ? walk.index + 1 : 0;
        if (next >= list.length) {
          if (!walk) return false;
          // Already at the oldest message.
          e.preventDefault();
          return true;
        }
        e.preventDefault();
        walk = { list, index: next, draft: walk?.draft ?? value, shown: list[next] };
        show(list[next]);
        return true;
      }
      if (!walk || value.slice(end).includes('\n')) return false;
      e.preventDefault();
      const next = walk.index - 1;
      if (next < 0) {
        const draft = walk.draft;
        walk = null;
        show(draft);
      } else {
        walk = { ...walk, index: next, shown: walk.list[next] };
        show(walk.list[next]);
      }
      return true;
    },
    reset() {
      walk = null;
    },
  };
}

// ---------- Esc Esc ----------

/**
 * Two presses of a key within a window, where only presses nothing else used count: every press is seen first
 * (capture phase), and the handler that would act on it says it counts. An Esc that closed a menu in between, or any
 * other key, breaks the pair.
 */
export interface DoublePress {
  /** Every press, before any handler (at: its timestamp in ms) */
  saw(at: number): void;
  /** The press just seen reached the handler and counts; true when the press before it counted too, within the window */
  counts(): boolean;
  /** Another key: the next press starts over */
  reset(): void;
}

export function createDoublePress(windowMs = 600): DoublePress {
  let prev: { at: number; counted: boolean } | null = null;
  let cur: { at: number; counted: boolean } | null = null;
  return {
    saw(at: number) {
      prev = cur;
      cur = { at, counted: false };
    },
    counts() {
      if (!cur) return false;
      cur.counted = true;
      if (prev?.counted && cur.at - prev.at <= windowMs) {
        // A third press starts a new pair.
        cur.counted = false;
        prev = null;
        return true;
      }
      return false;
    },
    reset() {
      prev = null;
      cur = null;
    },
  };
}
