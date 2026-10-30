// The auto-mode guard: pure rules that decide which commands and writes still need the user's OK.
// Also: the plan-mode read-only allowlist and the "program" of a command for session allow-lists.

import os from 'node:os';
import path from 'node:path';

/** Split a command line into simple commands on newlines, ;, &, &&, |, || (quote-aware, no heredoc parsing). */
export function splitCommands(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\n' || c === ';') {
      parts.push(cur);
      cur = '';
      continue;
    }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Words of a simple command with quotes removed (rough: no variable expansion). */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

const WRAPPERS = new Set(['env', 'nohup', 'time', 'nice', 'exec', 'command', 'builtin', 'caffeinate']);

/** The program a simple command runs: env assignments and wrappers like env/nohup/time are skipped; sudo counts as the program. */
export function programOf(simple: string): string {
  const w = words(simple);
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
  while (i < w.length && WRAPPERS.has(w[i])) {
    i++;
    while (i < w.length && w[i].startsWith('-')) i++;
  }
  return path.basename(w[i] ?? '');
}

/** Programs of every simple command in a command line, deduplicated, in order. */
export function programsOf(command: string): string[] {
  const seen: string[] = [];
  for (const simple of splitCommands(command)) {
    const p = programOf(simple);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir()).replace(/^\$HOME(?=$|\/)/, os.homedir());
}

/** True when `target` is the working directory or inside it (both resolved). */
export function insideCwd(target: string, cwd: string): boolean {
  const abs = path.resolve(cwd, expandHome(target));
  const root = path.resolve(cwd);
  return abs === root || abs.startsWith(root + path.sep);
}

const TMP_RE = /^(\/private)?\/tmp(\/|$)|^\/var\/folders\//;

function isAbsolutePathArg(a: string): boolean {
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('$HOME');
}

function pathArgsOutsideCwd(args: string[], cwd: string): string[] {
  return args.filter((a) => isAbsolutePathArg(a) && !insideCwd(a, cwd) && !TMP_RE.test(expandHome(a)) && a !== '/dev/null');
}

const BROAD_TARGETS = new Set(['/', '~', '$HOME', '*', './*', '..', '../', '.', './', '~/', '/*']);

function gitWords(w: string[]): { sub: string; rest: string[] } {
  // skip global options such as -C <dir> or --no-pager
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) {
    if (w[i] === '-C' || w[i] === '-c') i++;
    i++;
  }
  return { sub: w[i] ?? '', rest: w.slice(i + 1) };
}

const WRITE_PROGRAMS = new Set(['cp', 'mv', 'rm', 'mkdir', 'touch', 'ln', 'rsync', 'install', 'unzip', 'tar']);
const SECRET_PATH_RE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.config\/gh|\.env(\.[\w-]+)?|id_rsa|id_ed25519|[^/]*\.pem|[^/]*\.p12|[^/]*\.key)(\/|$)/;
const READ_PROGRAMS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'bat', 'open', 'cp', 'scp', 'base64', 'xxd', 'strings']);

/**
 * Why a shell command should pause for the user in auto mode, or null when it is routine development work
 * (builds, tests, git status/add/commit, file operations inside the working directory, package installs …).
 */
