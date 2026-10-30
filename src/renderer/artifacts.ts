// Artifact card: a deliverable the model made with create_artifact (a page, a document, an image or code),
// with Open (in the Browser pane), Save as… and Reveal in Finder. Updates to the same artifact refresh the card.

import type { ArtifactInfo, ArtifactKind } from '../shared/types';
import { escapeHtml, formatBytes } from './dom.js';
import { icon, type IconName } from './icons.js';

export interface ArtifactCard {
  el: HTMLElement;
  info: ArtifactInfo;
  /** A newer version of the same artifact: refreshes the title and meta line; `updated` shows the "Updated" chip */
  update(info: ArtifactInfo, updated?: boolean): void;
}

export type ArtifactAction = 'open' | 'saveAs' | 'reveal';

export interface ArtifactCardOptions {
  /**
   * Runs a button's action. Resolves to a short confirmation to flash on the button ("Saved"), true when done
   * without one, or false when it failed or was cancelled (the caller reports errors next to the button).
   */
  act: (card: ArtifactCard, action: ArtifactAction, button: HTMLButtonElement) => Promise<string | boolean>;
  /** Show the "Updated" chip from the start */
  updated?: boolean;
}

const LANGUAGES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby', go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', md: 'Markdown', markdown: 'Markdown', xml: 'XML',
  c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
  swift: 'Swift', php: 'PHP', lua: 'Lua', r: 'R', dart: 'Dart', scala: 'Scala', hs: 'Haskell', haskell: 'Haskell',
};

/** "HTML", "Markdown", "SVG", or the code's language ("Python", "TypeScript", …; "Code" when none is given) */
export function artifactKindLabel(info: { kind?: ArtifactKind | string; language?: string }): string {
  switch (info.kind) {
    case 'html': return 'HTML';
    case 'markdown': return 'Markdown';
    case 'svg': return 'SVG';
    default: {
      const lang = typeof info.language === 'string' ? info.language.trim() : '';
      if (!lang) return 'Code';
      return LANGUAGES[lang.toLowerCase()] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
    }
  }
}

export function artifactIcon(kind: ArtifactKind | string | undefined): IconName {
  return kind === 'html' ? 'globe' : kind === 'markdown' ? 'file-text' : kind === 'svg' ? 'image' : 'code';
}

/** "HTML · v2 · 4 KB" */
export function artifactMeta(info: ArtifactInfo): string {
  const parts = [artifactKindLabel(info)];
  const version = Math.floor(Number(info.version));
  if (version > 0) parts.push(`v${version}`);
  if (Number.isFinite(Number(info.bytes)) && Number(info.bytes) >= 0) parts.push(formatBytes(Number(info.bytes)));
  return parts.join(' · ');
}

const BUTTONS: readonly [ArtifactAction, string, string][] = [
  ['reveal', 'Reveal in Finder', 'btn sm artifact-reveal'],
  ['saveAs', 'Save as…', 'btn sm artifact-save'],
  ['open', 'Open', 'btn sm primary artifact-open'],
];

export function createArtifactCard(info: ArtifactInfo, opts: ArtifactCardOptions): ArtifactCard {
  const el = document.createElement('div');
  el.className = 'artifact-card';
  el.innerHTML =
    `<div class="artifact-head"><span class="artifact-icon"></span>` +
    `<div class="artifact-heading"><div class="artifact-kicker">Artifact</div><div class="artifact-title"></div><div class="artifact-meta"></div></div>` +
    `<span class="artifact-chip" hidden>Updated</span></div>` +
    `<div class="artifact-actions">${BUTTONS.map(([action, label, cls]) => `<button type="button" class="${cls}" data-action="${action}"><span>${escapeHtml(label)}</span></button>`).join('')}</div>`;
  const iconEl = el.querySelector<HTMLElement>('.artifact-icon')!;
  const titleEl = el.querySelector<HTMLElement>('.artifact-title')!;
  const metaEl = el.querySelector<HTMLElement>('.artifact-meta')!;
  const chipEl = el.querySelector<HTMLElement>('.artifact-chip')!;
  let flashTimer: number | undefined;

  const render = () => {
    const a = card.info;
    el.dataset.artifactId = a.id;
    el.dataset.kind = a.kind;
    iconEl.innerHTML = icon(artifactIcon(a.kind));
    titleEl.textContent = a.title?.trim() || 'Untitled artifact';
    metaEl.textContent = artifactMeta(a);
    if (a.path) metaEl.title = a.path;
  };

  const card: ArtifactCard = {
    el,
    info,
    update(next: ArtifactInfo, updated = false) {
      if (!next || next.id !== card.info.id) return;
      // An older copy (e.g. replayed from the transcript) never rolls the card back.
      if (Number(next.version) < Number(card.info.version)) return;
      card.info = { ...card.info, ...next };
      render();
      if (updated) {
        chipEl.hidden = false;
        el.classList.remove('flash');
        void el.offsetWidth; // restart the highlight animation
        el.classList.add('flash');
        window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => el.classList.remove('flash'), 1200);
      }
    },
  };

  for (const btn of el.querySelectorAll<HTMLButtonElement>('.artifact-actions button')) {
    const action = btn.dataset.action as ArtifactAction;
    const labelEl = btn.querySelector('span')!;
    const label = labelEl.textContent ?? '';
    let resetTimer: number | undefined;
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      let res: string | boolean = false;
      try {
        res = await opts.act(card, action, btn);
      } finally {
        btn.disabled = false;
      }
      if (typeof res === 'string' && res) {
        window.clearTimeout(resetTimer);
        btn.classList.add('done');
        labelEl.textContent = res;
        resetTimer = window.setTimeout(() => {
          btn.classList.remove('done');
          labelEl.textContent = label;
        }, 1500);
      }
    };
  }

  render();
  if (opts.updated) chipEl.hidden = false;
  return card;
}
