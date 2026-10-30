// Terminal tools through the agent with a mock model: approvals and allow-lists for terminal_run, read/list/stop,
// plan-mode refusals, the auto guard, bypass, and error messages.
// Run: node smoke6.js <projectDir>   (after `npx tsc -p tsconfig.json`)
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { loadSkills } = require(path.join(projectDir, 'dist/main/skills.js'));
const { TerminalManager } = require(path.join(projectDir, 'dist/main/terminal.js'));

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 400));
};
const replies = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url !== '/v1/chat/completions') return json(404, {});
    if (!payload.stream) return json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Mock Title' }, finish_reason: 'stop' }] });
    const reply = replies.shift() ?? { content: 'Done.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
    if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
    if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-smoke6-'));
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', numCtx: 8192, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '' },
    workingDirectory: tmp, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
  };
  const terminal = new TerminalManager({ dataDir: path.join(tmp, 'data'), cwd: () => config.workingDirectory });
  const tabEvents = [];
  terminal.on('tabs', (t) => tabEvents.push(t));
  let events = [];
  let onApproval = () => {};
  const agent = new Agent(() => config, {}, store, () => loadSkills(tmp, projectDir), (ev) => {
    events.push(ev);
    if (ev.type === 'approval_request') setTimeout(() => onApproval(ev), 0);
  }, terminal);
  check('agent shares the manager', agent.terminal === terminal);
  const approvals = () => events.filter((e) => e.type === 'approval_request');
  const ends = (name) => events.filter((e) => e.type === 'tool_end' && (!name || e.name === name));
  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });
  const run = async (text, ...calls) => {
    events = [];
    for (const c of calls) replies.push({ toolCalls: [c] });
    replies.push({ content: 'Done.' });
    await agent.run(text);
    replies.length = 0;
  };

  // --- ask mode: terminal_run asks like bash, with the program allow-list ---
  onApproval = (ev) => agent.resolveApproval(ev.id, true, true);
  await run('run echo in the terminal', call('terminal_run', { command: 'echo hello-terminal' }));
  let r = ends('terminal_run')[0];
  check('ask: terminal_run asked with the program label', approvals().length === 1 && approvals()[0].name === 'terminal_run' && approvals()[0].alwaysLabel === 'Allow echo for this session', approvals()[0]);
  check('ask: result has the tab header, output and exit code', r && r.ok && /^\[terminal tab-1 \(zsh\)\]\nhello-terminal\n\[exit code: 0\]$/.test(r.result), r && r.result);
  check('ask: the tab is marked as opened by the agent', terminal.list().length === 1 && terminal.list()[0].agent === true, terminal.list());
  await new Promise((res) => setTimeout(res, 400)); // notifyChanges lists changes asynchronously
  check('ask: changes_updated emitted after terminal_run', events.some((e) => e.type === 'changes_updated'));
  check('ask: durationMs excludes the approval wait', r.durationMs !== undefined && r.durationMs < 5000, r.durationMs);

  await run('again in the same tab', call('terminal_run', { command: 'echo second', tab_id: 'tab-1' }));
  r = ends('terminal_run')[0];
  check('allow-list: second echo ran without asking, same tab', approvals().length === 0 && r.ok && /\[terminal tab-1 \(zsh\)\]\nsecond\n\[exit code: 0\]/.test(r.result), r.result);
  check('allow-list: still one tab', terminal.list().length === 1);

  await run('read it', call('terminal_read', { tab_id: 'tab-1', lines: 30 }));
  r = ends('terminal_read')[0];
  check('read: header shows idle and cwd, body has the earlier output', r.ok && /^\[terminal tab-1 \(zsh\) · idle · cwd /.test(r.result) && /hello-terminal/.test(r.result) && /second/.test(r.result) && approvals().length === 0, r.result.split('\n').slice(0, 2));

  await run('list', call('terminal_list', {}));
  r = ends('terminal_list')[0];
  check('list: describes the tab', r.ok && /^tab-1\s+zsh\s+idle\s+.*\[opened by the agent\]$/.test(r.result), r.result);

  await run('read without tab id', call('terminal_read', {}));
  r = ends('terminal_read')[0];
  check('read: defaults to the newest tab', r.ok && /^\[terminal tab-1/.test(r.result));

  // --- still running + stop ---
  await run('start something slow', call('terminal_run', { command: 'sleep 20; echo late', tab_id: 'tab-1', timeout_ms: 1500 }));
  r = ends('terminal_run')[0];
  check('still running: reported with hints', r.ok && /\[still running after 1\.5 s — terminal_read tab-1 shows what it prints next; terminal_stop tab-1 interrupts it\]/.test(r.result), r.result);
  check('still running: tab shows the command', /sleep 20/.test(terminal.get('tab-1').running || ''), terminal.get('tab-1'));
  await run('busy tab', call('terminal_run', { command: 'echo nope', tab_id: 'tab-1' }));
  r = ends('terminal_run')[0];
  check('busy: running in a busy tab errors with advice', !r.ok && /is busy running "sleep 20; echo late"/.test(r.result), r.result);
  await run('stop it', call('terminal_stop', { tab_id: 'tab-1' }));
  r = ends('terminal_stop')[0];
  check('stop: sent ctrl-c naming the command', r.ok && r.result === 'Sent Ctrl-C to tab-1 (sleep 20; echo late).', r.result);
  await new Promise((res) => setTimeout(res, 800));
  await terminal.read('tab-1', 5, 0);
  check('stop: tab idle afterwards', !terminal.get('tab-1').running);

  // --- errors ---
  await run('bad tab', call('terminal_read', { tab_id: 'tab-9' }));
  r = ends('terminal_read')[0];
  check('error: unknown tab lists the open ones', !r.ok && /No terminal tab tab-9\. Open tabs: tab-1\./.test(r.result), r.result);
  await run('empty', call('terminal_run', { command: '   ' }));
  r = ends('terminal_run')[0];
  check('error: empty command', !r.ok && /command is required/.test(r.result), r.result);

  // --- plan mode: read-only commands only ---
  config.permissionMode = 'plan';
  await run('plan', call('terminal_run', { command: 'touch planned.txt', tab_id: 'tab-1' }), call('terminal_run', { command: 'ls', tab_id: 'tab-1' }), call('terminal_read', {}));
  const planRuns = ends('terminal_run');
  check('plan: changing command refused', planRuns[0] && !planRuns[0].ok && /^Not permitted in plan mode/.test(planRuns[0].result), planRuns[0] && planRuns[0].result);
  check('plan: read-only command ran', planRuns[1] && planRuns[1].ok && /\[exit code: 0\]/.test(planRuns[1].result) && approvals().length === 0, planRuns[1] && planRuns[1].result);
  check('plan: terminal_read allowed', ends('terminal_read')[0].ok);
  check('plan: nothing was created', !fs.existsSync(path.join(tmp, 'planned.txt')));

  // --- auto mode: the guard pauses risky commands ---
  config.permissionMode = 'auto';
  onApproval = (ev) => agent.resolveApproval(ev.id, false, false);
  await run('auto', call('terminal_run', { command: 'echo safe', tab_id: 'tab-1' }), call('terminal_run', { command: 'sudo ls', tab_id: 'tab-1' }));
  const autoRuns = ends('terminal_run');
  check('auto: safe command ran without asking', autoRuns[0].ok && /safe\n\[exit code: 0\]/.test(autoRuns[0].result) && approvals().length === 1, autoRuns[0].result);
  check('auto: sudo asked with the reason and was denied', approvals()[0].reason === 'uses sudo' && approvals()[0].name === 'terminal_run' && !autoRuns[1].ok && /^Not permitted: the user denied/.test(autoRuns[1].result), autoRuns[1].result);

  // --- bypass ---
  config.permissionMode = 'bypass';
  await run('bypass', call('terminal_run', { command: 'echo free' }));
  r = ends('terminal_run')[0];
  check('bypass: ran in a new tab without asking', approvals().length === 0 && r.ok && /^\[terminal tab-2 \(zsh\)\]\nfree\n\[exit code: 0\]$/.test(r.result), r.result);
  check('bypass: two tabs now, tab events flowed', terminal.list().length === 2 && tabEvents.length > 5, terminal.list().map((t) => t.id));

  // --- the transcript keeps terminal rows as tool items ---
  const { toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const items = toTranscript(agent.session);
  check('transcript: terminal tool rows present', items.filter((i) => i.role === 'tool' && i.name.startsWith('terminal_')).length >= 8, items.filter((i) => i.role === 'tool').map((i) => i.name).join(','));

  terminal.closeAll();
  check('closeAll: no tabs left', terminal.list().length === 0);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
});
