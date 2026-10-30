// Change tracker: what the agent changed in a session (snapshots taken before the first write/edit of each
// file) plus, when the working directory is a git repository, anything else git sees as changed.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChangeDiff, ChangeEntry } from '../shared/types';

export interface Snapshot {
  /** Content before the agent's first change; null when the file did not exist */
  original: string | null;
  /** Too large or not text: tracked by name only */
  skipped?: boolean;
}

export interface TrackedSession {
  id: string;
  changes?: Record<string, Snapshot>;
}

const MAX_SNAPSHOT = 2 * 1024 * 1024;
const GIT_TIMEOUT = 5000;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Reads a text file; '' when missing; null when binary or too large. */
function readText(file: string): string | null | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  if (buf.length > MAX_SNAPSHOT || isBinary(buf)) return null;
  return buf.toString('utf8');
}

/** Records the file's current content the first time the agent is about to change it in this session. */
export function snapshotBeforeChange(session: TrackedSession, absPath: string): void {
  const key = canon(absPath);
  session.changes ??= {};
  if (session.changes[key]) return;
  const text = readText(key);
  if (text === undefined) session.changes[key] = { original: null };
  else if (text === null) session.changes[key] = { original: null, skipped: true };
  else session.changes[key] = { original: text };
}

function splitLines(s: string): string[] {
  if (!s) return [];
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** Added/removed line counts between two texts (LCS for moderate sizes, line-multiset otherwise). */
export function countDiff(a: string, b: string): { additions: number; deletions: number } {
  const x = splitLines(a);
  const y = splitLines(b);
  if (x.length * y.length <= 4_000_000) {
    const m = x.length;
    const n = y.length;
    let prev = new Uint32Array(n + 1);
    let cur = new Uint32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      [prev, cur] = [cur, prev];
    }
    const lcs = prev[n];
    return { additions: n - lcs, deletions: m - lcs };
  }
  const counts = new Map<string, number>();
  for (const l of x) counts.set(l, (counts.get(l) ?? 0) + 1);
  let same = 0;
  for (const l of y) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      same++;
      counts.set(l, c - 1);
    }
  }
  return { additions: y.length - same, deletions: x.length - same };
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const topCache = new Map<string, { at: number; top: string | null }>();

/** The repository root for a directory, or null (cached for a few seconds). */
export async function gitTop(cwd: string): Promise<string | null> {
  const hit = topCache.get(cwd);
  if (hit && Date.now() - hit.at < 3000) return hit.top;
  let top: string | null = null;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim() || null;
  } catch {
    top = null;
  }
  topCache.set(cwd, { at: Date.now(), top });
  return top;
}

interface GitFile {
  abs: string;
  status: ChangeEntry['status'];
  untracked: boolean;
}

async function gitChangedFiles(top: string): Promise<GitFile[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], top);
  const files: GitFile[] = [];
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (!rel || rel.endsWith('/')) continue;
    const abs = path.join(top, rel);
    if (xy === '??') files.push({ abs, status: 'added', untracked: true });
    else if (xy.includes('D')) files.push({ abs, status: 'deleted', untracked: false });
    else if (xy.includes('A')) files.push({ abs, status: 'added', untracked: false });
    else if (xy === '!!') continue;
    else files.push({ abs, status: 'modified', untracked: false });
  }
  return files;
}

