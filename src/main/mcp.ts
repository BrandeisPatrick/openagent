// MCP (Model Context Protocol) servers: external tool providers the model calls as mcp__<server>__<tool>, the
// naming Claude Code uses. Servers come from the app's settings (user scope) and from <workingDirectory>/.mcp.json
// (project scope, the file Claude Code reads too) and run as child processes (stdio) or over HTTP.

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema, type Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig, McpScope, McpServerConfig, McpServerInfo, McpStatus, McpToolInfo } from '../shared/types';
import type { Tool, ToolResult } from './tools/types';
import { words } from './guard';

export const PROJECT_FILE = '.mcp.json';
const NAME_RE = /^[\w.-]{1,64}$/;
const CONNECT_TIMEOUT_MS = 60_000; // "npx -y …" may download the server on first use
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_NAME = 64;
const STDERR_LINES = 12;
const MAX_DETAIL = 2000;

export interface McpManagerOptions {
  getConfig: () => AppConfig;
  /** Persists changed settings (user servers, trusted project servers) */
  saveConfig: (patch: Partial<AppConfig>) => void;
  cwd: () => string;
  version?: string;
}

interface Entry {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  /** JSON of the config: a changed signature means disconnect and reconnect */
  signature: string;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  sdkTools: SdkTool[];
  client: Client | null;
  transport: 'stdio' | 'http' | 'sse';
  serverInfo?: { name: string; version: string };
  stderr: string[];
  /** Bumped on every connect and disconnect so results of a superseded attempt are ignored */
  generation: number;
}

export interface McpToolRef {
  server: string;
  scope: McpScope;
  tool: string;
  readOnly: boolean;
  destructive: boolean;
}

interface ToolIndexEntry {
  entry: Entry;
  tool: SdkTool;
  info: McpToolInfo;
}

const keyOf = (scope: McpScope, name: string) => `${scope}:${name}`;

/** `${VAR}` and `${VAR:-default}` in strings of a config, as Claude Code expands them in .mcp.json. */
export function expandEnvRefs(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? '');
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/** The transport a config uses (stdio when it has a command). */
export function transportOf(c: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if ('url' in c && c.url) return c.type === 'sse' ? 'sse' : 'http';
  return 'stdio';
}

/** The command line or URL, for display. */
export function targetOf(c: McpServerConfig): string {
  if ('url' in c && c.url) return c.url;
  const s = c as { command: string; args?: string[] };
  return [s.command, ...(s.args ?? [])].map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(' ');
}

/** Checks and trims a raw config object (from settings, .mcp.json or a pasted snippet). Throws on an unusable one. */
export function normalizeServerConfig(raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a server entry must be an object');
  const r = raw as Record<string, unknown>;
  const disabled = r.disabled === true ? true : undefined;
  const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object of strings`);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
    return Object.keys(out).length ? out : undefined;
  };
  const type = typeof r.type === 'string' ? r.type.toLowerCase() : undefined;
  if (typeof r.url === 'string' && r.url.trim()) {
    const url = r.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not an http(s) URL`);
    const t: 'http' | 'sse' = type === 'sse' ? 'sse' : 'http';
    return { type: t, url, headers: strMap(r.headers, 'headers'), disabled };
  }
  if (typeof r.command === 'string' && r.command.trim()) {
    if (type && type !== 'stdio') throw new Error(`transport "${type}" needs a "url"`);
    const args = r.args === undefined ? undefined : Array.isArray(r.args) ? r.args.map((a) => String(a)) : (() => { throw new Error('"args" must be a list'); })();
    const cwd = typeof r.cwd === 'string' && r.cwd.trim() ? r.cwd.trim() : undefined;
    return { type: 'stdio', command: r.command.trim(), args, env: strMap(r.env, 'env'), cwd, disabled };
  }
  throw new Error('a server entry needs a "command" (stdio) or a "url" (http)');
}

/**
 * Turns what the user typed in the "Add server" form into configs by name: a JSON snippet ({"command": …},
 * {"type": "http", "url": …} or a whole {"mcpServers": {…}} block), a URL, or a command line.
 */
