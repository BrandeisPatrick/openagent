import type { TaskItem } from '../../shared/types';
import type { Tool } from './types';

const MAX_TASKS = 20;
const STATUSES = new Set<TaskItem['status']>(['pending', 'in_progress', 'completed']);

/** The agent's own checklist, shown as a card under the transcript and updated in place (like Claude Code's task list). */
export const updateTasks: Tool = {
  name: 'update_tasks',
  description:
    'Keep a short task list the user can see while you work. For work with several steps, call it first with the whole plan (3–7 items), then again whenever a step starts or finishes, always passing every item with its current status; keep ids stable and have at most one item in_progress. An empty list clears it.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The whole list, in order',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id such as t1, t2; reuse it when updating' },
            title: { type: 'string', description: 'Short imperative phrase' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['tasks'],
  },
  async run(args: { tasks?: unknown }, ctx) {
    if (!Array.isArray(args?.tasks)) return { content: 'Error: tasks must be a list of {id, title, status}.' };
    const tasks: TaskItem[] = [];
    const seen = new Set<string>();
    args.tasks.slice(0, MAX_TASKS).forEach((raw, i) => {
      const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const title = String(t.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!title) return;
      const status = STATUSES.has(t.status as TaskItem['status']) ? (t.status as TaskItem['status']) : 'pending';
      let id = String(t.id ?? '').trim().slice(0, 32) || `t${i + 1}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      tasks.push({ id, title, status });
    });
    ctx.setTasks(tasks);
    if (!tasks.length) return { content: 'Task list cleared.' };
    const done = tasks.filter((t) => t.status === 'completed').length;
    const mark = (s: TaskItem['status']) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]');
    return { content: `Task list updated: ${done} of ${tasks.length} done.\n${tasks.map((t) => `${mark(t.status)} ${t.id}: ${t.title}`).join('\n')}` };
  },
};