async function gitNumstat(top: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let out = '';
  try {
    out = await git(['diff', '--numstat', 'HEAD', '--'], top);
  } catch {
    try {
      out = await git(['diff', '--numstat', '--'], top); // no commits yet
    } catch {
      return map;
    }
  }
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === '-';
    map.set(path.join(top, m[3]), { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

async function gitHeadContent(top: string, rel: string): Promise<string> {
  try {
    return await git(['show', `HEAD:${rel.split(path.sep).join('/')}`], top);
  } catch {
    return '';
  }
}

/** Real path with symlinks resolved; a missing file resolves its parent so /var and /private/var compare equal on macOS. */
function canon(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function relTo(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

function sessionEntry(session: TrackedSession, cwd: string, abs: string, snap: Snapshot): ChangeEntry | null {
  const current = readText(abs);
  const exists = current !== undefined;
  if (snap.skipped) {
    // unknown baseline: show it as modified if it exists, deleted otherwise, without counts
    return { path: abs, relPath: relTo(cwd, abs), status: exists ? 'modified' : 'deleted', additions: 0, deletions: 0, source: 'session' };
  }
  if (snap.original === null) {
    if (!exists) return null; // created and removed again
    const { additions } = countDiff('', current ?? '');
    return { path: abs, relPath: relTo(cwd, abs), status: 'added', additions, deletions: 0, source: 'session' };
  }
  if (!exists) return { path: abs, relPath: relTo(cwd, abs), status: 'deleted', additions: 0, deletions: splitLines(snap.original).length, source: 'session' };
  if (current === null) return { path: abs, relPath: relTo(cwd, abs), status: 'modified', additions: 0, deletions: 0, source: 'session' };
  if (current === snap.original) return null;
  const { additions, deletions } = countDiff(snap.original, current);
  return { path: abs, relPath: relTo(cwd, abs), status: 'modified', additions, deletions, source: 'session' };
}

/** Changed files: the session's snapshot entries that differ now, then git-only entries, sorted by relPath. */
export async function listChanges(session: TrackedSession, rawCwd: string): Promise<ChangeEntry[]> {
  const cwd = canon(rawCwd);
  const entries: ChangeEntry[] = [];
  const covered = new Set<string>();
  for (const [abs, snap] of Object.entries(session.changes ?? {})) {
    covered.add(canon(abs));
    const e = sessionEntry(session, cwd, abs, snap);
    if (e) entries.push(e);
  }
  const top = await gitTop(cwd).catch(() => null);
  if (top) {
    try {
      const [files, stats] = await Promise.all([gitChangedFiles(top), gitNumstat(top)]);
      for (const f of files) {
        if (covered.has(f.abs)) continue;
        let additions = 0;
        let deletions = 0;
        if (f.untracked) {
          const text = readText(f.abs);
          additions = typeof text === 'string' ? splitLines(text).length : 0;
        } else {
          const s = stats.get(f.abs);
          if (s) ({ additions, deletions } = s);
        }
        entries.push({ path: f.abs, relPath: relTo(cwd, f.abs), status: f.status, additions, deletions, source: 'git' });
      }
    } catch (err) {
      console.warn('[changes] git listing failed:', err);
    }
  }
  return entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Number of snapshot-tracked files that currently differ from their original (cheap enough for metadata). */
export function changedFileCount(session: TrackedSession, rawCwd: string): number {
  const cwd = canon(rawCwd);
  let n = 0;
  for (const [abs, snap] of Object.entries(session.changes ?? {})) if (sessionEntry(session, cwd, abs, snap)) n++;
  return n;
}

export async function diffOf(session: TrackedSession, rawCwd: string, absPath: string): Promise<ChangeDiff> {
  const cwd = canon(rawCwd);
  const abs = canon(absPath);
  const snap = session.changes?.[abs];
  const current = readText(abs);
  if (snap) {
    const entry = sessionEntry(session, cwd, abs, snap) ?? { path: abs, relPath: relTo(cwd, abs), status: 'modified' as const, additions: 0, deletions: 0, source: 'session' as const };
    const binary = snap.skipped || current === null;
    return { ...entry, original: binary ? '' : snap.original ?? '', current: binary ? '' : current ?? '', binary: binary || undefined };
  }
  const top = await gitTop(cwd);
  if (!top) throw new Error(`${relTo(cwd, abs)} is not tracked in this session.`);
  const rel = path.relative(top, abs);
  const original = await gitHeadContent(top, rel);
  const exists = current !== undefined;
  const binary = current === null || isBinary(Buffer.from(original, 'utf8'));
  const status: ChangeEntry['status'] = !exists ? 'deleted' : original ? 'modified' : 'added';
  const counts = binary ? { additions: 0, deletions: 0 } : countDiff(original, current ?? '');
  return { path: abs, relPath: relTo(cwd, abs), status, ...counts, source: 'git', original: binary ? '' : original, current: binary ? '' : current ?? '', binary: binary || undefined };
}

/** Puts the file back the way it was before this session (or before the last commit for git-only entries). */
export async function revertChange(session: TrackedSession, rawCwd: string, absPath: string): Promise<ChangeEntry[]> {
  const cwd = canon(rawCwd);
  const abs = canon(absPath);
  const snap = session.changes?.[abs];
  if (snap) {
    if (snap.skipped) throw new Error('This file was too large or not text to snapshot, so it cannot be reverted here.');
    if (snap.original === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, snap.original, 'utf8');
    }
    return listChanges(session, cwd);
  }
  const top = await gitTop(cwd);
  if (!top) throw new Error(`${relTo(cwd, abs)} is not tracked in this session.`);
  const rel = path.relative(top, abs);
  const files = await gitChangedFiles(top);
  const f = files.find((x) => x.abs === abs);
  if (!f) throw new Error(`${relTo(cwd, abs)} has no git changes to revert.`);
  if (f.untracked) fs.rmSync(abs, { force: true });
  else await git(['checkout', 'HEAD', '--', rel], top);
  return listChanges(session, cwd);
}