export function parseServerSpec(name: string, spec: string, env?: Record<string, string>): Record<string, McpServerConfig> {
  const text = spec.trim();
  if (!text) throw new Error('Enter a command line, a URL or a JSON snippet.');
  const cleanName = name.trim();
  const needName = () => {
    if (!cleanName) throw new Error('Give the server a name.');
    if (!NAME_RE.test(cleanName)) throw new Error('Server names use letters, digits, ".", "-" and "_" (at most 64 characters).');
    return cleanName;
  };
  const withEnv = (c: McpServerConfig): McpServerConfig => {
    if (!env || !Object.keys(env).length || transportOf(c) !== 'stdio') return c;
    const s = c as Extract<McpServerConfig, { command: string }>;
    return { ...s, env: { ...(s.env ?? {}), ...env } };
  };
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`The JSON could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
      const out: Record<string, McpServerConfig> = {};
      for (const [n, raw] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
        if (!NAME_RE.test(n)) throw new Error(`"${n}" is not a valid server name.`);
        try {
          out[n] = withEnv(normalizeServerConfig(raw));
        } catch (err) {
          throw new Error(`Server "${n}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!Object.keys(out).length) throw new Error('The "mcpServers" block is empty.');
      return out;
    }
    const keys = Object.keys(obj);
    // A single named entry such as {"github": {"command": …}}
    if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object' && !('command' in obj) && !('url' in obj)) {
      if (!NAME_RE.test(keys[0])) throw new Error(`"${keys[0]}" is not a valid server name.`);
      return { [cleanName || keys[0]]: withEnv(normalizeServerConfig(obj[keys[0]])) };
    }
    return { [needName()]: withEnv(normalizeServerConfig(obj)) };
  }
  if (/^https?:\/\/\S+$/i.test(text)) return { [needName()]: { type: 'http', url: text } };
  const w = words(text);
  if (!w.length) throw new Error('Enter a command line, a URL or a JSON snippet.');
  return { [needName()]: withEnv({ type: 'stdio', command: w[0], args: w.length > 1 ? w.slice(1) : undefined }) };
}

/** Reads a project's .mcp.json. Entries that cannot be used are returned under `invalid` with the reason. */
export function readProjectServers(cwd: string): { servers: Record<string, McpServerConfig>; invalid: Record<string, string>; fileError?: string } {
  const file = path.join(cwd, PROJECT_FILE);
  const servers: Record<string, McpServerConfig> = {};
  const invalid: Record<string, string> = {};
  if (!fs.existsSync(file)) return { servers, invalid };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { servers, invalid, fileError: `${PROJECT_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { servers, invalid, fileError: `${PROJECT_FILE} has no "mcpServers" object` };
  for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) {
      invalid[name.slice(0, 64)] = 'invalid server name';
      continue;
    }
    try {
      servers[name] = normalizeServerConfig(entry);
    } catch (err) {
      invalid[name] = err instanceof Error ? err.message : String(err);
    }
  }
  return { servers, invalid };
}

function writeProjectServers(cwd: string, update: (map: Record<string, unknown>) => void): void {
  const file = path.join(cwd, PROJECT_FILE);
  let root: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; // throws on a malformed file: do not clobber it
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${PROJECT_FILE} is not a JSON object`);
    root = parsed as Record<string, unknown>;
  }
  const map = root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers) ? (root.mcpServers as Record<string, unknown>) : {};
  update(map);
  root.mcpServers = map;
  fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n');
}

const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/.cargo/bin', '~/.bun/bin', '~/.deno/bin', '~/go/bin'];

let loginPathPromise: Promise<string> | null = null;

/**
 * PATH as the user's login shell sets it. An app launched from the Dock inherits only the system PATH, so
 * "npx"/"uvx" installed through Homebrew, nvm or uv would not be found without this.
 */
export function loginPath(): Promise<string> {
  loginPathPromise ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const done = (raw: string) => {
      const line = raw.split('\n').reverse().find((l) => l.startsWith('__OC_PATH__'));
      const found = line ? line.slice('__OC_PATH__'.length).trim() : '';
      const parts = (found || process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
      for (const dir of COMMON_BIN_DIRS.map(expandHome)) if (!parts.includes(dir) && fs.existsSync(dir)) parts.push(dir);
      resolve(parts.join(':'));
    };
    try {
      execFile(shell, ['-ilc', 'echo "__OC_PATH__$PATH"'], { timeout: 6000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (_err, stdout) => done(String(stdout ?? '')));
    } catch {
      done('');
    }
  });
  return loginPathPromise;
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** JSON of a tool's arguments for the approval card, pretty and bounded. */
export function approvalDetail(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}, null, 2);
  } catch {
    text = String(args);
  }
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + '\n…' : text;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface CallResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