export function guardCommand(command: string, cwd: string): string | null {
  const raw = command.trim();
  if (!raw) return null;
  if (/\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|dash|python3?|node|perl|ruby)\b/.test(raw)) return 'pipes a download into a shell';
  if (/\b(sh|bash|zsh)\s+-c\s+["']?\$\(\s*(curl|wget)\b/.test(raw)) return 'pipes a download into a shell';
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) return 'fork bomb';

  for (const simple of splitCommands(raw)) {
    const w = words(simple);
    if (!w.length) continue;
    // env assignments / wrappers
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    while (i < w.length && WRAPPERS.has(w[i])) {
      i++;
      while (i < w.length && w[i].startsWith('-')) i++;
    }
    const argv = w.slice(i);
    const prog = path.basename(argv[0] ?? '');
    const args = argv.slice(1);
    const flags = args.filter((a) => a.startsWith('-'));
    const targets = args.filter((a) => !a.startsWith('-'));
    if (!prog) continue;

    if (prog === 'sudo' || prog === 'doas') return 'uses sudo';
    if (prog === 'rm') {
      const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive');
      if (targets.some((t) => BROAD_TARGETS.has(t) || /^~?\/\*?$/.test(t))) return recursive ? 'recursive delete of a broad path' : 'deletes a broad path';
      const outside = pathArgsOutsideCwd(targets, cwd);
      if (outside.length) return 'deletes outside the working directory';
      if (recursive && targets.some((t) => /^\.\.(\/|$)/.test(t) || t === '~')) return 'recursive delete of a broad path';
    }
    if (prog === 'git') {
      const { sub, rest } = gitWords(argv);
      if (sub === 'push') return rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--force')) ? 'force-pushes to a remote' : 'pushes to a remote';
      if (sub === 'reset' && rest.includes('--hard')) return 'destructive git (reset --hard)';
      if ((sub === 'checkout' || sub === 'restore') && rest.some((a) => a === '.' || a === '--' ) && rest.some((a) => a === '.')) return 'discards working-tree changes';
      if (sub === 'clean' && rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')) return 'discards untracked files (git clean)';
      if (sub === 'branch' && rest.includes('-D')) return 'deletes a branch';
      if (sub === 'stash' && rest.includes('drop')) return 'drops a stash';
    }
    if (['mkfs', 'dd', 'diskutil', 'fdisk', 'parted', 'newfs_hfs', 'newfs_apfs'].includes(prog) || /^mkfs\./.test(prog)) return 'disk operation';
    if (['shutdown', 'reboot', 'halt', 'launchctl', 'systemctl', 'killall', 'pkill'].includes(prog)) return 'system control';
    if (prog === 'kill' && flags.includes('-9') && targets.includes('-1')) return 'system control';
    if ((prog === 'chmod' || prog === 'chown' || prog === 'chgrp') && flags.some((f) => /^-[a-zA-Z]*R/.test(f) || f === '--recursive')) {
      if (targets.some((t) => BROAD_TARGETS.has(t)) || pathArgsOutsideCwd(targets, cwd).length) return 'broad permission change';
    }
    if (prog === 'osascript' || (prog === 'open' && (flags.includes('-a') || flags.includes('-b')))) return 'controls other apps';
    if (['ssh', 'scp', 'sftp', 'telnet'].includes(prog)) return 'remote access';
    if (prog === 'rsync' && targets.some((t) => /^[\w.-]+@[\w.-]+:|^[\w.-]+:[^/]/.test(t))) return 'remote access';
    if ((prog === 'npm' || prog === 'yarn' || prog === 'pnpm') && targets[0] === 'publish') return 'publishes a package';
    if (prog === 'cargo' && targets[0] === 'publish') return 'publishes a package';
    if ((prog === 'twine' && targets[0] === 'upload') || (prog === 'gem' && targets[0] === 'push')) return 'publishes a package';
    if (prog === 'gh' && ((targets[0] === 'release' && targets[1] !== 'list' && targets[1] !== 'view') || (targets[0] === 'pr' && (targets[1] === 'merge' || targets[1] === 'close')) || (targets[0] === 'repo' && targets[1] === 'delete'))) return 'publishes or merges on GitHub';
    if (['aws', 'gcloud', 'az', 'pulumi', 'flyctl', 'heroku', 'vercel', 'netlify'].includes(prog)) return 'cloud or infrastructure change';
    if (prog === 'kubectl' && ['apply', 'delete', 'rollout', 'scale', 'drain', 'cordon', 'patch', 'replace', 'exec'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'terraform' && ['apply', 'destroy', 'import', 'taint'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'helm' && ['install', 'upgrade', 'uninstall', 'delete', 'rollback'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'docker' || prog === 'podman') {
      const sub = targets[0] ?? '';
      if ((sub === 'system' && targets[1] === 'prune') || sub === 'rmi' || (sub === 'volume' && (targets[1] === 'rm' || targets[1] === 'prune')) || (sub === 'rm' && flags.some((f) => /^-[a-zA-Z]*f/.test(f) || f === '--force'))) return 'cloud or infrastructure change';
    }
    if ((prog === 'defaults' && targets[0] === 'write') || ['csrutil', 'spctl', 'nvram', 'tmutil', 'pmset', 'networksetup', 'scutil', 'dscl'].includes(prog)) return 'changes macOS settings';
    if (prog === 'security' && targets.some((t) => /^(find|dump|export|delete|add)-/.test(t))) return 'reads or changes the keychain';
    if (prog === 'printenv' && !targets.length) return 'reads secrets';
    if (prog === 'env' && !targets.length && !flags.length) return 'reads secrets';
    if (READ_PROGRAMS.has(prog) && targets.some((t) => SECRET_PATH_RE.test(expandHome(t)))) return 'reads secrets';
    if (prog === 'sed' && flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f === '--in-place') && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    if (WRITE_PROGRAMS.has(prog) && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    if (prog === 'tee' && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    // redirections: > path or >> path (not 2>&1, >&2, /dev/null)
    const redirects = simple.match(/(?<![0-9&])>{1,2}\s*([^\s;&|]+)/g) ?? [];
    for (const r of redirects) {
      const target = r.replace(/^>{1,2}\s*/, '').replace(/^["']|["']$/g, '');
      if (target.startsWith('&')) continue;
      if (pathArgsOutsideCwd([target], cwd).length) return 'writes outside the working directory';
    }
  }
  return null;
}

/** Why a file write should pause for the user, or null when the file is inside the working directory. */
export function guardWrite(absPath: string, cwd: string): string | null {
  const abs = path.resolve(expandHome(absPath));
  if (!insideCwd(abs, cwd)) return 'writes outside the working directory';
  const rel = path.relative(path.resolve(cwd), abs);
  if (rel === '.git' || rel.startsWith('.git' + path.sep)) return 'modifies the .git directory';
  return null;
}

const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'pwd', 'which', 'whereis', 'type', 'echo', 'printf', 'tree', 'du', 'df', 'stat', 'file',
  'date', 'uname', 'sw_vers', 'hostname', 'whoami', 'id', 'true', 'false', 'test', '[', 'sort', 'uniq', 'cut', 'awk', 'tr', 'diff', 'cmp', 'md5', 'shasum', 'jq', 'yq',
  'basename', 'dirname', 'realpath', 'readlink', 'column', 'nl', 'less', 'more', 'bat', 'xargs', 'sed', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python3', 'python', 'pip', 'pip3',
  'cargo', 'go', 'rustc', 'java', 'ruby', 'php', 'perl', 'swift', 'xcodebuild', 'make', 'cmake', 'tsc', 'eslint', 'prettier',
]);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'reflog', 'cat-file', 'grep', 'remote', 'config', 'rev-list', 'count-objects', 'branch', 'tag', 'stash', 'worktree', 'help', 'version']);
const PKG_READ_ONLY = new Set(['ls', 'list', 'view', 'info', 'outdated', 'audit', 'why', 'explain', 'show', 'search', 'help', 'version', '-v', '--version', 'config']);

/** True when every simple command in the line only reads (plan mode runs these without asking). */
export function isReadOnlyCommand(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  if (/(?<![0-9&])>{1,2}(?!&)/.test(raw)) return false; // any redirection into a file
  for (const simple of splitCommands(raw)) {
    const w = words(simple);
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    while (i < w.length && WRAPPERS.has(w[i])) i++;
    const argv = w.slice(i);
    const prog = path.basename(argv[0] ?? '');
    const args = argv.slice(1);
    const flags = args.filter((a) => a.startsWith('-'));
    const targets = args.filter((a) => !a.startsWith('-'));
    if (!prog) continue;
    if (!READ_ONLY_PROGRAMS.has(prog)) return false;
    if (prog === 'sed' && flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f === '--in-place')) return false;
    if (prog === 'find' && (args.includes('-delete') || args.includes('-exec') || args.includes('-execdir') || args.includes('-ok'))) return false;
    if (prog === 'xargs') return false;
    if (prog === 'git') {
      const { sub, rest } = gitWords(argv);
      if (!GIT_READ_ONLY.has(sub)) return false;
      if (sub === 'branch' && rest.some((a) => /^-[a-zA-Z]*[dDmMcC]/.test(a) || !a.startsWith('-'))) return false; // creating/deleting/renaming
      if (sub === 'tag' && rest.some((a) => !a.startsWith('-') || /^-[a-zA-Z]*[dfa]/.test(a))) return false;
      if (sub === 'stash' && rest[0] !== 'list' && rest[0] !== 'show') return false;
      if (sub === 'remote' && rest.length && rest[0] !== '-v' && rest[0] !== 'show' && rest[0] !== 'get-url') return false;
      if (sub === 'config' && !rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-all')) return false;
      if (sub === 'worktree' && rest[0] !== 'list') return false;
    }
    if (['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo', 'go'].includes(prog)) {
      const sub = targets[0] ?? flags[0] ?? '';
      if (prog === 'cargo' && !['tree', 'metadata', 'version', '--version', '-V', 'search'].includes(sub)) return false;
      if (prog === 'go' && !['version', 'env', 'list', 'doc'].includes(sub)) return false;
      if ((prog === 'pip' || prog === 'pip3') && !['list', 'show', 'freeze', '--version', '-V', 'check'].includes(sub)) return false;
      if ((prog === 'npm' || prog === 'pnpm' || prog === 'yarn') && !PKG_READ_ONLY.has(sub)) return false;
    }
    if (['node', 'python3', 'python', 'ruby', 'php', 'perl', 'java', 'swift', 'rustc'].includes(prog) && !args.every((a) => /^(-v|--version|-V|-version)$/.test(a))) return false;
    if (['make', 'cmake', 'tsc', 'xcodebuild', 'eslint', 'prettier'].includes(prog)) {
      const ok = (prog === 'make' && (flags.includes('-n') || flags.includes('--dry-run'))) || (prog === 'tsc' && flags.includes('--noEmit')) || (prog === 'xcodebuild' && (flags.includes('-list') || flags.includes('-version') || flags.includes('-showsdks'))) || (prog === 'eslint' && !flags.includes('--fix')) || (prog === 'prettier' && (flags.includes('--check') || flags.includes('-c') || flags.includes('--list-different'))) || (prog === 'cmake' && flags.includes('--version'));
      if (!ok) return false;
    }
  }
  return true;
}
