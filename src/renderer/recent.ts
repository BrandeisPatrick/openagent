// The welcome screen's "Recent projects" row (#recent-dirs, under the setup strip and above the suggestion chips):
// one chip per folder of AppConfig.recentDirs (most recent first) other than the current working directory, with a
// folder icon, the folder's name and its full path as the tooltip. Chips are keyed by folder and updated in place,
// so a focused chip survives a re-render. The app decides which folders show and does the switch (see onPick).

import { basename } from './dom.js';
import { icon } from './icons.js';

/** The contract's limit: the main process keeps at most this many folders */
export const MAX_RECENT = 8;

/** "/Users/me/app/" → "/Users/me/app" (the root stays "/") */
export function cleanDir(dir: string): string {
  const d = String(dir ?? '').trim();
  return d.length > 1 ? d.replace(/\/+$/, '') || '/' : d;
}

/** The folders to offer: absolute paths only, without the current working directory and repeats, at most MAX_RECENT. */
export function recentChoices(list: unknown, current: string): string[] {
  if (!Array.isArray(list)) return [];
  const here = cleanDir(current);
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const d = cleanDir(v);
    if (!d.startsWith('/') || d === here || out.includes(d)) continue;
    out.push(d);
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

/** "~/projects/app": how a chip names its folder to a screen reader */
function tildePath(dir: string): string {
  return dir.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/**
 * The chips' labels: each folder's name; folders that share a name get as many parent folders as it takes to tell
 * them apart ("work/app" and "old/app").
 */
export function recentLabels(dirs: string[]): string[] {
  const parts = dirs.map((d) => d.split('/').filter(Boolean));
  const depth = dirs.map(() => 1);
  const label = (i: number) => (parts[i].length ? parts[i].slice(-depth[i]).join('/') : '/');
  for (let round = 0; round < 16; round++) {
    const seen = new Map<string, number[]>();
    dirs.forEach((_, i) => {
      const key = label(i);
      seen.set(key, [...(seen.get(key) ?? []), i]);
    });
    let grew = false;
    for (const same of seen.values()) {
      if (same.length < 2) continue;
      for (const i of same) {
        if (depth[i] < parts[i].length) {
          depth[i]++;
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return dirs.map((_, i) => label(i));
}

export interface RecentRowOptions {
  /** #recent-dirs */
  root: HTMLElement;
  /** A chip was clicked: switch to `dir`. The chip shows it is busy (and the row takes no other click) until this settles. */
  onPick: (dir: string, chip: HTMLButtonElement) => Promise<void> | void;
}

export interface RecentRow {
  /** Shows a chip per folder, in this order (none hides the row) */
  render(dirs: string[]): void;
  /** The folders on screen, in order */
  dirs(): string[];
}

export function createRecentRow(o: RecentRowOptions): RecentRow {
  const root = o.root;
  root.innerHTML = `<span class="recent-label" id="recent-dirs-label">Recent projects</span><div class="recent-list"></div>`;
  const list = root.querySelector<HTMLElement>('.recent-list')!;
  const chips = new Map<string, HTMLButtonElement>();
  let current: string[] = [];
  let busy = false;

  const create = (dir: string): HTMLButtonElement => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-dir';
    chip.dataset.dir = dir;
    chip.innerHTML = `<span class="recent-icon" aria-hidden="true">${icon('folder', 14)}</span><span class="recent-name"></span>`;
    chip.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      chip.classList.add('busy');
      chip.setAttribute('aria-busy', 'true');
      try {
        await o.onPick(dir, chip);
      } finally {
        busy = false;
        chip.classList.remove('busy');
        chip.removeAttribute('aria-busy');
      }
    });
    return chip;
  };

  return {
    render(dirs: string[]) {
      current = dirs.slice();
      const labels = recentLabels(current);
      const keep = new Set(current);
      for (const [dir, chip] of chips) {
        if (keep.has(dir)) continue;
        chip.remove();
        chips.delete(dir);
      }
      let prev: HTMLElement | null = null;
      current.forEach((dir, i) => {
        let chip = chips.get(dir);
        if (!chip) {
          chip = create(dir);
          chips.set(dir, chip);
        }
        const name = chip.querySelector<HTMLElement>('.recent-name')!;
        if (name.textContent !== labels[i]) name.textContent = labels[i];
        chip.dataset.tip = dir;
        // The name alone can be ambiguous to a screen reader; the tooltip is not read out
        chip.setAttribute('aria-label', `${labels[i]}, ${tildePath(dir)}`);
        const want: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
        if (want !== chip) list.insertBefore(chip, want);
        prev = chip;
      });
      root.hidden = current.length === 0;
    },
    dirs: () => current.slice(),
  };
}

/** The chip's folder name for messages ("app"; "/" for the root) */
export function dirName(dir: string): string {
  return basename(dir) || dir;
}
