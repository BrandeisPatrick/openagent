import { execFile } from 'node:child_process';
import os from 'node:os';
import type { Tool } from './types';
import { truncate } from './types';

const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${os.homedir()}/.local/bin`, `${os.homedir()}/.cargo/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function buildPath(): string {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const merged = [...current];
  for (const p of EXTRA_PATH) if (!merged.includes(p)) merged.push(p);
  return merged.join(':');
}

export const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command (zsh) in the working directory and return stdout, stderr and the exit code. Non-interactive only: never run commands that wait for input. Default timeout 120 s, max 600 s.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command is required');
    const approval = await ctx.approve('bash', command);
    if (!approval.ok) return { content: approval.message };
    const timeout = Math.min(Math.max(1000, Number(args.timeout_ms) || 120_000), 600_000);
    return new Promise((resolve) => {
      execFile(
        '/bin/zsh',
        ['-lc', command],
        { cwd: ctx.cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PATH: buildPath(), TERM: 'dumb', CI: '1' } },
        (err, stdout, stderr) => {
          let code: string | number = 0;
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
            if (e.killed) code = `killed (${e.signal ?? 'timeout'} after ${timeout} ms)`;
            else code = e.code ?? e.message;
          }
          let out = stdout ?? '';
          if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
          out += `${out.endsWith('\n') || !out ? '' : '\n'}[exit code: ${code}]`;
          resolve({ content: truncate(out) });
        },
      );
    });
  },
};
