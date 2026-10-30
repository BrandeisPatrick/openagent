import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, protocol, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AppConfig, ApprovalScope, Bounds, ImageAttachment, McpScope, McpServerInfo, ModelCapabilities, ProjectRules, StoredRules } from '../shared/types';
import { McpManager, PROJECT_FILE } from './mcp';
import { searchFiles } from './files';
import { appendInstruction } from './instructions';
import { ARTIFACT_SCHEME, ArtifactStore } from './artifacts';
import { loadConfig, normalizeConfig, saveConfig, withRecentDir } from './config';
import { BrowserController } from './browser';
import { Agent, PLAN_APPROVED_TEXT } from './agent';
import { diffOf, listChanges, revertChange } from './changes';
import { listOllamaModels, modelCapabilities } from './providers';
import { rewindSession, SessionStore, toMeta, toTranscript } from './sessions';
import { TerminalManager } from './terminal';
import { loadSkills, toInfo } from './skills';

// The app was renamed from OpenCoder: on the first launch after that, the old data folder (settings, sessions,
// artifacts) is carried over so nothing is lost. Runs before anything reads the data folder.
(function carryOverDataFolder(): void {
  const next = app.getPath('userData');
  if (fs.existsSync(path.join(next, 'config.json'))) return; // already set up under the new name
  const prev = ['opencoder', 'OpenCoder'].map((n) => path.join(path.dirname(next), n)).find((p) => fs.existsSync(path.join(p, 'config.json')));
  if (!prev) return;
  fs.mkdirSync(next, { recursive: true });
  for (const entry of ['config.json', 'sessions', 'artifacts']) {
    const from = path.join(prev, entry);
    const to = path.join(next, entry);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
      console.log(`[data] moved ${from} to ${to}`);
    } catch (err) {
      console.warn(`[data] could not move ${from}:`, err);
    }
  }
})();

let config: AppConfig = loadConfig();
let win: BrowserWindow | null = null;
let browser: BrowserController | null = null;
let agent: Agent | null = null;
let store: SessionStore | null = null;
let terminal: TerminalManager | null = null;
let artifacts: ArtifactStore | null = null;
let mcp: McpManager | null = null;
const capabilityCache = new Map<string, ModelCapabilities>();
/** Blocked project MCP servers the user was told about, as "<cwd>:<name>" */
const notifiedBlocked = new Set<string>();

const currentSkills = () => loadSkills(config.workingDirectory, app.getAppPath());

const APP_NAME = 'OpenAgent';
// Packaged builds keep build/icon.png outside the asar (see asarUnpack) so native APIs can read it.
const ICON_PATH = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'build', 'icon.png');

/** Brand the process: Dock icon, menu-bar name and About panel (packaged builds get these from Info.plist). */
function applyBranding(): void {
  app.setName(APP_NAME);
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (process.platform === 'darwin' && !icon.isEmpty()) app.dock?.setIcon(icon);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: ICON_PATH,
    credits: 'Open-source agentic coding assistant with a built-in browser. Runs on Ollama or Portkey.',
  });
}

