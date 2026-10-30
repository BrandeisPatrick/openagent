import type { Tool } from './types';

export const browserTools: Tool[] = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in the built-in browser pane and wait for it to load. Also accepts "back", "forward", or a path relative to the current page (e.g. "form.html"). A bare search phrase is sent to DuckDuckGo.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL, "back", "forward", or search terms' } }, required: ['url'] },
    run: async (args, ctx) => ({ content: await ctx.browser.navigate(String(args.url)) }),
  },
  {
    name: 'browser_get_text',
    description: 'Return the visible text of the current page (main content first). Best for reading articles and docs.',
    parameters: { type: 'object', properties: { max_chars: { type: 'integer', description: 'Maximum characters to return (default 50000)' } } },
    run: async (args, ctx) => ({ content: await ctx.browser.getText(Number(args.max_chars) || 50_000) }),
  },
  {
    name: 'browser_read_page',
    description:
      'Outline the current page as a list of visible interactive elements, each tagged with a ref id like [ref_3] that browser_click and browser_type accept. filter="all" also includes headings and text.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive (default) or all' },
        max_chars: { type: 'integer', description: 'Maximum characters to return (default 40000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.readPage(args.filter === 'all' ? 'all' : 'interactive', Number(args.max_chars) || 40_000),
    }),
  },
  {
    name: 'browser_find',
    description: 'Search the current page for elements or text containing a phrase (case-insensitive). Returns matching outline lines with refs.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to look for, e.g. "Sign in"' } }, required: ['query'] },
    run: async (args, ctx) => ({ content: await ctx.browser.find(String(args.query)) }),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its visible text (e.g. "Sign in"), by its ref from browser_read_page, or at viewport coordinates.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text or label of the element to click (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_3' },
        x: { type: 'number', description: 'Viewport x in CSS pixels (when no ref)' },
        y: { type: 'number', description: 'Viewport y in CSS pixels (when no ref)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: 'Double-click' },
      },
    },
    run: async (args, ctx) => {
      const button = (['left', 'right', 'middle'].includes(args.button) ? args.button : 'left') as 'left' | 'right' | 'middle';
      const ref = args.ref ? String(args.ref) : args.text ? await ctx.browser.findRef(String(args.text), 'any') : '';
      if (ref) return { content: await ctx.browser.click(ref, button, Boolean(args.double)) };
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        ctx.browser.clickAt(args.x, args.y, button, args.double ? 2 : 1);
        await new Promise((r) => setTimeout(r, 400));
        return { content: `Clicked at (${args.x}, ${args.y}).` };
      }
      throw new Error('Provide text, a ref, or x and y.');
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a field chosen by its label or placeholder (field), by ref, or into whatever currently has focus. Replaces existing content unless clear=false. Set submit=true to press Enter afterwards.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Label or placeholder of the field to type into (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_5' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Clear the field first (default true)' },
      },
      required: ['text'],
    },
    run: async (args, ctx) => {
      const ref = args.ref ? String(args.ref) : args.field ? await ctx.browser.findRef(String(args.field), 'field') : undefined;
      return { content: await ctx.browser.type(ref, String(args.text), Boolean(args.submit), args.clear !== false) };
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until the page shows some text or an element matching a CSS selector (default timeout 10 s). Use after clicks that load or update content.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text that must appear on the page (case-insensitive)' },
        selector: { type: 'string', description: 'CSS selector that must match an element' },
        timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds (default 10000, max 60000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.waitFor(args.text ? String(args.text) : undefined, args.selector ? String(args.selector) : undefined, Number(args.timeout_ms) || 10_000),
    }),
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or shortcut in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "cmd+a".',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async (args, ctx) => ({ content: await ctx.browser.pressKey(String(args.key)) }),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 600)' },
      },
      required: ['direction'],
    },
    run: async (args, ctx) => ({ content: await ctx.browser.scroll(args.direction, Number(args.amount) || 600) }),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the browser pane as a PNG. The image is shown to the user and saved to disk; it is also sent to the model when screenshots-to-model is enabled in Settings.',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      const shot = await ctx.browser.screenshot();
      return { content: `Screenshot saved to ${shot.path} (${shot.width}x${shot.height}).`, image: shot.dataUrl };
    },
  },
  {
    name: 'browser_eval',
    description: 'Run JavaScript in the current page and return the result as JSON. Use for inspection and data extraction.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression or IIFE' } }, required: ['code'] },
    run: async (args, ctx) => ({ content: await ctx.browser.evaluate(String(args.code)) }),
  },
];
