// A tiny tokenizer-based syntax highlighter. Each language is one combined regex whose alternatives
// are tried in order at every position; only keywords, strings, comments, numbers and punctuation
// are coloured. Unknown languages render as escaped plain text.

import { escapeHtml } from './dom.js';

type Kind = 'kw' | 'str' | 'com' | 'num' | 'pun' | 'add' | 'del';
interface Lang {
  re: RegExp;
  kinds: Kind[];
}

function lang(rules: [Kind, RegExp | string][]): Lang {
  const src = rules.map(([, r]) => `(${typeof r === 'string' ? r : r.source})`).join('|');
  return { re: new RegExp(src, 'gm'), kinds: rules.map(([k]) => k) };
}
const words = (list: string): string => `\\b(?:${list.trim().split(/\s+/).join('|')})\\b`;

const C_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/;
const NUMBER = /\b(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b/;
const PUNCT = /[{}()[\];,.:?<>=+\-*/%!&|^~@]+/;

const JS = lang([
  ['com', C_COMMENT],
  ['str', /`(?:[^`\\]|\\[\s\S])*`?|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/],
  [
    'kw',
    words(`break case catch class const continue debugger default delete do else export extends finally for function if import in
      instanceof let new return super switch this throw try typeof var void while with yield async await of static get set as from
      type interface enum implements private protected public readonly declare namespace abstract keyof satisfies never unknown any
      boolean number string symbol bigint object null undefined true false`),
  ],
  ['num', NUMBER],
  ['pun', PUNCT],
]);

const PY = lang([
  ['com', /#[^\n]*/],
  ['str', /(?:\b[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/],
  [
    'kw',
    words(`False None True and as assert async await break class continue def del elif else except finally for from global if import
      in is lambda nonlocal not or pass raise return try while with yield match case self cls`),
  ],
  ['kw', /@[A-Za-z_][\w.]*/],
  ['num', /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?)\b/],
  ['pun', /[{}()[\];,.:<>=+\-*/%!&|^~]+/],
]);

const SH = lang([
  ['com', /(?:^|(?<=[ \t;]))#[^\n]*/],
  ['str', /"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?/],
  ['num', /\$(?:\{[^}\n]*\}?|\w+|[@*#?$!0-9-])/],
  ['kw', /(?<=^[ \t]*(?:\$[ \t]+)?|[|;&(][ \t]*)[A-Za-z_][\w.+-]*/],
  ['kw', words('if then else elif fi for while until do done case esac in function return export local declare readonly source alias unset set exit break continue')],
  ['num', /(?<![\w.-])\d+\b/],
  ['pun', /[|&;<>(){}[\]=]+/],
]);

const JSON_LANG = lang([
  ['com', C_COMMENT],
  ['kw', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
  ['str', /"(?:[^"\\\n]|\\.)*"?/],
  ['kw', /\b(?:true|false|null)\b/],
  ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ['pun', /[{}[\],:]+/],
]);

const HTML = lang([
  ['com', /<!--[\s\S]*?(?:-->|(?![\s\S]))/],
  ['kw', /(?<=<\/?)[A-Za-z!][\w:.-]*/],
  ['num', /(?<=\s)[A-Za-z_:@][\w:.-]*(?=\s*=)/],
  ['str', /"[^"]*"|'[^']*'/],
  ['num', /&#?\w+;/],
  ['pun', /<\/?|\/?>|=/],
]);

const CSS = lang([
  ['com', /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|(?<=^|\s)\/\/[^\n]*/],
  ['str', /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/],
  ['kw', /@[\w-]+|!important\b/],
  ['num', /#[\da-fA-F]{3,8}\b|(?<![\w-])-?(?:\d*\.)?\d+(?:[a-zA-Z]+|%)?/],
  ['kw', /(?<=(?:^|[{;])[ \t]*)-{0,2}[a-zA-Z][\w-]*(?=\s*:(?!:))/],
  ['pun', /[{}()[\];:,>+~*=]+/],
]);

const GO = lang([
  ['com', C_COMMENT],
  ['str', /`[^`]*`?|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'/],
  [
    'kw',
    words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return
      select struct switch type var nil true false iota bool byte rune string error int int8 int16 int32 int64 uint uint8 uint16 uint32
      uint64 uintptr float32 float64 any make new len cap append panic recover`),
  ],
  ['num', NUMBER],
  ['pun', PUNCT],
]);

const RUST = lang([
  ['com', C_COMMENT],
  ['str', /b?"(?:[^"\\]|\\[\s\S])*"?|r#*"[\s\S]*?"#*|'(?:[^'\\\n]|\\.)'/],
  ['kw', /\b[a-z_]\w*!(?=\s*[([{])/],
  [
    'kw',
    words(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref
      return self Self static struct super trait true type unsafe use where while Some None Ok Err String Vec Option Result Box i8 i16
      i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str`),
  ],
  ['num', NUMBER],
  ['pun', PUNCT],
]);