/** Maps a tool result's content blocks onto text (and the first image) for the model. */
export function contentToResult(res: CallResult): ToolResult {
  const texts: string[] = [];
  let image: string | undefined;
  const blocks = Array.isArray(res.content) ? (res.content as Record<string, unknown>[]) : [];
  for (const part of blocks) {
    switch (part.type) {
      case 'text':
        texts.push(String(part.text ?? ''));
        break;
      case 'image': {
        const mime = String(part.mimeType || 'image/png');
        const data = String(part.data ?? '');
        if (!image && /^image\//.test(mime)) image = `data:${mime};base64,${data}`;
        texts.push(`[image: ${mime}, ${formatBytes(Math.floor((data.length * 3) / 4))}${image?.endsWith(data) ? ', shown to the user' : ''}]`);
        break;
      }
      case 'audio':
        texts.push(`[audio: ${String(part.mimeType || 'audio')}, ${formatBytes(Math.floor((String(part.data ?? '').length * 3) / 4))}, not played]`);
        break;
      case 'resource': {
        const r = (part.resource ?? {}) as Record<string, unknown>;
        const uri = typeof r.uri === 'string' ? r.uri : '';
        if (typeof r.text === 'string') texts.push(uri ? `[resource ${uri}]\n${r.text}` : r.text);
        else texts.push(`[resource ${uri || '(no uri)'}: ${String(r.mimeType || 'binary')}, ${formatBytes(Math.floor((String(r.blob ?? '').length * 3) / 4))}]`);
        break;
      }
      case 'resource_link':
        texts.push(`[resource link: ${String(part.uri ?? '')}${part.name ? ` (${String(part.name)})` : ''}${part.description ? ` — ${String(part.description)}` : ''}]`);
        break;
      default:
        texts.push(`[${String(part.type ?? 'content')} block]`);
    }
  }
  if (!texts.length && res.structuredContent !== undefined) texts.push(JSON.stringify(res.structuredContent, null, 2));
  let content = texts.join('\n').trim();
  if (res.isError) content = `Error: ${content || 'the tool reported an error'}`;
  if (!content) content = image ? '[image returned]' : '(no output)';
  return image ? { content, image } : { content };
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const m = /spawn (\S+) ENOENT/.exec(err.message);
      return `Command not found${m ? `: ${m[1]}` : ''}. Check that it is installed and on your PATH.`;
    }
    return err.message || String(err);
  }
  return String(err);
}

