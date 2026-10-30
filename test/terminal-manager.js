// Headless checks for the Terminal pane backend (TerminalManager): zsh integration, capture, read/wait, stop, exit, bash fallback.
// Run: ELECTRON_RUN_AS_NODE=1 npx electron smoke5.js <projectDir>   (or plain node)
const path = require('path');
const os = require('os');
const fs = require('fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { TerminalManager, describeTabs } = require(path.join(projectDir, 'dist/main/terminal.js'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-term-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-term-cwd-'));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const tm = new TerminalManager({ dataDir, cwd: () => cwd });
  const tabEvents = []; tm.on('tabs', (t) => tabEvents.push(t));
  const t = tm.create(100, 30, false);
  check('tab created', t.id === 'tab-1' && t.shell === 'zsh' && t.cwd === cwd && t.title === 'zsh', JSON.stringify(t));
  check('zsh shim written', fs.existsSync(path.join(dataDir, 'zsh', '.zshrc')) && fs.existsSync(path.join(dataDir, 'zsh', '.zshenv')));
  const first = await tm.read(t.id, 20, 4000);
  check('first prompt arrived', first.length > 0, JSON.stringify(first));
  const r1 = await tm.run(t.id, 'echo hello-from-oc', 10000);
  check('echo finished with exit 0 via integration', r1.finished && r1.exitCode === 0 && r1.integration, JSON.stringify(r1));
  check('echo output captured exactly', r1.output === 'hello-from-oc', JSON.stringify(r1.output));
  const r2 = await tm.run(t.id, 'printf "no newline"; false', 10000);
  check('exit code 1 and the EOL mark stripped', r2.finished && r2.exitCode === 1 && r2.output === 'no newline', JSON.stringify(r2));
  const r3 = await tm.run(t.id, 'cd /tmp && pwd', 10000);
  check('cwd follows cd (OSC 7)', ['/tmp', '/private/tmp'].includes(tm.get(t.id).cwd), tm.get(t.id).cwd + ' | ' + JSON.stringify(r3.output));
  const r4 = await tm.run(t.id, 'for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 1; done', 2500);
  check('long command reports still running with partial output', !r4.finished && /tick 1/.test(r4.output) && r4.integration, JSON.stringify(r4));
  const info4 = tm.get(t.id);
  check('tab shows the running command', /for i in/.test(info4.running || ''), `running=${info4.running} title=${info4.title}`);
  const r5 = await tm.read(t.id, 50, 2500);
  check('read with wait sees later ticks', /tick 3/.test(r5), r5.split('\n').slice(-3).join(' | '));
  tm.interrupt(t.id);
  await sleep(900);
  await tm.read(t.id, 5, 0);
  check('ctrl-c ends the command (idle again)', !tm.get(t.id).running, JSON.stringify(tm.get(t.id)));
  const desc = describeTabs(tm.list());
  check('describeTabs lists the tab as idle', /^tab-1\s+zsh\s+idle\s+/.test(desc), desc);
  check('history holds the output for replay', tm.history(t.id).includes('hello-from-oc'));
  const r6 = await tm.run(t.id, 'exit 3', 5000);
  check('exit closes the shell and the run reports it', tm.get(t.id).exitCode === 3 && r6.finished && r6.exitCode === 3, JSON.stringify({ r6, info: tm.get(t.id) }));
  check('tabs events were emitted', tabEvents.length >= 4, String(tabEvents.length));
  check('defaultTab skips exited tabs', tm.defaultTab() === undefined);
  let threw = '';
  try { await tm.run(t.id, 'echo nope', 1000); } catch (e) { threw = e.message; }
  check('running in an exited tab throws a helpful error', /has exited/.test(threw), threw);
  tm.close(t.id);
  check('close removes the tab', tm.list().length === 0);
  // Fallback for shells without integration
  const tmb = new TerminalManager({ dataDir, cwd: () => cwd, shell: '/bin/bash' });
  const b = tmb.create(100, 30, false);
  await tmb.read(b.id, 5, 3000);
  const rb = await tmb.run(b.id, 'echo from-bash', 5000);
  check('bash fallback captures output after quiet, exit unknown', !rb.integration && !rb.finished && rb.output === 'from-bash', JSON.stringify(rb));
  tmb.closeAll();
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
