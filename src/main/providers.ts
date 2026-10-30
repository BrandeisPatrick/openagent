import OpenAI from 'openai';
import type { AppConfig, ModelCapabilities } from '../shared/types';
import { ollamaRoot } from './ollama';

export interface ProviderClient {
  client: OpenAI;
  model: string;
  label: string;
}

/**
 * Both Ollama and Portkey expose OpenAI-compatible chat-completions endpoints,
 * so one OpenAI client covers both. Only the base URL and headers differ.
 */
export function makeClient(cfg: AppConfig): ProviderClient {
  if (cfg.provider === 'ollama') {
    const baseURL = cfg.ollama.baseURL || 'http://localhost:11434/v1';
    if (!cfg.ollama.model) throw new Error('No Ollama model selected. Open Settings and pick one (e.g. `ollama pull qwen3:8b`).');
    return {
      client: new OpenAI({ baseURL, apiKey: 'ollama' }),
      model: cfg.ollama.model,
      label: `Ollama · ${cfg.ollama.model}`,
    };
  }

  const p = cfg.portkey;
  const apiKey = p.apiKey || process.env.PORTKEY_API_KEY || '';
  if (!apiKey) throw new Error('Portkey API key is not set. Open Settings and add it, or export PORTKEY_API_KEY.');
  if (!p.model) throw new Error('No Portkey model set. Open Settings and enter one, e.g. @openai/gpt-4o-mini.');

  const headers: Record<string, string> = { 'x-portkey-api-key': apiKey };
  if (p.virtualKey) headers['x-portkey-virtual-key'] = p.virtualKey;
  if (p.provider) headers['x-portkey-provider'] = p.provider;
  if (p.configId) headers['x-portkey-config'] = p.configId;

  return {
    client: new OpenAI({
      baseURL: p.baseURL || 'https://api.portkey.ai/v1',
      // With x-portkey-provider, Portkey forwards this bearer token to the upstream provider.
      // With a virtual key or model-catalog id, the Portkey key itself is enough.
      apiKey: p.providerApiKey || apiKey,
      defaultHeaders: headers,
    }),
    model: p.model,
    label: `Portkey · ${p.model}`,
  };
}

/** What the configured model can do. Ollama reports capabilities from /api/show (0.6+); Portkey models are unknown. */
export async function modelCapabilities(cfg: AppConfig): Promise<ModelCapabilities> {
  if (cfg.provider !== 'ollama') return { provider: cfg.provider, model: cfg.portkey.model, vision: null, tools: null };
  const model = cfg.ollama.model;
  try {
    const res = await fetch(`${ollamaRoot(cfg.ollama.baseURL || 'http://localhost:11434/v1')}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return { provider: 'ollama', model, vision: null, tools: null };
    const data = (await res.json()) as { capabilities?: string[] };
    if (!Array.isArray(data.capabilities)) return { provider: 'ollama', model, vision: null, tools: null };
    return { provider: 'ollama', model, vision: data.capabilities.includes('vision'), tools: data.capabilities.includes('tools') };
  } catch {
    return { provider: 'ollama', model, vision: null, tools: null };
  }
}

/** Lists locally available Ollama models via the native /api/tags endpoint. */
export async function listOllamaModels(baseURL: string): Promise<string[]> {
  const res = await fetch(`${ollamaRoot(baseURL)}/api/tags`);
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).sort();
}