const YAML = lang([
  ['com', /(?:^|(?<=\s))#[^\n]*/],
  ['kw', /(?<=^[ \t]*(?:-[ \t]+)?)(?:"[^"\n]*"|'[^'\n]*'|[^\s:#'"-][^:#\n]*?)(?=[ \t]*:(?:[ \t]|$))/],
  ['str', /"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?/],
  ['kw', /\b(?:true|false|yes|no|on|off|null)\b|(?<=:\s*)~/],
  ['num', /(?<![\w.-])-?\d+(?:\.\d+)?\b/],
  ['pun', /^[ \t]*-(?=[ \t]|$)|[:|>{}[\],&*]/],
]);

const MD = lang([
  ['com', /<!--[\s\S]*?(?:-->|(?![\s\S]))/],
  ['str', /^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[ \t]*$|(?![\s\S]))/],
  ['kw', /^#{1,6}[ \t][^\n]*/],
  ['str', /`[^`\n]+`/],
  ['num', /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]*\]\([^)\n]*\)/],
  ['pun', /^[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])|^[ \t]*>/],
]);

const DIFF = lang([
  ['com', /^(?:diff |index |--- |\+\+\+ )[^\n]*/],
  ['num', /^@@[^\n]*/],
  ['add', /^\+[^\n]*/],
  ['del', /^-[^\n]*/],
]);

const LANGS: Record<string, Lang> = { js: JS, py: PY, sh: SH, json: JSON_LANG, html: HTML, css: CSS, go: GO, rust: RUST, yaml: YAML, md: MD, diff: DIFF };

const ALIASES: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', mts: 'js', cts: 'js', node: 'js',
  py: 'py', python: 'py', python3: 'py', py3: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', shellsession: 'sh', terminal: 'sh', fish: 'sh',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', xhtml: 'html', plist: 'html',
  css: 'css', scss: 'css', less: 'css',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  yaml: 'yaml', yml: 'yaml',
  md: 'md', markdown: 'md',
  diff: 'diff', patch: 'diff',
};

export function resolveLang(name: string): string | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

/** Language id for a file path, from its extension (or null). */
export function langFromPath(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  if (/^(?:dockerfile|makefile)$/i.test(base)) return null;
  if (/^\.?(?:zshrc|bashrc|profile|bash_profile)$/.test(base)) return 'sh';
  const ext = /\.([A-Za-z0-9]+)$/.exec(base)?.[1];
  return ext ? resolveLang(ext) : null;
}

/** Highlighted HTML for `code`. `lang` may be an alias ("ts", "bash") or empty. */
export function highlight(code: string, langName: string | null): string {
  const id = langName ? (LANGS[langName] ? langName : resolveLang(langName)) : null;
  const def = id ? LANGS[id] : undefined;
  if (!def || code.length > 200_000) return escapeHtml(code);
  const re = def.re;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    let k = 1;
    while (k < m.length && m[k] === undefined) k++;
    out += escapeHtml(code.slice(last, m.index));
    out += `<span class="tok-${def.kinds[k - 1]}">${escapeHtml(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + escapeHtml(code.slice(last));
}