/** Window chrome colour before the renderer paints; matches the renderer's --bg tokens so launch does not flash. */
function windowBackground(): string {
  const dark = config.theme === 'dark' || (config.theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#262624' : '#faf9f5';
}

function createWindow(): void {
  const icon = nativeImage.createFromPath(ICON_PATH);
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: windowBackground(),
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event as unknown as { level: string; message: string; lineNumber: number; sourceId: string };
    if (level === 'error' || level === 'warning' || process.argv.includes('--dev')) console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const w = win;
  browser = new BrowserController(w, (state) => {
    if (!w.isDestroyed()) w.webContents.send('browser:state', state);
  });
  store ??= new SessionStore(path.join(app.getPath('userData'), 'sessions'));
  terminal ??= new TerminalManager({ dataDir: app.getPath('userData'), cwd: () => config.workingDirectory });
  artifacts ??= new ArtifactStore({ root: path.join(app.getPath('userData'), 'artifacts'), rendererDir: path.join(__dirname, '..', 'renderer') });
  mcp ??= new McpManager({
    getConfig: () => config,
    saveConfig: (patch) => {
      config = normalizeConfig({ ...config, ...patch });
      saveConfig(config);
    },
    cwd: () => config.workingDirectory,
    version: app.getVersion(),
  });
  const term = terminal;
  const servers = mcp;
  const forward = coalesceDeltas((ev) => {
    if (w.isDestroyed()) return;
    w.webContents.send('agent:event', ev);
    notifyInBackground(w, ev);
  });
  agent = new Agent(() => config, browser, store, currentSkills, forward, term, artifacts, servers);
  const onServers = (list: McpServerInfo[]) => {
    if (w.isDestroyed()) return;
    w.webContents.send('mcp:servers', list);
    // Project servers never run until the user enables them: say so once per server.
    const fresh = list.filter((s) => s.status === 'blocked' && !notifiedBlocked.has(`${config.workingDirectory}:${s.name}`));
    if (!fresh.length || w.webContents.isLoading()) return;
    for (const s of fresh) notifiedBlocked.add(`${config.workingDirectory}:${s.name}`);
    const names = fresh.map((s) => s.name).join(', ');
    sendEvent({ type: 'error', kind: 'notice', message: `${PROJECT_FILE} in this project defines ${fresh.length === 1 ? 'an MCP server' : `${fresh.length} MCP servers`} (${names}) that ${fresh.length === 1 ? 'is' : 'are'} not enabled yet. Review and enable ${fresh.length === 1 ? 'it' : 'them'} in Settings → MCP servers.` });
  };
  servers.on('servers', onServers);
  w.webContents.once('did-finish-load', () => onServers(servers.list()));
  void servers.reload().catch((err: unknown) => console.warn('[mcp] reload failed:', err));
  const onTermData = (id: string, data: string) => {
    if (!w.isDestroyed()) w.webContents.send('terminal:data', id, data);
  };
  const onTermTabs = (tabs: unknown) => {
    if (!w.isDestroyed()) w.webContents.send('terminal:tabs', tabs);
  };
  term.on('data', onTermData);
  term.on('tabs', onTermTabs);
  w.on('focus', () => app.dock?.setBadge(''));
  w.on('closed', () => {
    term.off('data', onTermData);
    term.off('tabs', onTermTabs);
    servers.off('servers', onServers);
    agent?.stop();
    win = null;
    browser = null;
    agent = null;
  });
}

/**
 * Merges runs of text_delta / thinking_delta events into one message every 30 ms. A local model emits a token
 * every few milliseconds; one IPC message and one renderer update per token is wasted work nobody can see.
 * Any other event flushes what is pending first, so the order is kept.
 */
function coalesceDeltas(send: (ev: AgentEvent) => void): (ev: AgentEvent) => void {
  let pending: { type: 'text_delta' | 'thinking_delta'; text: string } | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const p = pending;
      pending = null;
      send(p);
    }
  };
  return (ev) => {
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
      if (pending && pending.type === ev.type) {
        pending.text += ev.text;
        return;
      }
      flush();
      pending = { type: ev.type, text: ev.text };
      timer = setTimeout(flush, 30);
      return;
    }
    flush();
    send(ev);
  };
}

function sendEvent(ev: AgentEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
}

/** A macOS notification (and a Dock bounce/badge) when a run ends or waits for the user while the window is in the background. */
function notifyInBackground(w: BrowserWindow, ev: AgentEvent): void {
  if (!config.notifications || w.isFocused() || !Notification.isSupported()) return;
  let title: string;
  let body: string;
  if (ev.type === 'run_end') {
    if (ev.reason === 'aborted') return;
    title = ev.reason === 'error' ? 'OpenAgent hit an error' : ev.reason === 'plan' ? 'OpenAgent has a plan for you' : ev.reason === 'max_turns' ? 'OpenAgent stopped at the turn limit' : 'OpenAgent finished';
    body = agent?.session.title ?? '';
  } else if (ev.type === 'approval_request') {
    title = 'OpenAgent needs your approval';
    body = ev.detail.split('\n')[0].slice(0, 120);
    app.dock?.setBadge('1');
  } else return;
  try {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      if (w.isDestroyed()) return;
      w.show();
      w.focus();
    });
    n.show();
    app.dock?.bounce('informational');
  } catch (err) {
    console.warn('[notify] failed:', err);
  }
}

