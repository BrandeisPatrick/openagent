import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { AgentEvent, AppConfig, ApprovalScope, ArtifactInfo, CompactionInfo, ContextInfo, ImageAttachment, PermissionMode, PlanInfo, QueuedMessage, TaskItem } from '../shared/types';
import { expandMentions } from './mentions';
import { makeClient, modelCapabilities } from './providers';
import { contextSize, ollamaChat, ollamaComplete, type Usage } from './ollama';
import { McpManager } from './mcp';
import { COMPACT_THRESHOLD, cleanSummary, compactedPreamble, estimateSpecTokens, estimateTokens, summaryBudgetChars, summaryRequest } from './compact';
import { instructionsPrompt, loadInstructions } from './instructions';
import { allTools, toSpec, type ApprovalResult, type Tool, type ToolContext, type ToolResult } from './tools';
import { truncate } from './tools/types';
import type { BrowserController } from './browser';
import { expandSlashCommand, type Skill } from './skills';
import { clip, toMeta, turnSnapshot, type Session, type SessionStore, type Turn } from './sessions';
import { generateTitle, titlePrompt } from './titles';
import { guardCommand, guardWrite, isReadOnlyCommand, programsOf } from './guard';
import { TerminalManager } from './terminal';
import { ArtifactStore, type ArtifactInput } from './artifacts';
import os from 'node:os';
import path from 'node:path';
import { listChanges, snapshotBeforeChange } from './changes';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** The user turn that starts the build after a plan is approved. */
export const PLAN_APPROVED_TEXT = 'Plan approved. Implement it now, step by step. When done, summarise what changed.';

const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const PLAN_EDIT_BLOCKED = 'Not permitted in plan mode: describe this step in your plan instead.';
const PLAN_CMD_BLOCKED = 'Not permitted in plan mode: only read-only commands (ls, cat, grep, git status/log/diff …) run while planning. Describe this step in your plan instead.';
const PLAN_MCP_BLOCKED = 'Not permitted in plan mode: this MCP tool is not marked read-only. Describe this step in your plan instead.';
const SUMMARY_TIMEOUT_MS = 240_000;
const MIN_COMPACT_MESSAGES = 2;

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'terminal_run']);

/** The context window the configured model has, in tokens. */
export function contextLimit(cfg: AppConfig): number {
  if (cfg.provider === 'ollama') return contextSize(cfg.ollama.numCtx);
  return Math.max(4096, Number(cfg.portkey.contextWindow) || 128000);
}

function systemPrompt(cfg: AppConfig, skills: Skill[], mcp: McpManager | null): string {
  const base = `You are OpenAgent, an autonomous coding agent running on the user's Mac.
Working directory: ${cfg.workingDirectory}
Today: ${new Date().toISOString().slice(0, 10)}

You have tools for the filesystem (read_file, write_file, edit_file, list_directory, glob, grep), a shell (bash), a built-in browser pane that the user can see next to the chat (browser_* tools), the Terminal pane next to the chat (terminal_* tools), and create_artifact for deliverables shown in the browser pane.

How to work:
- Act with tools instead of guessing. Explore with glob/grep/read_file before editing. Read a file before you edit it, and prefer edit_file for targeted changes.
- Use bash for builds, tests and git. Commands must be non-interactive.
- Terminal pane: terminal_run types a command into a shell tab the user can see and keeps it running (dev servers, watchers, anything they should watch or take over); terminal_read shows what a tab prints later or what the user ran there; terminal_list and terminal_stop manage the tabs. Prefer bash for one-off commands.
- Artifacts: when the result is something to look at or hand over rather than a project file (a web page or small app, an SVG diagram, a report or document in Markdown, a standalone code sample), call create_artifact with the complete content; it opens in the Browser pane. Update it by calling create_artifact again with its id and the full new content. Images the user attaches to a message are visible to you if the model supports vision; describe or use them as asked. Never append "/think", "/no_think" or similar switches to commands, file contents or tool arguments.
- Browser: browser_navigate to a URL, then act by visible text: browser_click with text ("Sign in") and browser_type with field (the field's label or placeholder). When text is ambiguous, browser_read_page lists elements with refs (ref_N) you can pass instead; refs change after navigation, so read the page again after it changes. Use browser_get_text to read article-style pages, browser_wait_for when a page needs a moment to update, and browser_screenshot when layout matters.
- Keep going until the task is complete, then finish with a short summary of what you did and what you found. Do not ask questions you can answer with a tool.
- If a tool reports that an action was not permitted, do not retry it; explain what you would have done and continue with what you can do.
- Skills: a <skill> block in a user message holds instructions for that request; follow them. Only load a skill with the skill tool when the user invoked it with /name or the task clearly matches its description, never as a substitute for finishing the task.
- Mentions: when the user writes @path, that file's contents (or a folder's listing) follow their message in a <file> block; treat it as the current contents of that file and do not read it again unless the block says it was cut short.
- Tasks: for work with several steps, keep a short task list with update_tasks (the whole list each time, one item in_progress) so the user can follow along; skip it for quick answers.`;
  const skillList = skills.length
    ? `\n\nAvailable skills:\n${skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')}`
    : '';
  let modeText = '';
  if (cfg.permissionMode === 'plan') {
    modeText = `\n\nPLAN MODE: you are planning, not building. Explore with read_file, glob, grep, list_directory, read-only shell commands (ls, cat, git status/log/diff …) and the browser. Do not change files and do not run commands that change anything; write_file and edit_file are unavailable. When you understand the task, call submit_plan exactly once with a concise Markdown plan: the goal, numbered steps naming the files to touch, how to verify, and open questions. Then stop; the user decides whether to build it.`;
  } else if (cfg.permissionMode === 'auto') {
    modeText = `\n\nYou run with automatic approval. A few risky actions (sudo, destructive git, writes outside the working directory, publishing, …) are paused for the user to review.`;
  }
  const servers = mcp?.describe() ?? '';
  const mcpText = servers
    ? `\n\nMCP servers provide extra tools named mcp__<server>__<tool> (their descriptions say what they do). Use them when they fit the task; the user approves calls that can change something.\n${servers}`
    : '';
  const extra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  const instructions = instructionsPrompt(loadInstructions(cfg.workingDirectory));
  return base + skillList + mcpText + modeText + extra + instructions;
}

