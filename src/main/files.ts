// File index for @-mentions: a bounded walk of the working directory (heavy folders and .gitignore'd names left
// out) with a small fuzzy matcher, cached for a few seconds per directory.

import fs from 'node:fs';
import path from 'node:path';
import type { FileHit } from '../shared/types';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.nuxt', '.svelte-kit', '.cache', '.turbo', '.parcel-cache',
  'coverage', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.idea', 'DerivedData', 'Pods', '.gradle', 'release',
]);
const IGNORED_FILES = new Set(['.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock']);
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 12;
const TTL_MS = 10_000;

interface Index {
  cwd: string;
  entries: FileHit[];
  builtAt: number;
  truncated: boolean;
}

let cache: Index | null = null;

/** A rough .gitignore reader: plain names, "dir/" and "*.ext" patterns at the root (no negations, no nested paths). */
function readIgnore(cwd: string): { names: Set<string>; dirs: Set<string>; exts: Set<string> } {
  const names = new Set<string>();
  const dirs = new Set<string>();
  const exts = new Set<string>();
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
  } catch {
    return { names, dirs, exts };
  }
  for (let line of raw.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    line = line.replace(/^\//, '');
    if (line.includes('/') && !line.endsWith('/')) continue;
    if (line.endsWith('/')) dirs.add(line.slice(0, -1));
    else if (/^\*\.[\w.-]+$/.test(line)) exts.add(line.slice(1));
    else if (!/[*?[\]]/.test(line)) names.add(line);
  }
  return { names, dirs, exts };
}

function build(cwd: string): Index {
  const ignore = readIgnore(cwd);
  const entries: FileHit[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (truncated || depth > MAX_DEPTH) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of list) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const name = d.name;
      const relPath = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(name) || ignore.dirs.has(name) || ignore.names.has(name)) continue;
        entries.push({ path: relPath, name, dir: rel, isDir: true });
        walk(path.join(dir, name), relPath, depth + 1);
      } else if (d.isFile()) {
        if (IGNORED_FILES.has(name) || ignore.names.has(name)) continue;
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
        if (ext && ignore.exts.has(ext)) continue;
        entries.push({ path: relPath, name, dir: rel, isDir: false });
      }
    }
  };
  walk(cwd, '', 0);
  return { cwd, entries, builtAt: Date.now(), truncated };
}

function index(cwd: string): Index {
  if (!cache || cache.cwd !== cwd || Date.now() - cache.builtAt > TTL_MS) cache = build(cwd);
  return cache;
}

/** Drops the cached index (after the agent changed files, say). */
export function invalidateFileIndex(): void {
  cache = null;
}

/**
 * Fuzzy score of `query` against an entry: the characters must appear in order; matches at the start of the
 * name, after a separator or next to the previous match score higher, and name matches beat deep-path matches.
 */
export function fuzzyScore(query: string, hit: FileHit): number {
  const q = query.toLowerCase();
  if (!q) return 1;
  const name = hit.name.toLowerCase();
  const full = hit.path.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - hit.path.length * 0.01;
  if (name.includes(q)) return 600 - hit.path.length * 0.01;
  if (full.includes(q)) return 400 - hit.path.length * 0.01;
  let qi = 0;
  let score = 0;
  let prevMatched = false;
  for (let i = 0; i < full.length && qi < q.length; i++) {
    if (full[i] === q[qi]) {
      const boundary = i === 0 || '/._-'.includes(full[i - 1]);
      score += prevMatched ? 6 : boundary ? 5 : 1;
      prevMatched = true;
      qi++;
    } else prevMatched = false;
  }
  if (qi < q.length) return 0;
  return score + 100 - Math.min(99, hit.path.length * 0.2);
}

/** Best `limit` matches for a query; an empty query lists the root first, folders before files. */
export function searchFiles(cwd: string, query: string, limit = 50): FileHit[] {
  const idx = index(cwd);
  const q = query.trim();
  const max = Math.max(1, Math.min(200, limit));
  if (!q) {
    return [...idx.entries]
      .sort((a, b) => depth(a) - depth(b) || Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path))
      .slice(0, max);
  }
  const scored: { hit: FileHit; score: number }[] = [];
  for (const hit of idx.entries) {
    const score = fuzzyScore(q, hit);
    if (score > 0) scored.push({ hit, score });
  }
  scored.sort((a, b) => b.score - a.score || a.hit.path.length - b.hit.path.length || a.hit.path.localeCompare(b.hit.path));
  return scored.slice(0, max).map((s) => s.hit);
}

function depth(h: FileHit): number {
  return h.path.split('/').length;
}

/** For tests and diagnostics */
export function fileIndexSize(cwd: string): { entries: number; truncated: boolean } {
  const idx = index(cwd);
  return { entries: idx.entries.length, truncated: idx.truncated };
}