export class McpManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  private byFullName = new Map<string, ToolIndexEntry>();
  private clientInfo: { name: string; version: string };
  private reloading: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: McpManagerOptions) {
    super();
    this.clientInfo = { name: 'OpenAgent', version: opts.version ?? '0.1.0' };
  }

  list(): McpServerInfo[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1))
      .map((e) => this.infoOf(e));
  }

  private infoOf(e: Entry): McpServerInfo {
    const info: McpServerInfo = {
      name: e.name,
      scope: e.scope,
      transport: e.transport,
      target: targetOf(e.config),
      status: e.status,
      tools: e.status === 'connected' ? e.tools.map((t) => ({ ...t })) : [],
      config: structuredClone(e.config),
    };
    if (e.error) info.error = e.error;
    if (e.serverInfo) info.serverInfo = { ...e.serverInfo };
    return info;
  }

  /** The config of a listed server, for callers that edit it (the IPC layer). */
  get(name: string, scope: McpScope): McpServerInfo | undefined {
    const e = this.entries.get(keyOf(scope, name));
    return e ? this.infoOf(e) : undefined;
  }

  private notify(): void {
    this.rebuildIndex();
    this.emit('servers', this.list());
  }

  /** Names of project servers that wait for the user's OK (the renderer shows a notice). */
  blocked(): string[] {
    return [...this.entries.values()].filter((e) => e.status === 'blocked').map((e) => e.name);
  }

  /** Re-reads the settings and the project file, connects new or changed servers and drops removed ones. */
  reload(): Promise<void> {
    if (this.reloading) return this.reloading.then(() => this.reload());
    this.reloading = this.doReload().finally(() => (this.reloading = null));
    return this.reloading;
  }

  private async doReload(): Promise<void> {
    if (this.closed) return;
    const cfg = this.opts.getConfig();
    const cwd = this.opts.cwd();
    const desired = new Map<string, { name: string; scope: McpScope; config: McpServerConfig; invalid?: string }>();
    for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
      if (!NAME_RE.test(name)) continue;
      try {
        desired.set(keyOf('user', name), { name, scope: 'user', config: normalizeServerConfig(raw) });
      } catch (err) {
        desired.set(keyOf('user', name), { name, scope: 'user', config: { command: '?' }, invalid: errorText(err) });
      }
    }
    const project = readProjectServers(cwd);
    if (project.fileError) console.warn('[mcp]', project.fileError);
    for (const [name, config] of Object.entries(project.servers)) desired.set(keyOf('project', name), { name, scope: 'project', config });
    for (const [name, reason] of Object.entries(project.invalid)) desired.set(keyOf('project', name), { name, scope: 'project', config: { command: '?' }, invalid: reason });

    const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
    const pending: Promise<void>[] = [];
    // Drop entries that are gone or changed.
    for (const [key, e] of [...this.entries]) {
      const want = desired.get(key);
      const signature = want ? JSON.stringify({ c: want.config, i: want.invalid ?? null, t: want.scope === 'project' ? trusted.has(want.name) : true }) : '';
      if (!want || signature !== e.signature) {
        this.entries.delete(key);
        pending.push(this.disconnect(e));
      }
    }
    // Add new ones.
    for (const [key, want] of desired) {
      if (this.entries.has(key)) continue;
      const signature = JSON.stringify({ c: want.config, i: want.invalid ?? null, t: want.scope === 'project' ? trusted.has(want.name) : true });
      const e: Entry = {
        name: want.name,
        scope: want.scope,
        config: want.config,
        signature,
        status: 'connecting',
        tools: [],
        sdkTools: [],
        client: null,
        transport: transportOf(want.config),
        stderr: [],
        generation: 0,
      };
      this.entries.set(key, e);
      if (want.invalid) {
        e.status = 'error';
        e.error = `Invalid entry: ${want.invalid}`;
      } else if (want.config.disabled) {
        e.status = 'disabled';
      } else if (want.scope === 'project' && !trusted.has(want.name)) {
        e.status = 'blocked';
        e.error = `Found in ${PROJECT_FILE}. Enable it in Settings → MCP servers to let it run.`;
      } else {
        pending.push(this.connect(e));
      }
    }
    this.notify();
    await Promise.allSettled(pending);
  }

  private async connect(e: Entry): Promise<void> {
    const gen = ++e.generation;
    const current = () => e.generation === gen && this.entries.get(keyOf(e.scope, e.name)) === e && !this.closed;
    e.status = 'connecting';
    e.error = undefined;
    e.tools = [];
    e.sdkTools = [];
    e.stderr = [];
    this.notify();
    let client = new Client(this.clientInfo, { capabilities: {} });
    const open: { transport: Transport | null } = { transport: null };
    try {
      const attempt = async (kind: 'stdio' | 'http' | 'sse') => {
        const transport = await this.makeTransport(e, kind);
        open.transport = transport;
        e.transport = kind;
        const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`No answer within ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS).unref());
        await Promise.race([client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }), timer]);
      };
      const kind = transportOf(e.config);
      try {
        await attempt(kind);
      } catch (err) {
        // An "http" server that only speaks the older SSE transport answers the streamable POST with 4xx.
        if (kind === 'http' && /4\d\d|not found|method not allowed|failed to connect|unexpected content type/i.test(errorText(err))) {
          await open.transport?.close().catch(() => undefined);
          await client.close().catch(() => undefined);
          client = new Client(this.clientInfo, { capabilities: {} });
          await attempt('sse');
        } else throw err;
      }
      if (!current()) {
        await client.close().catch(() => undefined);
        return;
      }
      e.client = client;
      const v = client.getServerVersion();
      if (v) e.serverInfo = { name: String(v.name), version: String(v.version) };
      client.onclose = () => {
        if (!current()) return;
        e.client = null;
        if (e.status === 'connected' || e.status === 'connecting') {
          e.status = 'error';
          e.error = `Connection closed${e.stderr.length ? `: ${e.stderr.slice(-3).join(' · ')}` : ''}`;
          e.tools = [];
          e.sdkTools = [];
          this.notify();
        }
      };
      client.onerror = (err) => console.warn(`[mcp:${e.name}]`, errorText(err));
      try {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          if (!current()) return;
          await this.refreshTools(e, gen).catch((err: unknown) => console.warn(`[mcp:${e.name}] tool list refresh failed:`, errorText(err)));
        });
      } catch {
        /* a server without the capability */
      }
      await this.refreshTools(e, gen);
      if (!current()) return;
      e.status = 'connected';
      this.notify();
    } catch (err) {
      if (!current()) return;
      // A process that exits at once closes the connection before its stderr has been read: give it a moment.
      if (e.transport === 'stdio') await new Promise((r) => setTimeout(r, 200));
      if (!current()) return;
      e.client = null;
      e.status = 'error';
      let text = errorText(err);
      if (/connection closed/i.test(text)) text = e.transport === 'stdio' ? 'The server exited right after starting.' : 'The server closed the connection.';
      e.error = text + (e.stderr.length ? `\n${e.stderr.slice(-4).join('\n')}` : '');
      this.notify();
      await client.close().catch(() => undefined);
    }
  }

  private async makeTransport(e: Entry, kind: 'stdio' | 'http' | 'sse'): Promise<Transport> {
    const c = e.config;
    if (kind === 'stdio') {
      const s = c as Extract<McpServerConfig, { command: string }>;
      const envExtra: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env ?? {})) envExtra[k] = expandEnvRefs(v);
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
      base.PATH = await loginPath();
      const cwd = s.cwd ? path.resolve(this.opts.cwd(), expandHome(expandEnvRefs(s.cwd))) : this.opts.cwd();
      const t = new StdioClientTransport({
        command: expandHome(expandEnvRefs(s.command)),
        args: (s.args ?? []).map((a) => expandHome(expandEnvRefs(a))),
        env: { ...base, ...envExtra },
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        stderr: 'pipe',
      });
      // stderr exists once the process is spawned (inside connect → start); attach on the next tick.
      setImmediate(() => {
        const stream = t.stderr;
        if (!stream) return;
        let buf = '';
        stream.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (!clean) continue;
            e.stderr.push(clean.slice(0, 300));
            if (e.stderr.length > STDERR_LINES) e.stderr.shift();
          }
        });
      });
      return t;
    }
    const h = c as Extract<McpServerConfig, { url: string }>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = expandEnvRefs(v);
    const url = new URL(expandEnvRefs(h.url));
    if (kind === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }) },
      });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  private async refreshTools(e: Entry, gen: number): Promise<void> {
    const client = e.client ?? null;
    if (!client) return;
    const tools: SdkTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    if (e.generation !== gen) return;
    e.sdkTools = tools;
    e.tools = tools.map((t) => ({
      name: t.name,
      fullName: '', // assigned by rebuildIndex (needs the global view for collisions)
      description: String(t.description ?? '').trim(),
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    }));
    this.notify();
  }

  /** Assigns the model-facing names (mcp__server__tool, unique and at most 64 characters) and indexes them. */
  private rebuildIndex(): void {
    this.byFullName.clear();
    for (const e of this.entries.values()) {
      if (e.status !== 'connected' && e.status !== 'connecting') continue;
      e.tools.forEach((info, i) => {
        let base = `mcp__${sanitizeName(e.name)}__${sanitizeName(info.name)}`;
        if (base.length > MAX_TOOL_NAME) base = base.slice(0, MAX_TOOL_NAME);
        let full = base;
        for (let n = 2; this.byFullName.has(full); n++) {
          const suffix = `_${n}`;
          full = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
        }
        info.fullName = full;
        this.byFullName.set(full, { entry: e, tool: e.sdkTools[i], info });
      });
    }
  }

  private async disconnect(e: Entry): Promise<void> {
    e.generation++;
    const client = e.client;
    e.client = null;
    e.tools = [];
    e.sdkTools = [];
    if (client) await client.close().catch(() => undefined);
  }

  /** What the model gets: one Tool per connected server tool, approval included. */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const { entry, tool, info } of this.byFullName.values()) {
      if (entry.status !== 'connected') continue;
      const ref: McpToolRef = { server: entry.name, scope: entry.scope, tool: tool.name, readOnly: info.readOnly, destructive: info.destructive };
      const description = `[${entry.name}] ${info.description || tool.name}`.slice(0, 1024);
      const parameters = (tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }) as Record<string, unknown>;
      out.push({
        name: info.fullName,
        description,
        parameters,
        mcp: ref,
        run: async (args, ctx) => {
          const ok = await ctx.approve(info.fullName, approvalDetail(args));
          if (!ok.ok) return { content: ok.message };
          return this.call(info.fullName, args, ctx.signal);
        },
      });
    }
    return out;
  }

  /** The server and annotations behind a model-facing tool name. */
  lookup(fullName: string): McpToolRef | undefined {
    const hit = this.byFullName.get(fullName);
    if (!hit) return undefined;
    return { server: hit.entry.name, scope: hit.entry.scope, tool: hit.tool.name, readOnly: hit.info.readOnly, destructive: hit.info.destructive };
  }

  async call(fullName: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const hit = this.byFullName.get(fullName);
    if (!hit) throw new Error(`Unknown MCP tool ${fullName}`);
    const client = hit.entry.client;
    if (!client || hit.entry.status !== 'connected') throw new Error(`MCP server "${hit.entry.name}" is not connected (${hit.entry.error ?? hit.entry.status})`);
    const params = { name: hit.tool.name, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> };
    const res = (await client.callTool(params, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, signal })) as CallResult;
    return contentToResult(res);
  }

  /** One line per connected server for the system prompt, or '' when there is none. */
  describe(): string {
    const lines: string[] = [];
    for (const e of this.list()) {
      if (e.status !== 'connected' || !e.tools.length) continue;
      const names = e.tools.map((t) => t.name);
      const shown = names.slice(0, 15).join(', ') + (names.length > 15 ? `, … (${names.length} tools)` : '');
      lines.push(`- ${e.name} (${e.tools.length} tool${e.tools.length === 1 ? '' : 's'}): ${shown}`);
    }
    return lines.join('\n');
  }

  /** Adds servers from what the user typed, persists them and connects. Returns the new list. */
  async add(name: string, spec: string, scope: McpScope, env?: Record<string, string>): Promise<McpServerInfo[]> {
    const configs = parseServerSpec(name, spec, env);
    const cfg = this.opts.getConfig();
    const cwd = this.opts.cwd();
    const existing = scope === 'user' ? Object.keys(cfg.mcpServers ?? {}) : Object.keys(readProjectServers(cwd).servers);
    for (const n of Object.keys(configs)) if (existing.includes(n)) throw new Error(`A ${scope === 'user' ? 'server' : 'project server'} named "${n}" already exists. Remove it first or pick another name.`);
    if (scope === 'user') {
      this.opts.saveConfig({ mcpServers: { ...(cfg.mcpServers ?? {}), ...configs } });
    } else {
      writeProjectServers(cwd, (map) => {
        for (const [n, c] of Object.entries(configs)) map[n] = stripUndefined(c);
      });
      // The user added it themselves: no separate "enable" step.
      const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
      for (const n of Object.keys(configs)) trusted.add(n);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: [...trusted] } });
    }
    await this.reload();
    return this.list();
  }

  async remove(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const cfg = this.opts.getConfig();
    if (scope === 'user') {
      if (!cfg.mcpServers?.[name]) throw new Error(`No server named "${name}".`);
      const next = { ...cfg.mcpServers };
      delete next[name];
      this.opts.saveConfig({ mcpServers: next });
    } else {
      const cwd = this.opts.cwd();
      writeProjectServers(cwd, (map) => {
        if (!(name in map)) throw new Error(`No project server named "${name}".`);
        delete map[name];
      });
      const trusted = (cfg.mcpTrusted?.[cwd] ?? []).filter((n) => n !== name);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: trusted } });
    }
    await this.reload();
    return this.list();
  }

  /** User servers: the disabled flag. Project servers: trusted for this working directory, or not. */
  async setEnabled(name: string, scope: McpScope, enabled: boolean): Promise<McpServerInfo[]> {
    const cfg = this.opts.getConfig();
    if (scope === 'user') {
      const c = cfg.mcpServers?.[name];
      if (!c) throw new Error(`No server named "${name}".`);
      const next = { ...c } as McpServerConfig & { disabled?: boolean };
      if (enabled) delete next.disabled;
      else next.disabled = true;
      this.opts.saveConfig({ mcpServers: { ...cfg.mcpServers, [name]: next } });
    } else {
      const cwd = this.opts.cwd();
      if (!this.entries.has(keyOf('project', name))) throw new Error(`No project server named "${name}" in ${PROJECT_FILE}.`);
      const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
      if (enabled) trusted.add(name);
      else trusted.delete(name);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: [...trusted] } });
    }
    await this.reload();
    return this.list();
  }

  async reconnect(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const e = this.entries.get(keyOf(scope, name));
    if (!e) throw new Error(`No ${scope} server named "${name}".`);
    if (e.status === 'disabled' || e.status === 'blocked') return this.list();
    await this.disconnect(e);
    await this.connect(e);
    return this.list();
  }

  /** Stops every server (app quit). */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    this.byFullName.clear();
    await Promise.allSettled(all.map((e) => this.disconnect(e)));
  }
}

function stripUndefined<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}
