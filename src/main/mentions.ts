// @-mentions: an "@path" token in a user message names a file or folder of the working directory; its contents
// (or listing) are appended to the message as a <file> block so the model sees it with the request, as in
// Claude Code. Only paths inside the working directory are expanded; anything else stays plain text.
// The transcript shows the original text: sessions.ts strips the blocks again for display.

import fs from 'node:fs';
import path from 'node:path';

/** Every <file …>…</file> block appended to a user message (for display stripping) */
export const FILE_BLOCK_RE = /\n*<file path="[^"]*"(?: note="[^"]*")?>\n?[\s\S]*?<\/file>/g;
const FILE_OPEN_RE = /<file path="([^"]*)"/g;
/** "@" at the start or after whitespace or an opening bracket, then a quoted path or a bare token */
const MENTION_RE = /(^|[\s(,;])@(?:"([^"\n]+)"|([^\s@"'`<>()[\]{}]+))/g;
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 40_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DIR_ENTRIES = 200;

export interface MentionResult {
  /** The text with the file blocks appended (unchanged when nothing resolved) */
  content: string;
  /** The paths as the user wrote them, in order, that resolved inside the working directory */
  mentions: string[];
}

/** The tokens the user typed, with trailing punctuation dropped ("@src/a.ts," → "src/a.ts"). */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    let p = m[2] ?? m[3] ?? '';
    if (!m[2]) p = p.replace(/[.,;:!?]+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Paths named by the <file> blocks of a stored message, for the transcript. */
export function mentionedPaths(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(FILE_OPEN_RE)) {
    const p = m[1].replace(/&quot;/g, '"');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function isText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function attr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/** True when `abs` is the working directory or inside it (both resolved; symlinks not followed). */
function insideCwd(abs: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  return abs === root || abs.startsWith(root + path.sep);
}

/** Expands the mentions of a message against the working directory. Unknown or outside paths are left alone. */
export function expandMentions(text: string, cwd: string): MentionResult {
  const tokens = findMentions(text);
  if (!tokens.length) return { content: text, mentions: [] };
  const blocks: string[] = [];
  const mentions: string[] = [];
  let total = 0;
  for (const token of tokens) {
    if (path.isAbsolute(token) || token.startsWith('~')) continue;
    const abs = path.resolve(cwd, token);
    if (!insideCwd(abs, cwd)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    mentions.push(token);
    const label = attr(token);
    if (total >= MAX_TOTAL_CHARS) {
      blocks.push(`<file path="${label}" note="not inlined: the message already carries ${Math.round(MAX_TOTAL_CHARS / 1000)}k characters of files; use read_file">\n</file>`);
      continue;
    }
    if (st.isDirectory()) {
      let listing = '';
      try {
        const names = fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((d) => d.name !== '.DS_Store')
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
        listing = names.slice(0, MAX_DIR_ENTRIES).join('\n') + (names.length > MAX_DIR_ENTRIES ? `\n… ${names.length - MAX_DIR_ENTRIES} more entries` : '');
      } catch {
        listing = '(could not list)';
      }
      total += listing.length;
      blocks.push(`<file path="${label}" note="folder listing">\n${listing}\n</file>`);
      continue;
    }
    if (!st.isFile()) {
      mentions.pop();
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      blocks.push(`<file path="${label}" note="not inlined: ${Math.round(st.size / 1024)} KB; use read_file for the parts you need">\n</file>`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      blocks.push(`<file path="${label}" note="could not be read">\n</file>`);
      continue;
    }
    if (!isText(buf)) {
      blocks.push(`<file path="${label}" note="binary, ${Math.round(st.size / 1024)} KB">\n</file>`);
      continue;
    }
    let body = buf.toString('utf8');
    const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total);
    let note = '';
    if (body.length > room) {
      const cut = body.length - room;
      body = body.slice(0, room);
      note = ` note="first ${room} characters; ${cut} more not shown, use read_file for the rest"`;
    }
    total += body.length;
    blocks.push(`<file path="${label}"${note}>\n${body.replace(/<\/file>/g, '<\\/file>')}\n</file>`);
  }
  if (!blocks.length) return { content: text, mentions: [] };
  return { content: `${text}\n\n${blocks.join('\n\n')}`, mentions };
}
