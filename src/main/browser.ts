import { app, BrowserWindow, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Bounds, BrowserState } from '../shared/types';

const REF_ATTR = 'data-oc-ref';
const REF_RE = /^ref_\d+$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEY_MAP: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

/** Runs inside the page: labels visible interactive elements with ref ids and returns a compact outline. */
function readPageScript(mode: 'interactive' | 'all', maxChars: number): string {
  return `(() => {
    const REF = ${JSON.stringify(REF_ATTR)};
    const MODE = ${JSON.stringify(mode)};
    const MAX = ${maxChars};
    if (!document.body) return { text: '(empty page)', count: 0, truncated: false, title: document.title, url: location.href };
    const INTERACTIVE = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="textbox"],[role="combobox"],[role="option"],[role="switch"],[contenteditable="true"]';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const label = (el) => clean(
      el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : '') || el.innerText || el.textContent
    ).slice(0, 120);
    document.querySelectorAll('[' + REF + ']').forEach((e) => e.removeAttribute(REF));
    const lines = []; let n = 0; let size = 0;
    const push = (line) => { lines.push(line); size += line.length + 1; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'svg') return NodeFilter.FILTER_REJECT;
          if (!visible(node)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (size > MAX) break;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (el.matches(INTERACTIVE)) {
          const ref = 'ref_' + (++n);
          el.setAttribute(REF, ref);
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          let desc = '[' + ref + '] ' + tag + (type ? '[type=' + type + ']' : '') + ' "' + label(el) + '"';
          if (tag === 'a') { const href = el.getAttribute('href') || ''; if (href && !href.startsWith('javascript:')) desc += ' -> ' + href.slice(0, 100); }
          if (tag === 'input' && (type === 'checkbox' || type === 'radio')) desc += el.checked ? ' (checked)' : ' (unchecked)';
          if (tag === 'select') desc += ' = "' + clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text) + '"';
          push(desc);
        } else if (MODE === 'all' && /^H[1-6]$/.test(el.tagName)) {
          push(el.tagName.toLowerCase() + ': ' + clean(el.innerText).slice(0, 200));
        }
      } else if (MODE === 'all') {
        const t = clean(node.textContent);
        if (!t) continue;
        const p = node.parentElement;
        if (!p || p.closest(INTERACTIVE) || p.closest('h1,h2,h3,h4,h5,h6')) continue;
        push(t.slice(0, 300));
      }
    }
    return { text: lines.join('\\n'), count: n, truncated: size > MAX, title: document.title, url: location.href };
  })()`;
}

function rectScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
  })()`;
}

/** Runs inside the page: a human-readable description of a ref'd element. */
function describeScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return null;
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button' : tag === 'select' ? 'combobox' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'textbox' : tag);
    const name = clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.innerText || el.textContent || el.value).slice(0, 80);
    return { role, name };
  })()`;
}