/** The saved approval rules of the current working directory. */
function projectRules(): ProjectRules {
  const cwd = config.workingDirectory;
  const r: StoredRules = config.allowRules?.[cwd] ?? {};
  return { cwd, programs: [...(r.programs ?? [])], reasons: [...(r.reasons ?? [])], edits: r.edits === true, mcp: [...(r.mcp ?? [])] };
}

function saveProjectRules(update: (r: StoredRules) => StoredRules): ProjectRules {
  const cwd = config.workingDirectory;
  const next = update({ ...(config.allowRules?.[cwd] ?? {}) });
  const rules = { ...(config.allowRules ?? {}) };
  if (!next.programs?.length && !next.reasons?.length && !next.mcp?.length && !next.edits) delete rules[cwd];
  else rules[cwd] = next;
  config = normalizeConfig({ ...config, allowRules: rules });
  saveConfig(config);
  return projectRules();
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, next: AppConfig) => {
    const before = config;
    const result = applyConfig(next);
    if (before.workingDirectory !== config.workingDirectory) {
      void mcp?.reload().catch((err: unknown) => console.warn('[mcp] reload failed:', err));
      agent?.emitContext();
    }
    if (before.provider !== config.provider || before.ollama.model !== config.ollama.model || before.ollama.numCtx !== config.ollama.numCtx || before.portkey.model !== config.portkey.model || before.portkey.contextWindow !== config.portkey.contextWindow || before.autoCompact !== config.autoCompact) agent?.emitContext();
    return result;
  });
  const applyConfig = (next: AppConfig) => {
    // MCP servers and trust are changed through the mcp:* handlers only: a stale copy sent with the rest of the settings must not undo them.
    const merged = { ...config, ...next, ollama: { ...config.ollama, ...next.ollama }, portkey: { ...config.portkey, ...next.portkey }, mcpServers: config.mcpServers, mcpTrusted: config.mcpTrusted, allowRules: config.allowRules, recentDirs: config.recentDirs };
    if (merged.workingDirectory !== config.workingDirectory) merged.recentDirs = withRecentDir(config.recentDirs, merged.workingDirectory, config.workingDirectory);
    // A caller that only flipped the legacy flag still gets the matching mode.
    if (next.permissionMode === undefined && next.autoApprove !== undefined && next.autoApprove !== config.autoApprove) merged.permissionMode = next.autoApprove ? 'bypass' : 'ask';
    config = normalizeConfig(merged);
    saveConfig(config);
    return config;
  };
  ipcMain.handle('cwd:choose', async () => {
    const chosen = await chooseCwd();
    if (chosen !== null) void mcp?.reload().catch((err: unknown) => console.warn('[mcp] reload failed:', err));
    return chosen;
  });
  const chooseCwd = async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: config.workingDirectory });
    if (res.canceled || !res.filePaths[0]) return null;
    config = { ...config, workingDirectory: res.filePaths[0], recentDirs: withRecentDir(config.recentDirs, res.filePaths[0], config.workingDirectory) };
    saveConfig(config);
    agent?.emitContext();
    return config.workingDirectory;
  };
  ipcMain.handle('models:list', async () => listOllamaModels(config.ollama.baseURL));

  ipcMain.handle('chat:send', (_e, text: string, attachments?: unknown) => {
    if (!agent) return { ok: false, error: 'No window' };
    let images: ImageAttachment[];
    try {
      images = validateAttachments(attachments);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const message = String(text ?? '');
    if (!message.trim() && !images.length) return { ok: false, error: 'Nothing to send.' };
    if (agent.compacting) return { ok: false, error: 'The context is being compacted; send the message again in a moment.' };
    if (agent.running) {
      const queued = agent.enqueue(message, images);
      return { ok: true, queued: true, id: queued.id };
    }
    agent.run(message, images).catch((err: unknown) => console.error('[agent] run failed', err));
    return { ok: true };
  });
  ipcMain.handle('chat:unqueue', (_e, id: string) => agent?.unqueue(String(id)) ?? false);
  ipcMain.handle('chat:queue', () => agent?.queue() ?? []);
  ipcMain.handle('models:capabilities', async () => {
    const key = `${config.provider}|${config.provider === 'ollama' ? `${config.ollama.baseURL}|${config.ollama.model}` : config.portkey.model}`;
    const cached = capabilityCache.get(key);
    if (cached) return cached;
    const caps = await modelCapabilities(config);
    if (caps.vision !== null) capabilityCache.set(key, caps);
    return caps;
  });
  ipcMain.handle('chat:abort', () => agent?.stop());
  ipcMain.handle('chat:compact', (_e, focus?: string) => (agent ? agent.compactNow(String(focus ?? '').trim() || undefined) : { ok: false, error: 'No window' }));
  ipcMain.handle('chat:context', () => agent?.contextInfo() ?? null);

  const mcpList = () => mcp?.list() ?? [];
  const requireMcp = () => {
    if (!mcp) throw new Error('No window');
    return mcp;
  };
  ipcMain.handle('mcp:list', () => mcpList());
  ipcMain.handle('mcp:add', (_e, name: string, spec: string, scope: McpScope, env?: unknown) => {
    const cleanEnv: Record<string, string> = {};
    if (env && typeof env === 'object' && !Array.isArray(env)) for (const [k, v] of Object.entries(env as Record<string, unknown>)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) cleanEnv[k] = String(v);
    return requireMcp().add(String(name ?? ''), String(spec ?? ''), scope === 'project' ? 'project' : 'user', cleanEnv);
  });
  ipcMain.handle('mcp:remove', (_e, name: string, scope: McpScope) => requireMcp().remove(String(name), scope === 'project' ? 'project' : 'user'));
  ipcMain.handle('mcp:set-enabled', (_e, name: string, scope: McpScope, enabled: boolean) => requireMcp().setEnabled(String(name), scope === 'project' ? 'project' : 'user', Boolean(enabled)));
  ipcMain.handle('mcp:reconnect', (_e, name: string, scope: McpScope) => requireMcp().reconnect(String(name), scope === 'project' ? 'project' : 'user'));

  const requireIdle = () => {
    if (!agent || !store) throw new Error('No window');
    if (agent.running) throw new Error('Stop the current run before switching conversations.');
    return { agent, store };
  };
  ipcMain.handle('sessions:list', () => store?.list() ?? []);
  ipcMain.handle('sessions:current', () => (agent ? toMeta(agent.session) : null));
  ipcMain.handle('sessions:create', () => {
    const { agent: a, store: st } = requireIdle();
    a.session = st.create();
    a.emitContext();
    return toMeta(a.session);
  });
  ipcMain.handle('sessions:fork', (_e, id?: string) => {
    const { agent: a, store: st } = requireIdle();
    const from = st.get(id ?? a.session.id);
    a.session = st.fork(id ?? a.session.id);
    if (from && artifacts) {
      artifacts.copy(from, a.session);
      st.save(a.session, false);
    }
    return toMeta(a.session);
  });
  ipcMain.handle('sessions:switch', (_e, id: string) => {
    const { agent: a, store: st } = requireIdle();
    const s = st.get(id);
    if (!s) throw new Error(`No conversation ${id}`);
    a.session = s;
    a.emitContext();
    return toTranscript(s);
  });
  ipcMain.handle('sessions:rewind', (_e, turn: number) => {
    const { agent: a, store: st } = requireIdle();
    const s = a.session;
    const out = rewindSession(s, config.workingDirectory, Math.floor(Number(turn)));
    st.save(s, false);
    a.notifyChanges();
    a.emitContext();
    const meta = toMeta(s);
    sendEvent({ type: 'session_changed', session: meta });
    return { transcript: toTranscript(s), session: meta, ...out };
  });
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    const { agent: a, store: st } = requireIdle();
    st.delete(id);
    artifacts?.remove(id);
    if (a.session.id === id) a.session = st.create();
    return toMeta(a.session);
  });
  // Allowed during a run: the store hands out the same Session object the agent holds, so the run's own saves keep the new title.
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    if (!store) throw new Error('No window');
    const meta = toMeta(store.rename(String(id), String(title ?? '')));
    sendEvent({ type: 'session_changed', session: meta });
    return meta;
  });
  ipcMain.handle('skills:list', () => currentSkills().map(toInfo));
  ipcMain.handle('files:search', (_e, query: string, limit?: number) => searchFiles(config.workingDirectory, String(query ?? ''), Number(limit) || 50));
  ipcMain.handle('instructions:append', (_e, text: string) => appendInstruction(config.workingDirectory, String(text ?? '')));
  ipcMain.handle('rules:list', () => projectRules());
  ipcMain.handle('rules:remove', (_e, kind: string, value?: string) =>
    saveProjectRules((r) => {
      const v = String(value ?? '');
      if (kind === 'program') r.programs = (r.programs ?? []).filter((p) => p !== v);
      else if (kind === 'reason') r.reasons = (r.reasons ?? []).filter((p) => p !== v);
      else if (kind === 'mcp') r.mcp = (r.mcp ?? []).filter((p) => p !== v);
      else if (kind === 'edits') delete r.edits;
      return r;
    }),
  );
  ipcMain.handle('approval:response', (_e, id: string, ok: boolean, always?: boolean, scope?: ApprovalScope) => {
    const outcome = agent?.resolveApproval(String(id), Boolean(ok), Boolean(always), scope === 'project' ? 'project' : 'session') ?? {};
    if (outcome.setMode) {
      config = normalizeConfig({ ...config, permissionMode: outcome.setMode });
      saveConfig(config);
    }
    const rule = outcome.rule;
    if (rule) {
      saveProjectRules((r) => {
        const add = (list: string[] | undefined) => [...new Set([...(list ?? []), ...rule.values])];
        if (rule.kind === 'program') r.programs = add(r.programs);
        else if (rule.kind === 'reason') r.reasons = add(r.reasons);
        else if (rule.kind === 'mcp') r.mcp = add(r.mcp);
        else if (rule.kind === 'edits') r.edits = true;
        return r;
      });
    }
    return config;
  });
  ipcMain.handle('plan:respond', (_e, id: string, decision: string) => {
    if (!agent || !store) throw new Error('No window');
    if (agent.running) throw new Error('Wait for the current run to finish before deciding on the plan.');
    if (decision !== 'build-ask' && decision !== 'build-acceptEdits' && decision !== 'keep') throw new Error(`Unknown plan decision ${decision}`);
    agent.respondPlan(String(id), decision);
    if (decision !== 'keep') {
      config = normalizeConfig({ ...config, permissionMode: decision === 'build-ask' ? 'ask' : 'acceptEdits' });
      saveConfig(config);
    }
    sendEvent({ type: 'session_changed', session: toMeta(agent.session) });
    if (decision !== 'keep') agent.run(PLAN_APPROVED_TEXT).catch((err: unknown) => console.error('[agent] build run failed', err));
  });

  const current = () => {
    if (!agent) throw new Error('No window');
    return { session: agent.session, cwd: config.workingDirectory };
  };
  ipcMain.handle('changes:list', () => {
    const { session, cwd } = current();
    return listChanges(session, cwd);
  });
  ipcMain.handle('changes:diff', (_e, p: string) => {
    const { session, cwd } = current();
    return diffOf(session, cwd, String(p));
  });
  ipcMain.handle('changes:revert', async (_e, p: string) => {
    const { session, cwd } = current();
    const list = await revertChange(session, cwd, String(p));
    sendEvent({ type: 'changes_updated', count: list.length });
    return list;
  });
  ipcMain.handle('changes:open', async (_e, p: string) => {
    const err = await shell.openPath(String(p));
    if (err) throw new Error(err);
  });

  const artifactOf = (id: string) => {
    if (!agent || !artifacts) throw new Error('No window');
    const info = artifacts.get(agent.session, String(id));
    if (!info) throw new Error(`No artifact ${id} in this conversation.`);
    return info;
  };
  ipcMain.handle('artifacts:list', () => (agent && artifacts ? artifacts.list(agent.session) : []));
  ipcMain.handle('artifacts:content', (_e, id: string) => artifacts!.content(agent!.session, String(id)));
  ipcMain.handle('artifacts:open', async (_e, id: string) => {
    const info = artifactOf(id);
    await browser?.navigate(info.url);
  });
  ipcMain.handle('artifacts:save-as', async (_e, id: string) => {
    const info = artifactOf(id);
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(info.path)) });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.copyFile(info.path, res.filePath);
    return res.filePath;
  });
  ipcMain.handle('artifacts:reveal', (_e, id: string) => shell.showItemInFolder(artifactOf(id).path));

  ipcMain.handle('terminal:list', () => terminal?.list() ?? []);
  ipcMain.handle('terminal:create', (_e, cols: number, rows: number) => {
    if (!terminal) throw new Error('No terminal');
    return terminal.create(Number(cols), Number(rows), false);
  });
  ipcMain.handle('terminal:history', (_e, id: string) => terminal?.history(String(id)) ?? '');
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminal?.write(String(id), String(data)));
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => terminal?.resize(String(id), Number(cols), Number(rows)));
  ipcMain.handle('terminal:close', (_e, id: string) => terminal?.close(String(id)));

  ipcMain.on('browser:bounds', (_e, b: Bounds) => browser?.setBounds(b));
  ipcMain.on('browser:visible', (_e, v: boolean) => browser?.setVisible(Boolean(v)));
  ipcMain.handle('browser:navigate', (_e, url: string) => browser?.navigate(String(url)));
  ipcMain.handle('browser:back', () => browser?.navigate('back'));
  ipcMain.handle('browser:forward', () => browser?.navigate('forward'));
  ipcMain.handle('browser:reload', () => browser?.reload());
  ipcMain.handle('browser:state', () => browser?.state());
  ipcMain.handle('browser:open-external', async (_e, url?: string) => {
    const target = (typeof url === 'string' && url.trim() ? url.trim() : browser?.state().url) ?? '';
    if (!target || target === 'about:blank') return;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      console.warn('[browser] not opening an invalid URL externally:', target);
      return;
    }
    if (parsed.protocol === `${ARTIFACT_SCHEME}:`) {
      // An artifact: open the stored file with the default app (a browser for HTML) instead of the viewer URL.
      const r = artifacts?.resolve(parsed.href);
      const file = r?.kind === 'file' ? r.path : agent && artifacts ? artifacts.get(agent.session, parsed.pathname.split('/').filter(Boolean)[1] ?? '')?.path : undefined;
      if (file) await shell.openPath(file).catch((err: unknown) => console.warn('[artifact] openPath failed:', err));
      return;
    }
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      console.warn('[browser] only http, https and file URLs open externally, not', parsed.protocol);
      return;
    }
    await shell.openExternal(parsed.href).catch((err: unknown) => console.warn('[browser] openExternal failed:', err));
  });
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 8;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Only well-formed, bounded image attachments reach the model. */
function validateAttachments(raw: unknown): ImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be a list');
  if (raw.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
  return raw.map((a, i) => {
    const x = a as Partial<ImageAttachment>;
    const mime = String(x.mime ?? '');
    const dataUrl = String(x.dataUrl ?? '');
    if (!IMAGE_MIMES.has(mime)) throw new Error(`Attachment ${i + 1}: unsupported image type ${mime || '(none)'}.`);
    if (!dataUrl.startsWith(`data:${mime};base64,`)) throw new Error(`Attachment ${i + 1}: not a ${mime} data URL.`);
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) throw new Error(`Attachment ${i + 1} is too large (limit 4 MB).`);
    return {
      id: String(x.id ?? `img-${i + 1}`).slice(0, 64),
      name: String(x.name ?? 'image').slice(0, 200),
      mime,
      dataUrl,
      width: Math.max(0, Math.floor(Number(x.width) || 0)),
      height: Math.max(0, Math.floor(Number(x.height) || 0)),
      size: Math.max(0, Math.floor(Number(x.size) || 0)),
    };
  });
}

app.setName(APP_NAME);
// Artifacts are served on their own scheme so the viewer can load the app's modules like a normal page.
protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(() => {
  applyBranding();
  protocol.handle(ARTIFACT_SCHEME, async (req) => {
    const r = artifacts?.resolve(req.url);
    if (!r) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (r.kind === 'page') return new Response(r.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return net.fetch(pathToFileURL(r.path).href);
  });
  buildMenu();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  terminal?.closeAll();
  void mcp?.close();
});
