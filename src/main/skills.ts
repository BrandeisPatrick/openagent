import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo } from '../shared/types';

export interface Skill extends SkillInfo {
  body: string;
}

/**
 * Skills are folders containing a SKILL.md with YAML-ish frontmatter (name, description)
 * followed by instructions. Lookup order: <project>/.openagent/skills, ~/.openagent/skills,
 * then the skills/ folder bundled with the app. Earlier sources win on name clashes.
 */
export function loadSkills(cwd: string, appRoot: string): Skill[] {
  const sources: [string, Skill['source']][] = [
    [path.join(cwd, '.openagent', 'skills'), 'project'],
    [path.join(cwd, '.opencoder', 'skills'), 'project'], // the folder name from before the rename
    [path.join(os.homedir(), '.openagent', 'skills'), 'user'],
    [path.join(os.homedir(), '.opencoder', 'skills'), 'user'],
    [path.join(appRoot, 'skills'), 'bundled'],
  ];
  const byName = new Map<string, Skill>();
  for (const [dir, source] of sources) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const skill = parseSkill(fs.readFileSync(file, 'utf8'), e.name, file, source);
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      } catch (err) {
        console.warn(`[skills] skipping ${file}:`, err);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkill(raw: string, dirName: string, file: string, source: Skill['source']): Skill {
  let name = dirName;
  let description = '';
  let body = raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'name') name = value;
      else if (m[1] === 'description') description = value;
    }
  }
  return { name: name.toLowerCase(), description, path: file, source, body: body.trim() };
}

export const SLASH_RE = /^\/([\w-]+)(?:\s+([\s\S]*))?$/;

/** Turns "/name args" into the message the model sees: the user's line plus the skill body. */
export function expandSlashCommand(text: string, skills: Skill[]): { content: string; skill?: Skill } {
  const m = SLASH_RE.exec(text.trim());
  if (!m) return { content: text };
  const skill = skills.find((s) => s.name === m[1].toLowerCase());
  if (!skill) return { content: text };
  return { content: `${text.trim()}\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>`, skill };
}

export function toInfo(s: Skill): SkillInfo {
  return { name: s.name, description: s.description, path: s.path, source: s.source };
}