/** A user message: plain text, or text plus image parts when images are attached. */
function userMessage(text: string, attachments: ImageAttachment[]): Msg {
  if (!attachments.length) return { role: 'user', content: text };
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return { role: 'user', content: parts };
}

function noToolsNotice(model: string): string {
  return `${model} does not support tools, so this run is a plain chat: it can see your message and images but cannot read files, run commands or browse.`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Folds one chunk's usage into the running counts (gateways may repeat or split the counts across chunks). */
function mergeUsage(prev: Usage | null, u: { prompt_tokens?: number; completion_tokens?: number }): Usage {
  return {
    promptTokens: Math.max(prev?.promptTokens ?? 0, Number(u.prompt_tokens) || 0),
    completionTokens: Math.max(prev?.completionTokens ?? 0, Number(u.completion_tokens) || 0),
  };
}

/** What answering an approval card changes besides the pending call: a mode switch, or a rule to save for the project. */
export interface ApprovalOutcome {
  setMode?: PermissionMode;
  rule?: { kind: 'program' | 'reason' | 'edits' | 'mcp'; values: string[] };
}

interface PendingApproval {
  resolve: (r: ApprovalResult) => void;
  name: string;
  programs: string[];
  reason: string | null;
}

export class Agent {
  session: Session;
  private abortController: AbortController | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Per session: programs ("git", "npm") the user allowed for the rest of the session. */
  private allowedPrograms = new Map<string, Set<string>>();
  /** Per session: guard reasons ("uses sudo") the user allowed for the rest of the session. */
  private allowedReasons = new Map<string, Set<string>>();
  /** Set by submit_plan during a run so the loop ends with reason 'plan'. */
  private planSubmitted = false;
  /** Sessions whose title generation has started: one attempt per session, never two at once. */
  private titleAttempts = new Set<string>();
  /** base URL + model pairs that rejected stream_options; they stream without usage. */
  private noStreamUsage = new Set<string>();
  /** Ollama base URL + model → whether the model accepts tools (vision-only models do not); unknown until checked */
  private toolSupport = new Map<string, boolean>();
  /** Per session: MCP servers the user allowed for the rest of the session. */
  private mcpAllowed = new Map<string, Set<string>>();
  /** Tokens the tool specs take on every request (measured at the start of each run). */
  private specTokens = 2500;
  /** Usage of the most recent model call, for the context estimate. */
  private lastUsage: Usage | null = null;
  /** Set when an automatic compaction failed during this run, so it is not retried every turn. */
  private autoCompactFailed = false;
  /** Message count right after the last compaction of this run: no second one until the conversation grew again */
  private compactedAt = -1;
  /** Sessions told that the window is too small for the prompt and tools (once each) */
  private smallWindowNoticed = new Set<string>();
  /** The checkpoint that file changes are recorded on during a run (the latest user message) */
  private currentTurn: Turn | null = null;
  running = false;
  /** True while /compact runs outside a run (stop() cancels it). */
  compacting = false;

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly browser: BrowserController,
    private readonly store: SessionStore,
    private readonly getSkills: () => Skill[],
    private readonly emit: (ev: AgentEvent) => void,
    terminal?: TerminalManager,
    artifacts?: ArtifactStore,
    mcp?: McpManager,
  ) {
    this.session = store.create();
    this.mcp = mcp ?? null;
    this.terminal = terminal ?? new TerminalManager({ dataDir: path.join(os.tmpdir(), 'openagent'), cwd: () => this.getConfig().workingDirectory });
    this.artifacts = artifacts ?? new ArtifactStore({ root: path.join(os.tmpdir(), 'openagent', 'artifacts'), rendererDir: path.join(__dirname, '..', 'renderer') });
  }

  /** The Terminal pane's tabs, shared with the window's IPC handlers */
  readonly terminal: TerminalManager;
  /** Artifact files per session, shared with the window's IPC handlers and the artifact:// protocol */
  readonly artifacts: ArtifactStore;
  /** MCP servers whose tools join the built-in ones (null in tests without any) */
  readonly mcp: McpManager | null;
  /** Messages sent while a run was in progress; delivered before the model's next turn */
  private queued: QueuedMessage[] = [];

  stop(): void {
    this.abortController?.abort();
    for (const p of this.pendingApprovals.values()) p.resolve({ ok: false, message: 'Tool call was interrupted before it produced a result.' });
    this.pendingApprovals.clear();
  }

  /**
   * Answers an approval card. With `always`, the user does not want to be asked again this session for this kind of
   * action: a flagged reason or a command's programs are allow-listed; for edits in ask mode the caller switches the
   * mode to acceptEdits (returned as `setMode`).
   */
  resolveApproval(id: string, ok: boolean, always = false, scope: ApprovalScope = 'session'): ApprovalOutcome {
    const p = this.pendingApprovals.get(id);
    if (!p) return {};
    this.pendingApprovals.delete(id);
    const out: ApprovalOutcome = {};
    if (ok && always) {
      const isMcp = p.name.startsWith('mcp__') && !!p.programs[0];
      const isCmd = p.name === 'bash' || p.name === 'terminal_run';
      const isEdit = p.name === 'write_file' || p.name === 'edit_file';
      // The session sets cover the rest of this run either way; a project rule is persisted by the caller as well.
      if (isMcp) this.sessionSet(this.mcpAllowed).add(p.programs[0]);
      else if (p.reason) this.sessionSet(this.allowedReasons).add(p.reason);
      else if (isCmd) for (const prog of p.programs) this.sessionSet(this.allowedPrograms).add(prog);
      if (scope === 'project') {
        if (isMcp) out.rule = { kind: 'mcp', values: [p.programs[0]] };
        else if (p.reason) out.rule = { kind: 'reason', values: [p.reason] };
        else if (isCmd) out.rule = { kind: 'program', values: p.programs };
        else if (isEdit) out.rule = { kind: 'edits', values: [] };
      } else if (isEdit && this.getConfig().permissionMode === 'ask') out.setMode = 'acceptEdits';
    }
    p.resolve(ok ? { ok: true } : { ok: false, message: DENIED });
    return out;
  }

  private sessionSet(map: Map<string, Set<string>>): Set<string> {
    let s = map.get(this.session.id);
    if (!s) {
      s = new Set();
      map.set(this.session.id, s);
    }
    return s;
  }

  /** Decides, per permission mode, whether an action runs, asks, or is refused. */
  private requestApproval(name: string, detail: string, target?: string): Promise<ApprovalResult> {
    const cfg = this.getConfig();
    const mode = cfg.permissionMode;
    const cwd = cfg.workingDirectory;
    const isEdit = name === 'write_file' || name === 'edit_file';
    const isCmd = name === 'bash' || name === 'terminal_run';
    const allow = Promise.resolve<ApprovalResult>({ ok: true });
    const refuse = (message: string) => Promise.resolve<ApprovalResult>({ ok: false, message });
    if (mode === 'bypass') return allow;
    const rules = cfg.allowRules?.[cwd];
    const ref = this.mcp?.lookup(name);
    if (ref) {
      // MCP tools: read-only ones run everywhere; the rest ask once per server (auto mode asks only for destructive ones).
      if (mode === 'plan') return ref.readOnly ? allow : refuse(PLAN_MCP_BLOCKED);
      if (ref.readOnly || this.sessionSet(this.mcpAllowed).has(ref.server) || rules?.mcp?.includes(ref.server)) return allow;
      if (mode === 'auto') return ref.destructive ? this.ask(name, detail, mode, 'destructive MCP tool', [ref.server]) : allow;
      return this.ask(name, detail, mode, null, [ref.server]);
    }
    if (mode === 'plan') {
      if (isEdit) return refuse(PLAN_EDIT_BLOCKED);
      if (isCmd) return isReadOnlyCommand(detail) ? allow : refuse(PLAN_CMD_BLOCKED);
      return allow;
    }
    if (!isEdit && !isCmd) return allow;
    const reason = isCmd ? guardCommand(detail, cwd) : target ? guardWrite(target, cwd) : null;
    const programs = isCmd ? programsOf(detail) : [];
    if (reason && !this.sessionSet(this.allowedReasons).has(reason) && !rules?.reasons?.includes(reason)) return this.ask(name, detail, mode, reason, programs);
    if (mode === 'auto') return allow;
    if (isEdit && (mode === 'acceptEdits' || rules?.edits)) return allow;
    if (isCmd && programs.length && programs.every((p) => this.sessionSet(this.allowedPrograms).has(p) || rules?.programs?.includes(p))) return allow;
    return this.ask(name, detail, mode, null, programs);
  }

  private ask(name: string, detail: string, mode: PermissionMode, reason: string | null, programs: string[]): Promise<ApprovalResult> {
    const id = randomUUID();
    const what = name.startsWith('mcp__')
      ? programs[0] ?? 'this server'
      : reason
      ? 'this kind of action'
      : name === 'bash' || name === 'terminal_run'
        ? programs.join(', ') || 'this command'
        : 'edits';
    const alwaysLabel = `Allow ${what} for this session`;
    const projectLabel = `Always allow ${what} for this project`;
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, name, programs, reason });
      this.emit({ type: 'approval_request', id, name, detail, mode, reason: reason ?? undefined, alwaysLabel, projectLabel });
    });
  }

  /** submit_plan: store the plan on the session, tell the renderer, and end the run after this turn. */
  private submitPlan(title: string, markdown: string): PlanInfo {
    const plan: PlanInfo = { id: randomUUID(), title: clip(title.trim() || 'Plan', 80), markdown: markdown.trim(), status: 'proposed', createdAt: Date.now() };
    this.session.plans ??= {};
    this.session.plans[plan.id] = plan;
    this.planSubmitted = true;
    this.emit({ type: 'plan_proposed', plan });
    return plan;
  }

  /** Marks the current session's plan approved (build) or rejected (keep planning). The caller changes the mode and starts the build. */
  respondPlan(id: string, decision: 'build-ask' | 'build-acceptEdits' | 'keep'): PlanInfo {
    const plan = this.session.plans?.[id];
    if (!plan) throw new Error('No such plan in this conversation.');
    if (plan.status !== 'proposed') throw new Error('This plan was already decided.');
    plan.status = decision === 'keep' ? 'rejected' : 'approved';
    this.store.save(this.session, false);
    return plan;
  }

  /** Recomputes the changed-file count in the background and tells the renderer. */
  notifyChanges(): void {
    const session = this.session;
    listChanges(session, this.getConfig().workingDirectory)
      .then((list) => this.emit({ type: 'changes_updated', count: list.length }))
      .catch((err: unknown) => console.warn('[changes] listing failed:', errorMessage(err)));
  }

  async run(userText: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (this.running) throw new Error('A run is already in progress.');
    this.running = true;
    this.planSubmitted = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const cfg = this.getConfig();
    let reason: 'done' | 'aborted' | 'max_turns' | 'error' | 'plan' = 'done';

    const skills = this.getSkills();
    const { content } = expandSlashCommand(expandMentions(userText, cfg.workingDirectory).content, skills);
    this.repairTail(); // a session saved mid-run (rename, generated title) and then quit may end in unanswered tool calls
    this.startTurn(userText);
    this.session.messages.push(userMessage(content, attachments));
    this.autoCompactFailed = false;
    this.compactedAt = -1;
    this.emit({ type: 'run_start' });

    try {
      const { client, model } = cfg.provider === 'ollama' ? { client: null, model: cfg.ollama.model } : makeClient(cfg);
      if (!model) throw new Error('No model selected. Open Settings and pick one.');
      const mcpTools = this.mcp?.tools() ?? [];
      const tools = [...allTools(cfg.permissionMode), ...(cfg.permissionMode === 'plan' ? mcpTools.filter((t) => t.mcp?.readOnly) : mcpTools)];
      const specs = tools.map(toSpec);
      this.specTokens = estimateSpecTokens(specs);
      this.emitContext();
      // A model that cannot take tools (e.g. a vision-only Ollama model) still works as a plain chat.
      let activeSpecs = specs;
      if (cfg.provider === 'ollama') {
        const key = `${cfg.ollama.baseURL}|${model}`;
        if (!this.toolSupport.has(key)) {
          const caps = await modelCapabilities(cfg).catch(() => null);
          if (caps && caps.tools !== null) this.toolSupport.set(key, caps.tools);
        }
        if (this.toolSupport.get(key) === false) {
          activeSpecs = [];
          this.emit({ type: 'error', kind: 'notice', message: noToolsNotice(model) });
        }
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        config: cfg,
        mode: cfg.permissionMode,
        browser: this.browser,
        skills,
        terminal: this.terminal,
        approve: (name, detail, target) => this.requestApproval(name, detail, target),
        beforeChange: (abs) => {
          snapshotBeforeChange(this.session, abs);
          if (this.currentTurn) turnSnapshot(this.currentTurn, abs);
        },
        setTasks: (tasks) => this.setTasks(tasks),
        submitPlan: (title, markdown) => this.submitPlan(title, markdown),
        saveArtifact: (input) => this.saveArtifact(input),
        signal,
      };

      let nudged = false;
      for (let turn = 0; ; turn++) {
        if (turn >= cfg.maxTurns) {
          reason = 'max_turns';
          break;
        }
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        this.drainQueue(skills);
        await this.autoCompactIfNeeded(cfg, client, model, signal);
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
        const history: Msg[] = [{ role: 'system', content: systemPrompt(cfg, skills, this.mcp) }, ...this.session.messages];
        this.lastUsage = null;
        const { text, toolCalls } = await this.complete(cfg, client, model, history, activeSpecs, signal, turn);
        this.emit({ type: 'thinking_done' });

        if (!text.trim() && !toolCalls.length) {
          // Small models sometimes return nothing after a tool result. Nudge once, then give up.
          if (!nudged) {
            nudged = true;
            this.session.messages.push({ role: 'user', content: 'You returned an empty response. If the task is complete, summarize the result. If a tool failed, fix the problem and continue.' });
            continue;
          }
        }
        const assistant: Msg = { role: 'assistant', content: text };
        if (toolCalls.length) assistant.tool_calls = toolCalls;
        this.session.messages.push(assistant);
        this.markPrompt();
        if (text) this.emit({ type: 'text_done' });
        if (!toolCalls.length) {
          // A message queued during the run keeps it going instead of ending it.
          if (this.drainQueue(skills)) continue;
          break;
        }

        for (const call of toolCalls) {
          if (signal.aborted) break;
          const result = await this.execTool(call, tools, ctx);
          this.session.messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
          const used = tools.find((t) => t.name === call.function.name);
          if (CHANGING_TOOLS.has(call.function.name) || (used?.mcp && !used.mcp.readOnly)) this.notifyChanges();
          if (result.image && cfg.sendScreenshotsToModel) {
            this.session.messages.push({
              role: 'user',
              content: [
                { type: 'text', text: `[Screenshot returned by ${call.function.name}]` },
                { type: 'image_url', image_url: { url: result.image } },
              ],
            });
          }
        }
        if (this.planSubmitted) {
          reason = 'plan';
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) reason = 'aborted';
      else {
        reason = 'error';
        this.emit({ type: 'error', message: errorMessage(err) });
      }
    } finally {
      this.currentTurn = null;
      this.repairTail();
      this.store.save(this.session);
      this.running = false;
      this.abortController = null;
      this.dropQueue();
      this.emit({ type: 'session_changed', session: toMeta(this.session) });
      this.emit({ type: 'run_end', reason });
      if (reason === 'done' || reason === 'max_turns' || reason === 'plan') {
        this.generateSessionTitle(this.session).catch((err: unknown) => console.warn('[agent] title generation failed:', errorMessage(err)));
      }
    }
  }

  // ---------- Context window ----------

  /** Where the next request stands against the context window. */
  contextInfo(): ContextInfo {
    const cfg = this.getConfig();
    const limit = contextLimit(cfg);
    const s = this.session;
    const mark = s.lastPrompt;
    let tokens: number;
    if (mark && mark.at <= s.messages.length) tokens = mark.tokens + estimateTokens(s.messages.slice(mark.at));
    else tokens = estimateTokens([{ role: 'system', content: systemPrompt(cfg, this.getSkills(), this.mcp) }, ...s.messages]) + this.specTokens;
    return { tokens, limit, threshold: COMPACT_THRESHOLD, autoCompact: cfg.autoCompact !== false };
  }

  emitContext(): void {
    this.emit({ type: 'context', context: this.contextInfo() });
  }

  /** Records what the last model call cost as the base of the context estimate (the reply is now part of the history). */
  private markPrompt(): void {
    const u = this.lastUsage;
    if (!u || !u.promptTokens) return;
    this.session.lastPrompt = { tokens: u.promptTokens + u.completionTokens, at: this.session.messages.length };
    this.emitContext();
  }

  private reportUsage(usage: Usage): void {
    this.lastUsage = usage;
    this.emit({ type: 'usage', ...usage });
  }

  /** What every request costs before any conversation: the system prompt and the tool definitions. */
  private baseTokens(cfg: AppConfig): number {
    return estimateTokens([{ role: 'system', content: systemPrompt(cfg, this.getSkills(), this.mcp) }]) + this.specTokens;
  }

  private async autoCompactIfNeeded(cfg: AppConfig, client: OpenAI | null, model: string, signal: AbortSignal): Promise<void> {
    const s = this.session;
    if (cfg.autoCompact === false || this.autoCompactFailed || s.messages.length < MIN_COMPACT_MESSAGES) return;
    if (this.compactedAt >= 0 && s.messages.length < this.compactedAt + 4) return;
    const info = this.contextInfo();
    if (info.tokens < info.limit * COMPACT_THRESHOLD) return;
    const base = this.baseTokens(cfg);
    if (base >= info.limit * COMPACT_THRESHOLD) {
      // Folding the conversation cannot help when the prompt and tools alone fill the window.
      if (!this.smallWindowNoticed.has(s.id)) {
        this.smallWindowNoticed.add(s.id);
        this.emit({ type: 'error', kind: 'notice', message: `The system prompt and tool definitions take about ${Math.round(base / 1000)}k of the ${Math.round(info.limit / 1000)}k-token context window, so the conversation cannot be compacted. Raise the context size in Settings or disconnect MCP servers you do not need.` });
      }
      return;
    }
    const r = await this.compact('auto', undefined, signal, cfg, client, model);
    if (r.info) this.compactedAt = s.messages.length;
    else this.autoCompactFailed = true;
  }

  /** /compact between runs. Resolves with ok=false and a reason when nothing happened. */
  async compactNow(focus?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running || this.compacting) return { ok: false, error: 'Wait for the current run to finish, then compact.' };
    if (this.session.messages.length < MIN_COMPACT_MESSAGES) return { ok: false, error: 'Nothing to compact yet.' };
    const cfg = this.getConfig();
    this.compacting = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      const { client, model } = cfg.provider === 'ollama' ? { client: null, model: cfg.ollama.model } : makeClient(cfg);
      if (!model) throw new Error('No model selected. Open Settings and pick one.');
      const r = await this.compact('manual', focus, signal, cfg, client, model);
      return r.info ? { ok: true } : { ok: false, error: r.error ?? 'The summary could not be produced.' };
    } catch (err) {
      const message = errorMessage(err);
      this.emit({ type: 'compact_end', error: message });
      return { ok: false, error: message };
    } finally {
      this.compacting = false;
      this.abortController = null;
      this.emit({ type: 'session_changed', session: toMeta(this.session) });
    }
  }

  /** Replaces the conversation with a handoff brief the model writes. Emits compact_start and compact_end. */
  private async compact(reason: 'auto' | 'manual', focus: string | undefined, signal: AbortSignal, cfg: AppConfig, client: OpenAI | null, model: string): Promise<{ info?: CompactionInfo; error?: string }> {
    const s = this.session;
    const before = this.contextInfo().tokens;
    this.emit({ type: 'compact_start', reason });
    try {
      const summary = await this.summarize(cfg, client, model, focus, signal);
      if (signal.aborted) throw new Error('Compaction was stopped.');
      const folded = s.messages.splice(0);
      const info: CompactionInfo = { id: randomUUID(), createdAt: Date.now(), reason, tokensBefore: before, tokensAfter: 0, summary, messages: folded.length };
      s.messages.push({ role: 'user', content: compactedPreamble(summary) });
      s.lastPrompt = undefined;
      // Checkpoints point into the folded messages: nothing before the brief can be rewound to any more.
      s.turns = [];
      this.currentTurn = null;
      info.tokensAfter = this.contextInfo().tokens;
      s.compactions ??= [];
      s.compactions.push({ ...info, folded });
      this.store.save(s, false);
      this.emit({ type: 'compact_end', compaction: info });
      this.emitContext();
      return { info };
    } catch (err) {
      const error = signal.aborted ? 'Compaction was stopped.' : errorMessage(err);
      this.emit({ type: 'compact_end', error });
      return { error };
    }
  }

  private async summarize(cfg: AppConfig, client: OpenAI | null, model: string, focus: string | undefined, signal: AbortSignal): Promise<string> {
    const messages = summaryRequest(this.session.messages, focus, summaryBudgetChars(contextLimit(cfg)));
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]);
    let raw: string;
    if (!client) {
      const call = (think: boolean | undefined) =>
        ollamaComplete({
          baseURL: cfg.ollama.baseURL,
          model,
          messages,
          think,
          // num_ctx matches the agent's requests so Ollama keeps the model loaded as it is.
          options: { num_ctx: contextSize(cfg.ollama.numCtx), num_predict: 2000, temperature: 0.2 },
          signal: timeout,
        });
      try {
        raw = await call(false);
      } catch (err) {
        // Models without a thinking switch reject the think field.
        if (timeout.aborted || !/think/i.test(errorMessage(err))) throw err;
        raw = await call(undefined);
      }
    } else {
      const res = await client.chat.completions.create({ model, messages, max_tokens: 2000, stream: false }, { signal: timeout, maxRetries: 1 });
      raw = res.choices?.[0]?.message?.content ?? '';
    }
    const summary = cleanSummary(raw);
    if (summary.length < 40) throw new Error('The model returned no usable summary.');
    return summary;
  }

  /** Queues a message while a run is in progress; it is handed to the model before its next turn. */
  enqueue(text: string, attachments: ImageAttachment[] = []): QueuedMessage {
    if (!this.running) throw new Error('No run is in progress; send the message normally.');
    const m: QueuedMessage = { id: randomUUID(), text, attachments, createdAt: Date.now() };
    this.queued.push(m);
    return m;
  }

  unqueue(id: string): boolean {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.queued.splice(i, 1);
    return true;
  }

  queue(): QueuedMessage[] {
    return this.queued.map((m) => ({ ...m, attachments: [...m.attachments] }));
  }

  /** Moves queued messages into the conversation (in order). Returns true when any was delivered. */
  private drainQueue(skills: Skill[]): boolean {
    if (!this.queued.length) return false;
    const batch = this.queued.splice(0);
    const cwd = this.getConfig().workingDirectory;
    for (const m of batch) {
      const { content } = expandSlashCommand(expandMentions(m.text, cwd).content, skills);
      this.startTurn(m.text);
      this.session.messages.push(userMessage(content, m.attachments));
      this.emit({ type: 'queue_delivered', id: m.id });
    }
    return true;
  }

  /** The run ended with messages still queued: hand them back to the renderer. */
  private dropQueue(): void {
    const left = this.queued.splice(0);
    for (const m of left) this.emit({ type: 'queue_dropped', id: m.id });
  }

  /** Opens a checkpoint for the user message about to be pushed; file changes until the next one are recorded on it. */
  private startTurn(text: string): void {
    const s = this.session;
    s.turns ??= [];
    const turn: Turn = { at: s.messages.length, createdAt: Date.now(), text, files: {} };
    if (s.tasks?.length) turn.tasks = structuredClone(s.tasks);
    s.turns.push(turn);
    this.currentTurn = turn;
  }

  /** update_tasks: keep the list on the session and show it. */
  private setTasks(tasks: TaskItem[]): void {
    this.session.tasks = tasks.length ? tasks : undefined;
    this.store.save(this.session, false);
    this.emit({ type: 'tasks_updated', tasks });
  }

  /** create_artifact: store it, tell the renderer, and show it in the browser pane. */
  private saveArtifact(input: ArtifactInput): { info: ArtifactInfo; action: 'created' | 'updated' } {
    const r = this.artifacts.save(this.session, input);
    this.store.save(this.session, false);
    this.emit({ type: 'artifact', artifact: r.info, action: r.action });
    const b = this.browser as { navigate?: (url: string) => Promise<string> };
    if (typeof b.navigate === 'function') b.navigate(r.info.url).catch((err: unknown) => console.warn('[artifact] could not open in the browser pane:', errorMessage(err)));
    return r;
  }

  /**
   * Make sure every tool call of the last assistant turn has a tool result, so the next request is well-formed.
   * A stop between two calls of the same turn leaves the later ones unanswered.
   */
  private repairTail(): void {
    const msgs = this.session.messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== 'assistant') i--;
    const last = msgs[i];
    if (!last || last.role !== 'assistant' || !last.tool_calls?.length) return;
    const answered = new Set(msgs.slice(i + 1).flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])));
    for (const call of last.tool_calls) {
      if (!answered.has(call.id)) msgs.push({ role: 'tool', tool_call_id: call.id, content: 'Tool call was interrupted before it produced a result.' });
    }
  }

  /**
   * Gives the session a short model-generated title after a completed run. The caller does not await it and
   * only logs failures. `session` is the run's session, which may no longer be the current one when this ends.
   */
  private async generateSessionTitle(session: Session): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.autoTitles || session.titleLocked || this.titleAttempts.has(session.id)) return;
    const prompt = titlePrompt(session);
    if (!prompt) return;
    this.titleAttempts.add(session.id);
    const title = await generateTitle(cfg, prompt);
    // The user may have renamed or deleted the session, or turned the feature off, while the model answered.
    if (!title || title === session.title || session.titleLocked) return;
    if (this.store.get(session.id) !== session || !this.getConfig().autoTitles) return;
    session.title = title;
    session.titleLocked = true;
    this.store.save(session, false);
    this.emit({ type: 'session_changed', session: toMeta(session) });
  }

  private async complete(
    cfg: AppConfig,
    client: OpenAI | null,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    if (!client) {
      const chat = (tools: ToolSpec[]) =>
        ollamaChat({
          baseURL: cfg.ollama.baseURL,
          model,
          numCtx: contextSize(cfg.ollama.numCtx),
          think: cfg.ollama.think ?? 'auto',
          messages: history,
          tools,
          signal,
          turn,
          onText: (t) => this.emit({ type: 'text_delta', text: t }),
          onThinking: (t) => this.emit({ type: 'thinking_delta', text: t }),
          onWarning: (message) => this.emit({ type: 'error', message }),
          onUsage: (usage) => this.reportUsage(usage),
        });
      try {
        return await chat(specs);
      } catch (err) {
        // An Ollama too old to report capabilities only tells us here: retry once as a plain chat.
        if (!specs.length || signal.aborted || !/does not support tools/i.test(errorMessage(err))) throw err;
        this.toolSupport.set(`${cfg.ollama.baseURL}|${model}`, false);
        this.emit({ type: 'error', kind: 'notice', message: noToolsNotice(model) });
        return chat([]);
      }
    }
    let emitted = false;
    const onEmit = () => (emitted = true);
    const endpoint = `${client.baseURL}|${model}`;
    for (;;) {
      const includeUsage = !this.noStreamUsage.has(endpoint);
      try {
        return await this.completeStreaming(client, model, history, specs, signal, turn, includeUsage, onEmit);
      } catch (err) {
        if (signal.aborted || emitted) throw err;
        // A gateway or provider that rejects stream_options still streams without it.
        if (includeUsage && /stream_options|include_usage/i.test(errorMessage(err))) {
          this.noStreamUsage.add(endpoint);
          continue;
        }
        // Some gateways/models reject streaming with tools; fall back to a single request
        // as long as nothing has been shown to the user yet.
        console.warn('[agent] streaming failed, retrying without streaming:', errorMessage(err));
        return this.completeOnce(client, model, history, specs, signal, turn);
      }
    }
  }

  private async completeStreaming(
    client: OpenAI,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
    includeUsage: boolean,
    onEmit: () => void,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const stream = await client.chat.completions.create(
      { model, messages: history, tools: specs, stream: true, stream_options: includeUsage ? { include_usage: true } : undefined },
      { signal },
    );
    let text = '';
    const calls: ToolCall[] = [];
    const byId = new Map<string, ToolCall>();
    const byIndex = new Map<number, ToolCall>();
    let usage: Usage | null = null;

    for await (const chunk of stream) {
      // With include_usage the counts arrive on a final chunk whose choices array is empty.
      if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content ?? (delta as { reasoning?: string }).reasoning;
      if (reasoning) this.emit({ type: 'thinking_delta', text: reasoning });
      if (delta.content) {
        text += delta.content;
        onEmit();
        this.emit({ type: 'text_delta', text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        let call: ToolCall;
        const known = tc.id ? byId.get(tc.id) : undefined;
        if (known) call = known;
        else if (tc.id) {
          call = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          calls.push(call);
          byId.set(tc.id, call);
          byIndex.set(tc.index ?? calls.length - 1, call);
        } else {
          const existing = byIndex.get(tc.index ?? 0) ?? calls[calls.length - 1];
          if (existing) call = existing;
          else {
            call = { id: '', type: 'function', function: { name: '', arguments: '' } };
            calls.push(call);
            byIndex.set(tc.index ?? 0, call);
          }
        }
        if (tc.function?.name) call.function.name += tc.function.name;
        const args = tc.function?.arguments as unknown;
        if (typeof args === 'string') call.function.arguments += args;
        else if (args && typeof args === 'object') call.function.arguments += JSON.stringify(args);
      }
    }
    calls.forEach((c, i) => {
      if (!c.id) c.id = `call_${turn}_${i}`;
    });
    if (usage) this.reportUsage(usage);
    return { text, toolCalls: calls };
  }

  private async completeOnce(
    client: OpenAI,
    model: string,
    history: Msg[],
    specs: ToolSpec[],
    signal: AbortSignal,
    turn: number,
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const res = await client.chat.completions.create({ model, messages: history, tools: specs, stream: false }, { signal });
    if (res.usage) this.reportUsage(mergeUsage(null, res.usage));
    const msg = res.choices?.[0]?.message;
    const text = msg?.content ?? '';
    if (text) this.emit({ type: 'text_delta', text });
    const toolCalls: ToolCall[] = [];
    (msg?.tool_calls ?? []).forEach((tc, i) => {
      if (tc.type !== 'function') return;
      const args = tc.function.arguments as unknown;
      toolCalls.push({
        id: tc.id || `call_${turn}_${i}`,
        type: 'function',
        function: { name: tc.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
      });
    });
    return { text, toolCalls };
  }

  private async execTool(call: ToolCall, tools: Tool[], ctx: ToolContext): Promise<ToolResult> {
    const name = call.function.name;
    let args: unknown = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      this.emit({ type: 'tool_start', id: call.id, name, args: call.function.arguments });
      const content = `Error: arguments for ${name} were not valid JSON: ${truncate(call.function.arguments, 500)}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return { content };
    }
    this.emit({ type: 'tool_start', id: call.id, name, args });
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      const content = `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: 0 });
      return { content };
    }
    // durationMs covers the tool's own work: time spent waiting on an approval card is left out.
    let waited = 0;
    const timedCtx: ToolContext = {
      ...ctx,
      approve: async (toolName, detail, target) => {
        const askedAt = Date.now();
        try {
          return await ctx.approve(toolName, detail, target);
        } finally {
          waited += Date.now() - askedAt;
        }
      },
    };
    const started = Date.now();
    const elapsed = () => Math.max(0, Date.now() - started - waited);
    try {
      const result = await tool.run(args, timedCtx);
      result.content = truncate(result.content);
      // The same rule the saved transcript applies when it is shown again (sessions.ts).
      const ok = !/^(Error:|Not permitted|Tool call was interrupted)/.test(result.content);
      this.emit({ type: 'tool_end', id: call.id, name, result: result.content, ok, image: result.image, durationMs: elapsed() });
      return result;
    } catch (err) {
      const content = `Error: ${errorMessage(err)}`;
      this.emit({ type: 'tool_end', id: call.id, name, result: content, ok: false, durationMs: elapsed() });
      return { content };
    }
  }
}
