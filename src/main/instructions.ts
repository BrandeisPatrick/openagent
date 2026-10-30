// Project instructions: a Markdown file at the root of the working directory that the system prompt includes on
// every run (Claude Code's CLAUDE.md; AGENTS.md is the cross-tool name), plus a user-level one in ~/.openagent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Checked in this order; the first that exists is used. */
export const INSTRUCTION_FILES = ['OPENAGENT.md', 'OPENCODER.md', 'AGENTS.md', 'CLAUDE.md'];
export const USER_INSTRUCTIONS = path.join(os.homedir(), '.openagent', 'OPENAGENT.md');
/** The file from before the app was renamed, still honoured */
const USER_INSTRUCTIONS_OLD = path.join(os.homedir(), '.opencoder', 'OPENCODER.md');
const MAX_CHARS = 24_000;

export interface InstructionFile {
  /** Absolute path */
  path: string;
  /** How the prompt names it: "OPENAGENT.md" or "~/.openagent/OPENAGENT.md" */
  label: string;
  text: string;
  truncated: boolean;
}

function read(file: string, label: string): InstructionFile | null {
  let text: string;
  try {
    if (!fs.statSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  text = text.replace(/^﻿/, '').trim();
  if (!text) return null;
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS) + '\n[… truncated]';
  return { path: file, label, text, truncated };
}

/** The user-level file first, then the project's; either may be missing. */
export function loadInstructions(cwd: string): InstructionFile[] {
  const out: InstructionFile[] = [];
  const user = read(USER_INSTRUCTIONS, '~/.openagent/OPENAGENT.md') ?? read(USER_INSTRUCTIONS_OLD, '~/.opencoder/OPENCODER.md');
  if (user) out.push(user);
  for (const name of INSTRUCTION_FILES) {
    const hit = read(path.join(cwd, name), name);
    if (hit) {
      out.push(hit);
      break;
    }
  }
  return out;
}

/**
 * Appends one bullet to the project's instructions file (the first existing of INSTRUCTION_FILES; OPENAGENT.md is
 * created when none exists), for the composer's "#" shortcut. Returns the file and its label.
 */
export function appendInstruction(cwd: string, text: string): { path: string; label: string } {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('Nothing to add.');
  let label = INSTRUCTION_FILES.find((name) => {
    try {
      return fs.statSync(path.join(cwd, name)).isFile();
    } catch {
      return false;
    }
  });
  const file = path.join(cwd, label ?? INSTRUCTION_FILES[0]);
  let current = '';
  if (label) current = fs.readFileSync(file, 'utf8');
  else {
    label = INSTRUCTION_FILES[0];
    current = '# Project instructions\n\nNotes for the agent working in this project.\n';
  }
  const sep = current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${current}${sep}- ${line}\n`);
  return { path: file, label };
}

/** The system-prompt section for the files, or '' when there is none. */
export function instructionsPrompt(files: InstructionFile[]): string {
  if (!files.length) return '';
  return files.map((f) => `\n\nInstructions from ${f.label} (follow them for this ${f.label.startsWith('~') ? 'user' : 'project'}):\n${f.text}`).join('');
}
