import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, PermissionMode } from '../shared/types';

/** Bumped when stored values change meaning: v2 renamed the old "auto" (run everything) to "bypass" and "readonly" to "plan". */
const SCHEMA_VERSION = 2;
const MODES: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];

export function defaultConfig(): AppConfig {
  return {
    provider: 'ollama',
    ollama: {
      baseURL: process.env.OLLAMA_HOST ? normalizeOllamaHost(process.env.OLLAMA_HOST) : 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      numCtx: 16384,
      think: 'auto',
    },
    portkey: {
      baseURL: 'https://api.portkey.ai/v1',
      apiKey: '',
      model: '@openai/gpt-4o-mini',
      virtualKey: '',
      provider: '',
      providerApiKey: '',
      configId: '',
      contextWindow: 128000,
    },
    workingDirectory: os.homedir(),
    permissionMode: 'ask',
    autoApprove: false,
    maxTurns: 40,
    sendScreenshotsToModel: false,
    systemPromptExtra: '',
    theme: 'system',
    autoTitles: true,
    mcpServers: {},
    mcpTrusted: {},
    autoCompact: true,
    notifications: true,
    allowRules: {},
  };
}

function normalizeOllamaHost(host: string): string {
  let h = host.trim();
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '') + '/v1';
}

export function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Maps a stored mode (any version) to a current one. */
export function migrateMode(raw: unknown, autoApprove: unknown, schemaVersion: number): PermissionMode {
  let mode = typeof raw === 'string' ? raw : autoApprove ? 'bypass' : 'ask';
  if (mode === 'readonly') mode = 'plan';
  if (schemaVersion < SCHEMA_VERSION && mode === 'auto') mode = 'bypass'; // "auto" used to mean "run everything"
  return (MODES as string[]).includes(mode) ? (mode as PermissionMode) : 'ask';
}

export function loadConfig(): AppConfig {
  const d = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<AppConfig> & { schemaVersion?: number };
    const version = Number(raw.schemaVersion) || 1;
    delete raw.schemaVersion;
    return normalizeConfig({
      ...d,
      ...raw,
      permissionMode: migrateMode(raw.permissionMode, raw.autoApprove, version),
      // Settings files written before generated titles existed have no flag: on by default.
      autoTitles: raw.autoTitles ?? d.autoTitles,
      autoCompact: raw.autoCompact ?? d.autoCompact,
      notifications: raw.notifications ?? d.notifications,
      allowRules: raw.allowRules && typeof raw.allowRules === 'object' && !Array.isArray(raw.allowRules) ? raw.allowRules : {},
      mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {},
      mcpTrusted: raw.mcpTrusted && typeof raw.mcpTrusted === 'object' && !Array.isArray(raw.mcpTrusted) ? raw.mcpTrusted : {},
      ollama: { ...d.ollama, ...(raw.ollama ?? {}) },
      portkey: { ...d.portkey, ...(raw.portkey ?? {}) },
    });
  } catch {
    return d;
  }
}

/** Keeps the legacy autoApprove flag consistent with permissionMode, and autoTitles a boolean (default on). */
export function normalizeConfig(cfg: AppConfig): AppConfig {
  const mode: PermissionMode = (MODES as string[]).includes(cfg.permissionMode) ? cfg.permissionMode : 'ask';
  return { ...cfg, permissionMode: mode, autoApprove: mode === 'bypass', autoTitles: cfg.autoTitles !== false };
}

export function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, schemaVersion: SCHEMA_VERSION }, null, 2));
}
