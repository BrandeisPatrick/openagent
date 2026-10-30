import type { AppConfig, ArtifactInfo, PermissionMode, PlanInfo, TaskItem } from '../../shared/types';
import type { ArtifactInput } from '../artifacts';
import type { BrowserController } from '../browser';
import type { Skill } from '../skills';
import type { TerminalManager } from '../terminal';

/** Outcome of asking for permission: denied actions carry the message the model should read. */
export type ApprovalResult = { ok: true } | { ok: false; message: string };

export interface ToolContext {
  cwd: string;
  config: AppConfig;
  mode: PermissionMode;
  browser: BrowserController;
  skills: Skill[];
  /** The Terminal pane's shell tabs (terminal_* tools) */
  terminal: TerminalManager;
  /**
   * Ask for permission to run a side-effecting action. `detail` is what the user sees (the command, or a preview
   * of the change); `target` is the absolute file path for write/edit tools so the guard can check it.
   */
  approve(toolName: string, detail: string, target?: string): Promise<ApprovalResult>;
  /** Call before changing a file so the Diff pane can show (and revert) the change */
  beforeChange(absPath: string): void;
  /** Plan mode: hand the proposed plan to the user */
  submitPlan(title: string, markdown: string): PlanInfo;
  /** create_artifact: store the artifact on the session and show it in the Browser pane */
  saveArtifact(input: ArtifactInput): { info: ArtifactInfo; action: 'created' | 'updated' };
  /** Aborted when the user stops the run; long tool calls (MCP) should give up on it */
  signal?: AbortSignal;
  /** update_tasks: replace the session's task list and show it */
  setTasks(tasks: TaskItem[]): void;
}

export interface ToolResult {
  content: string;
  /** Optional data: URL of an image (PNG) produced by the tool, e.g. a screenshot */
  image?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
  /** Set for tools an MCP server provides: which server, its own tool name and the annotations the approval rules use */
  mcp?: { server: string; scope: 'user' | 'project'; tool: string; readOnly: boolean; destructive: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT = 60_000;

export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} more characters]`;
}
