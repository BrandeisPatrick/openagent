// The agent's task list (the update_tasks tool, tasks_updated events, SessionMeta.tasks): a checklist card pinned
// above the status line and the queue. Rows are keyed by task id and updated in place, so a status change only
// touches its own row; the header shows "2 of 5 done" and collapses the card (remembered in localStorage).
// Also: the same rows as a static snapshot, for update_tasks rows in the transcript.

import type { TaskItem } from '../shared/types';
import { icon } from './icons.js';

type Status = TaskItem['status'];

const STATUSES = new Set<Status>(['pending', 'in_progress', 'completed']);
const STATUS_LABEL: Record<Status, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };
const COLLAPSED_KEY = 'tasksCollapsed';

/** A well-formed list from whatever arrived: items need a title, ids are made unique, unknown statuses count as pending. */
export function cleanTasks(list: unknown): TaskItem[] {
  if (!Array.isArray(list)) return [];
  const out: TaskItem[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const t = raw as Record<string, unknown>;
    const title = typeof t.title === 'string' ? t.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return;
    let id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id).trim() : '';
    if (!id) id = `t${i + 1}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    out.push({ id, title, status: STATUSES.has(t.status as Status) ? (t.status as Status) : 'pending' });
  });
  return out;
}

/** "2 of 5 done" */
export function taskProgress(tasks: TaskItem[]): string {
  return `${tasks.filter((t) => t.status === 'completed').length} of ${tasks.length} done`;
}

/**
 * The status glyph: an empty circle, a filled arrow (the spinner takes its place while a run is in progress; see
 * .task-list.live in styles.css), or a circle with a tick.
 */
export function taskGlyph(status: Status): string {
  if (status === 'completed') return icon('circle-check', 14);
  if (status === 'in_progress') return `<span class="spinner sm" aria-hidden="true"></span>${icon('arrow-filled', 14)}`;
  return icon('circle', 14);
}

function fillRow(el: HTMLElement, t: TaskItem): void {
  if (el.dataset.status !== t.status) {
    el.dataset.status = t.status;
    el.querySelector('.task-glyph')!.innerHTML = taskGlyph(t.status);
  }
  const title = el.querySelector<HTMLElement>('.task-title')!;
  if (title.textContent !== t.title) {
    title.textContent = t.title;
    title.title = t.title;
  }
  el.setAttribute('aria-label', `${STATUS_LABEL[t.status]}: ${t.title}`);
}

function createRow(t: TaskItem): HTMLLIElement {
  const el = document.createElement('li');
  el.className = 'task-row';
  el.dataset.id = t.id;
  el.innerHTML = '<span class="task-glyph" aria-hidden="true"></span><span class="task-title"></span>';
  fillRow(el, t);
  return el;
}

/** The rows as they stood at one update_tasks call (for that call's row in the transcript). */
export function taskSnapshot(tasks: TaskItem[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'task-rows task-snapshot';
  for (const t of tasks) list.appendChild(createRow(t));
  if (!tasks.length) list.innerHTML = '<li class="task-row task-empty">The task list was cleared.</li>';
  return list;
}

export interface TaskListOptions {
  /** #task-list */
  root: HTMLElement;
  /** The card was shown, hidden, collapsed, expanded or got other rows (its height may have changed) */
  onChange?: () => void;
}

export interface TaskList {
  /** Shows the list; an empty list (or null) hides the card. Rows are reused by id, so nothing else re-renders. */
  set(tasks: TaskItem[] | null): void;
  /** A run is in progress: the in-progress row shows the spinner instead of the arrow */
  setRunning(running: boolean): void;
  /** The header's chevron; remembered in localStorage */
  setCollapsed(collapsed: boolean): void;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function createTaskList(o: TaskListOptions): TaskList {
  const root = o.root;
  root.innerHTML =
    `<div class="task-card">` +
    `<button type="button" class="task-head" aria-controls="task-rows">` +
    `<span class="task-head-icon" aria-hidden="true">${icon('list-checks', 14)}</span><span class="task-head-title">Tasks</span>` +
    `<span class="task-head-current"></span><span class="task-head-count"></span>` +
    `<span class="task-head-chev" aria-hidden="true">${icon('chevron-down', 14)}</span></button>` +
    `<ol id="task-rows" class="task-rows" aria-label="Tasks"></ol></div>`;
  const head = root.querySelector<HTMLButtonElement>('.task-head')!;
  const current = root.querySelector<HTMLElement>('.task-head-current')!;
  const count = root.querySelector<HTMLElement>('.task-head-count')!;
  const rowsEl = root.querySelector<HTMLElement>('.task-rows')!;
  const rows = new Map<string, HTMLLIElement>();
  let items: TaskItem[] = [];
  let collapsed = readCollapsed();
  let activeId = '';

  /** In a list long enough to scroll, the task in progress is brought in view with two rows of context above it (what comes next shows below). */
  const reveal = (row: HTMLElement | undefined) => {
    if (!row || collapsed || rowsEl.scrollHeight <= rowsEl.clientHeight) return;
    const max = rowsEl.scrollHeight - rowsEl.clientHeight;
    rowsEl.scrollTop = Math.max(0, Math.min(max, row.offsetTop - 2 * row.offsetHeight - 4));
  };

  const renderHead = () => {
    const active = items.find((t) => t.status === 'in_progress');
    count.textContent = taskProgress(items);
    current.textContent = active?.title ?? '';
    current.title = active?.title ?? '';
    root.classList.toggle('collapsed', collapsed);
    root.classList.toggle('all-done', items.length > 0 && items.every((t) => t.status === 'completed'));
    head.setAttribute('aria-expanded', String(!collapsed));
    head.setAttribute('aria-label', `Tasks, ${taskProgress(items)}${collapsed && active ? `, now: ${active.title}` : ''}. ${collapsed ? 'Show' : 'Hide'} the list`);
    rowsEl.hidden = collapsed;
  };

  const list: TaskList = {
    set(next: TaskItem[] | null) {
      const wasShown = !root.hidden;
      items = cleanTasks(next);
      root.hidden = items.length === 0;
      // Rows that are gone go; the rest are updated where they are and moved only when the order changed.
      const ids = new Set(items.map((t) => t.id));
      for (const [id, el] of rows) {
        if (ids.has(id)) continue;
        el.remove();
        rows.delete(id);
      }
      let prev: HTMLElement | null = null;
      for (const t of items) {
        let el = rows.get(t.id);
        if (el) fillRow(el, t);
        else {
          el = createRow(t);
          // New rows of a list already on screen fade in (once: a row moved later must not replay it); a list that
          // just appeared comes in as one card.
          if (wasShown) {
            const row = el;
            row.classList.add('fade-in');
            row.addEventListener('animationend', () => row.classList.remove('fade-in'), { once: true });
          }
          rows.set(t.id, el);
        }
        const want: Element | null = prev ? prev.nextElementSibling : rowsEl.firstElementChild;
        if (want !== el) rowsEl.insertBefore(el, want);
        prev = el;
      }
      renderHead();
      const active = items.find((t) => t.status === 'in_progress');
      if (active && active.id !== activeId) requestAnimationFrame(() => reveal(rows.get(active.id)));
      activeId = active?.id ?? '';
      o.onChange?.();
    },
    setRunning(running: boolean) {
      root.classList.toggle('live', running);
    },
    setCollapsed(v: boolean) {
      if (collapsed === v) return;
      collapsed = v;
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
      } catch {
        /* ignore */
      }
      renderHead();
      if (!v) reveal(rows.get(activeId));
      o.onChange?.();
    },
  };

  head.addEventListener('click', () => list.setCollapsed(!collapsed));
  root.hidden = true;
  renderHead();
  return list;
}

/** The update_tasks row's argument: the task in progress, else "all done" or "cleared" (else nothing; the meta has the count). */
export function taskSummary(tasks: TaskItem[]): string {
  if (!tasks.length) return 'cleared';
  const active = tasks.find((t) => t.status === 'in_progress');
  if (active) return active.title;
  return tasks.every((t) => t.status === 'completed') ? 'all done' : '';
}