/** Runs inside the page: briefly outlines the element the agent is about to act on, so the user can follow along. */
function flashScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-oc-flash', '1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d97757;border-radius:6px;background:rgba(217,119,87,0.18);box-shadow:0 0 0 4px rgba(217,119,87,0.25);transition:opacity 0.45s ease 0.25s;left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
    document.documentElement.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '0'; });
    setTimeout(() => box.remove(), 800);
    return true;
  })()`;
}

function waitScript(text: string | undefined, selector: string | undefined): string {
  return `(() => {
    const text = ${JSON.stringify(text ?? '')}.toLowerCase();
    const selector = ${JSON.stringify(selector ?? '')};
    if (selector) { try { const el = document.querySelector(selector); if (el) return { line: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }; } catch (e) { return 'bad-selector'; } }
    if (text && document.body) {
      const lines = document.body.innerText.split('\\n');
      const hit = lines.find((l) => l.toLowerCase().includes(text));
      if (hit !== undefined) return { line: hit.replace(/\\s+/g, ' ').trim().slice(0, 200) };
    }
    return false;
  })()`;
}

export class BrowserController {
  readonly view: WebContentsView;
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = true;

  constructor(
    private readonly win: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
  ) {
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.contentView.addChildView(this.view);
    const wc = this.view.webContents;
    const events = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load'] as const;
    for (const ev of events) wc.on(ev as 'did-navigate', () => this.emitState());
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.setUserAgent(wc.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ openagent\/[\d.]+/i, ''));
    void wc.loadURL('about:blank');
  }

  private get wc() {
    return this.view.webContents;
  }

  state(): BrowserState {
    const wc = this.wc;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    };
  }

  private emitState(): void {
    if (this.win.isDestroyed()) return;
    this.onState(this.state());
  }

  setBounds(b: Bounds): void {
    this.bounds = b;
    this.applyBounds();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.applyBounds();
  }

  private applyBounds(): void {
    const b = this.visible ? this.bounds : { x: 0, y: 0, width: 0, height: 0 };
    this.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }

  private async waitForLoad(timeoutMs = 20_000): Promise<void> {
    const wc = this.wc;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener('did-finish-load', done);
        wc.removeListener('did-fail-load', done);
        wc.removeListener('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', done);
      wc.once('did-stop-loading', done);
    });
    await sleep(250);
  }

  async navigate(target: string): Promise<string> {
    const wc = this.wc;
    const t = target.trim();
    if (t === 'back' || t === 'forward') {
      const can = t === 'back' ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward();
      if (!can) return `Cannot go ${t}: no history in that direction.`;
      const wait = this.waitForLoad();
      if (t === 'back') wc.navigationHistory.goBack();
      else wc.navigationHistory.goForward();
      await wait;
    } else {
      let url = t;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        const current = wc.getURL();
        const looksLikePath = /^(\.{1,2}\/|\/)/.test(url) || /^[\w.-]+(\/[\w.-]*)*\.[a-z0-9]{1,5}(\?.*)?(#.*)?$/i.test(url) && !/\.(com|org|net|io|dev|ai|co|edu|gov|app)(\/|$)/i.test(url);
        if (current && current !== 'about:blank' && looksLikePath) url = new URL(url, current).href;
        else url = /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`;
      }
      const wait = this.waitForLoad();
      wc.loadURL(url).catch(() => undefined);
      await wait;
    }
    const s = this.state();
    return `Now at ${s.url}${s.title ? ` — "${s.title}"` : ''}`;
  }

  async reload(): Promise<void> {
    const wait = this.waitForLoad();
    this.wc.reload();
    await wait;
  }

  async getText(maxChars = 50_000): Promise<string> {
    const text = (await this.wc.executeJavaScript(
      `(() => { const m = document.querySelector('main, article, [role="main"]'); const el = (m && m.innerText && m.innerText.length > 200) ? m : document.body; return el ? el.innerText : ''; })()`,
      true,
    )) as string;
    const s = this.state();
    const body = text.length > maxChars ? text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} characters]` : text;
    return `URL: ${s.url}\nTitle: ${s.title}\n\n${body || '(no visible text)'}`;
  }

  async readPage(mode: 'interactive' | 'all' = 'interactive', maxChars = 40_000): Promise<string> {
    const r = (await this.wc.executeJavaScript(readPageScript(mode, maxChars), true)) as {
      text: string;
      count: number;
      truncated: boolean;
      title: string;
      url: string;
    };
    let out = `URL: ${r.url}\nTitle: ${r.title}\n${r.count} interactive element${r.count === 1 ? '' : 's'}\n\n${r.text || '(nothing visible)'}`;
    if (r.truncated) out += '\n…[page outline truncated; use browser_find to locate specific elements]';
    return out;
  }

  async find(query: string): Promise<string> {
    const r = (await this.wc.executeJavaScript(readPageScript('all', 400_000), true)) as { text: string };
    const q = query.toLowerCase();
    const hits = r.text.split('\n').filter((l) => l.toLowerCase().includes(q)).slice(0, 25);
    return hits.length ? hits.join('\n') : `No visible element or text matched "${query}".`;
  }

  /** Outline lines of the visible interactive elements; refs are refreshed as a side effect. */
  private async outlineLines(): Promise<string[]> {
    const r = (await this.wc.executeJavaScript(readPageScript('interactive', 400_000), true)) as { text: string };
    return r.text ? r.text.split('\n') : [];
  }

  /**
   * The ref of the element whose visible label contains `text` (case-insensitive; exact > prefix > substring),
   * so a model can act on "Sign in" without juggling refs. Throws with the candidates when ambiguous or missing.
   */
  async findRef(text: string, kind: 'any' | 'field' = 'any'): Promise<string> {
    const q = text.trim().toLowerCase();
    if (!q) throw new Error('text is required.');
    const lines = await this.outlineLines();
    const parsed = lines
      .map((line) => {
        const m = /^\[(ref_\d+)\] ([a-z0-9]+)(?:\[type=([^\]]*)\])? "([^"]*)"(?: -> (\S+))?/.exec(line);
        return m ? { ref: m[1], tag: m[2], type: (m[3] ?? '').toLowerCase(), label: m[4], href: m[5] ?? '', line } : null;
      })
      .filter((x): x is { ref: string; tag: string; type: string; label: string; href: string; line: string } => x !== null);
    const isField = (p: { tag: string; type: string }) =>
      p.tag === 'textarea' || p.tag === 'select' || (p.tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(p.type)) || (p.tag !== 'a' && p.tag !== 'button' && p.tag !== 'input');
    const pool = kind === 'field' ? parsed.filter(isField) : parsed;
    const score = (p: { label: string; href: string }) => {
      const l = p.label.toLowerCase();
      if (l === q) return 3;
      if (l.startsWith(q)) return 2;
      if (l.includes(q)) return 1;
      if (p.href && p.href.toLowerCase().includes(q)) return 0.5;
      return 0;
    };
    const scored = pool.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (!scored.length) throw new Error(`No ${kind === 'field' ? 'field' : 'element'} matching "${text}" on this page. Visible elements:\n${lines.slice(0, 30).join('\n') || '(none)'}`);
    const ties = scored.filter((x) => x.s === scored[0].s);
    if (ties.length > 1) throw new Error(`Several elements match "${text}"; use one of these refs instead:\n${ties.map((x) => x.p.line).join('\n')}`);
    return scored[0].p.ref;
  }

  private async rectOf(ref: string): Promise<{ x: number; y: number; tag: string }> {
    if (!REF_RE.test(ref)) throw new Error(`Invalid ref "${ref}". Refs look like ref_12 and come from browser_read_page, or pass text instead.`);
    const pt = (await this.wc.executeJavaScript(rectScript(ref), true)) as { x: number; y: number; tag: string } | null;
    if (!pt) {
      const lines = await this.outlineLines();
      throw new Error(`No element with ${ref} on the current page (refs change after navigation). The elements now are:\n${lines.slice(0, 30).join('\n') || '(none)'}\nUse one of these refs, or pass the element's visible text instead.`);
    }
    await sleep(50);
    return pt;
  }

  private async describe(ref: string): Promise<{ role: string; name: string }> {
    const d = (await this.wc.executeJavaScript(describeScript(ref), true).catch(() => null)) as { role: string; name: string } | null;
    return d ?? { role: 'element', name: '' };
  }

  private flash(ref: string): void {
    this.wc.executeJavaScript(flashScript(ref), true).catch(() => undefined);
  }

  /** Lets an action land: a short pause, the rest of any navigation it started, then "Now at …" when the page changed. */
  private async settle(before: BrowserState): Promise<string> {
    await sleep(300);
    if (this.wc.isLoading()) await this.waitForLoad(5000);
    const after = this.state();
    if (after.url !== before.url || after.title !== before.title) return ` Now at: ${after.title ? `${after.title} — ` : ''}${after.url}`;
    return '';
  }

  /** Polls the page for text or a selector (plan: 200 ms steps). */
  async waitFor(text: string | undefined, selector: string | undefined, timeoutMs = 10_000): Promise<string> {
    const what = [text ? `text "${text}"` : '', selector ? `selector "${selector}"` : ''].filter(Boolean).join(' or ');
    if (!what) throw new Error('Give text and/or selector to wait for.');
    const deadline = Date.now() + Math.min(Math.max(500, timeoutMs), 60_000);
    for (;;) {
      const found = (await this.wc.executeJavaScript(waitScript(text, selector), true).catch(() => false)) as false | string | { line: string };
      if (found === 'bad-selector') throw new Error(`"${selector}" is not a valid CSS selector.`);
      if (found && typeof found === 'object') return `Found ${what}.${found.line ? ` The page says: "${found.line}"` : ''}`;
      if (Date.now() >= deadline) return `Timed out after ${timeoutMs} ms waiting for ${what}. The page may still be loading or the text may differ.`;
      await sleep(200);
    }
  }

  clickAt(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clickCount = 1): void {
    const wc = this.wc;
    const px = Math.round(x);
    const py = Math.round(y);
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button, clickCount });
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button, clickCount });
  }

  async click(ref: string, button: 'left' | 'right' | 'middle' = 'left', double = false): Promise<string> {
    const pt = await this.rectOf(ref);
    const what = await this.describe(ref);
    const before = this.state();
    this.flash(ref);
    await sleep(120);
    this.wc.focus();
    this.clickAt(pt.x, pt.y, button, double ? 2 : 1);
    const suffix = await this.settle(before);
    return `Clicked ${what.role}${what.name ? ` '${what.name}'` : ''} (${ref}).${suffix}`;
  }

  async type(ref: string | undefined, text: string, submit = false, clear = true): Promise<string> {
    const before = this.state();
    let what = { role: 'the focused element', name: '' };
    if (ref) {
      const pt = await this.rectOf(ref);
      what = await this.describe(ref);
      this.flash(ref);
      this.wc.focus();
      this.clickAt(pt.x, pt.y);
      await sleep(120);
      if (clear) {
        await this.wc.executeJavaScript(
          `(() => { const el = document.activeElement; if (!el) return; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select(); else if (el.isContentEditable) { const s = getSelection(); s.selectAllChildren(el); } })()`,
          true,
        );
      }
    }
    await this.wc.insertText(text);
    if (submit) {
      await sleep(100);
      await this.pressKey('Enter');
    }
    const suffix = await this.settle(before);
    return `Typed ${JSON.stringify(text)} into ${what.role}${what.name ? ` '${what.name}'` : ''}${ref ? ` (${ref})` : ''}${submit ? ' and pressed Enter' : ''}.${suffix}`;
  }

  async pressKey(combo: string): Promise<string> {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop() ?? '';
    const modifiers = parts.map((m) => m.toLowerCase()).map((m) => (m === 'cmd' || m === 'command' || m === 'meta' ? 'cmd' : m === 'ctrl' || m === 'control' ? 'control' : m === 'option' ? 'alt' : m));
    const keyCode = KEY_MAP[keyName.toLowerCase()] ?? keyName;
    const wc = this.wc;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never });
    if (keyCode.length === 1 || keyCode === 'Return' || keyCode === 'Space' || keyCode === 'Tab') {
      wc.sendInputEvent({ type: 'char', keyCode, modifiers: modifiers as never });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never });
    const suffix = await this.settle(this.state());
    return `Pressed ${combo}.${suffix}`;
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 600): Promise<string> {
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const pos = (await this.wc.executeJavaScript(
      `(() => { window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' }); return { x: scrollX, y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight }; })()`,
      true,
    )) as { x: number; y: number; h: number; vh: number };
    await sleep(150);
    return `Scrolled ${direction}. Now at y=${Math.round(pos.y)} of ${pos.h} (viewport ${pos.vh}).`;
  }

  async screenshot(): Promise<{ path: string; dataUrl: string; width: number; height: number }> {
    const image = await this.wc.capturePage();
    const png = image.toPNG();
    const dir = path.join(app.getPath('temp'), 'openagent-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, png);
    const { width, height } = image.getSize();
    return { path: file, dataUrl: `data:image/png;base64,${png.toString('base64')}`, width, height };
  }

  async evaluate(code: string): Promise<string> {
    const result = await this.wc.executeJavaScript(code, true);
    if (result === undefined) return 'undefined';
    try {
      const s = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return s ?? String(result);
    } catch {
      return String(result);
    }
  }
}
