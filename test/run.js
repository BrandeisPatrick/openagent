// Runs every headless suite in this folder against the built app (npm run build first). No model needed:
// each suite starts its own mock model server, and the MCP suites start a small stdio MCP server.
// Usage: npm test            (or: node test/run.js [suite-name-substring])
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
if (!fs.existsSync(path.join(root, 'dist', 'main', 'agent.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}
const filter = process.argv[2] || '';
const suites = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && f !== 'run.js' && !/-\d\.js$/.test(f) && f.includes(filter))
  .sort();
let failed = 0;
for (const file of suites) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file), root], { encoding: 'utf8', timeout: 300_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  if (!ok) failed++;
  const summary = out.trim().split('\n').pop() || '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(34)} ${summary}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) console.log(out.split('\n').filter((l) => /FAIL|Error|CRASH/.test(l)).slice(0, 12).map((l) => '      ' + l).join('\n'));
}
console.log(failed ? `\n${failed} suite(s) failed` : `\nall ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
