import type { Tool } from './types';

/** Plan mode only: the model hands its plan to the user and the run ends until the plan is approved. */
export const submitPlan: Tool = {
  name: 'submit_plan',
  description:
    'Submit your plan to the user for approval (plan mode only). Call it exactly once, after exploring. The run stops afterwards; the user approves the plan before anything is built.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title for the plan (a few words)' },
      markdown: {
        type: 'string',
        description: 'The plan in Markdown: the goal, numbered steps naming the files to touch, how to verify, and open questions',
      },
    },
    required: ['title', 'markdown'],
  },
  async run(args, ctx) {
    const title = String(args.title ?? '').trim();
    const markdown = String(args.markdown ?? '').trim();
    if (!markdown) throw new Error('markdown is required: write the plan itself.');
    if (ctx.mode !== 'plan') throw new Error('submit_plan is only available in plan mode.');
    const plan = ctx.submitPlan(title || 'Plan', markdown);
    return { content: `Plan "${plan.title}" submitted. Stop here; the user will review it and decide whether to build it.` };
  },
};
