// Context compaction: estimates how full the context window is and folds the conversation into a handoff brief
// (Claude Code's /compact and auto-compact) so a session can go on past the model's context size.

import type OpenAI from 'openai';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** First line of the user message that stands in for the folded conversation; the transcript hides it. */
export const COMPACT_MARK = '[Context compacted]';
/** Fraction of the window at which a run compacts on its own */
export const COMPACT_THRESHOLD = 0.8;
/** Tokens reserved for the summary request's own framing and the brief it produces */
const SUMMARY_RESERVE_TOKENS = 2200;
const TOOL_RESULT_CHARS = 1500;
const ARGS_CHARS = 600;

export function isCompactPreamble(m: Msg | undefined): boolean {
  return !!m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(COMPACT_MARK);
}

function textOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part) text += String((part as { text: string }).text) + '\n';
      else if (part && typeof part === 'object' && 'image_url' in part) images++;
    }
  }
  return { text, images };
}

/** Rough size of a message: about four characters per token, plus a flat cost per image. */
export function estimateMessageTokens(m: Msg): number {
  const { text, images } = textOf((m as { content?: unknown }).content);
  let chars = text.length + 8;
  if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) chars += tc.type === 'function' ? tc.function.name.length + tc.function.arguments.length + 16 : 16;
  return Math.ceil(chars / 4) + images * 1000;
}

export function estimateTokens(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/** Tool specs count against the window on every call. */
export function estimateSpecTokens(specs: unknown[]): number {
  if (!specs.length) return 0;
  try {
    return Math.ceil(JSON.stringify(specs).length / 4);
  } catch {
    return 0;
  }
}

/** Characters of transcript that fit a summary request inside the window. */
export function summaryBudgetChars(limit: number): number {
  return Math.max(6000, Math.floor((limit - SUMMARY_RESERVE_TOKENS) * 3.2));
}

const SUMMARY_SYSTEM = `You compact the transcript of a coding-agent session so the agent can continue the work in a fresh context. Write a handoff brief in Markdown with exactly these sections:

## Request
What the user asked for, in their own words where the wording matters, with every constraint and preference they stated.

## Progress
What was done, step by step: files read or changed (with paths), commands run and what they produced, decisions made and why. Keep key code snippets, error messages, numbers and names verbatim when the agent will need them again.

## Current state
What is finished, what is in progress, and what is broken, unverified or waiting on the user.

## Next steps
What to do next, in order. If the user's latest request is not finished, say exactly where to pick up.

Be precise and dense: facts, not narration. Do not invent anything that is not in the transcript. Do not address the user and do not add anything outside these sections.`;

function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - max} characters of the middle of the transcript omitted …]\n\n${s.slice(s.length - tail)}`;
}

function clipEnd(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} …[${s.length - max} more characters]`;
}

/** The conversation as plain text for the summariser (tool results and arguments shortened). */
export function renderForSummary(messages: Msg[], budgetChars: number): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (isCompactPreamble(m)) {
        lines.push(`EARLIER SUMMARY:\n${(m.content as string).split('\n').slice(2).join('\n').trim()}`);
        continue;
      }
      const { text, images } = textOf(m.content);
      lines.push(`USER: ${text.trim()}${images ? ` [${images} image${images === 1 ? '' : 's'} attached]` : ''}`);
    } else if (m.role === 'assistant') {
      const { text } = textOf(m.content);
      if (text.trim()) lines.push(`ASSISTANT: ${text.trim()}`);
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        names.set(tc.id, tc.function.name);
        lines.push(`ASSISTANT CALLS ${tc.function.name}(${clipEnd(tc.function.arguments, ARGS_CHARS)})`);
      }
    } else if (m.role === 'tool') {
      const { text } = textOf(m.content);
      lines.push(`RESULT OF ${names.get(m.tool_call_id) ?? 'tool'}: ${clipEnd(text.trim(), TOOL_RESULT_CHARS)}`);
    }
  }
  return clipMiddle(lines.join('\n\n'), budgetChars);
}

/** The messages of a summary request. `focus` is what the user asked the summary to keep in detail. */
export function summaryRequest(messages: Msg[], focus: string | undefined, budgetChars: number): Msg[] {
  const transcript = renderForSummary(messages, budgetChars);
  const extra = focus?.trim() ? `\n\nThe user asked the brief to focus on: ${focus.trim()}` : '';
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: `Transcript:\n\n${transcript}\n\n---\nWrite the handoff brief now.${extra}` },
  ];
}

/** Cleans a model reply into the brief: no reasoning blocks, fences or preamble lines. */
export function cleanSummary(raw: string): string {
  let t = String(raw ?? '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(?:here is|here's|below is)[^\n]*\n+/i, '').trim();
  return t;
}

/** The user message that replaces the folded conversation. */
export function compactedPreamble(summary: string): string {
  return `${COMPACT_MARK}
This session was compacted: the earlier conversation was replaced by the brief below. Continue from it as if nothing was interrupted. Do not mention the compaction and do not redo work the brief marks as done. If a task was in progress, carry on with its next step; if the user's latest request was already complete, answer their next message.

${summary.trim()}`;
}
