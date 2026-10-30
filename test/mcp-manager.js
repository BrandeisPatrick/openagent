// McpManager and its helpers against the scratch stdio server. Run: node test-manager.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { McpManager, parseServerSpec, expandEnvRefs, readProjectServers, contentToResult, approvalDetail } = require(path.join(projectDir, 'dist/main/mcp.js'));
const TEST_SERVER = path.join(__dirname, 'support', 'test-mcp-server.js');

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 500));
};
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const rejectsWith = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- helpers ----
  let r = parseServerSpec('fs', 'npx -y @scope/server-fs ~/Documents "two words"');
  check('spec: command line', r.fs && r.fs.command === 'npx' && JSON.stringify(r.fs.args) === JSON.stringify(['-y', '@scope/server-fs', '~/Documents', 'two words']), r);
  r = parseServerSpec('web', 'https://example.com/mcp');
  check('spec: URL → http', r.web && r.web.type === 'http' && r.web.url === 'https://example.com/mcp');
  r = parseServerSpec('one', '{"command": "node", "args": ["x.js"], "env": {"A": "1"}}', { B: '2' });
  check('spec: JSON single + env merged', r.one && r.one.command === 'node' && r.one.env.A === '1' && r.one.env.B === '2');
  r = parseServerSpec('ignored', '{"mcpServers": {"a": {"command": "a-cmd"}, "b": {"type": "sse", "url": "http://h/sse"}}}');
  check('spec: mcpServers block → both, name ignored', Object.keys(r).join(',') === 'a,b' && r.b.type === 'sse');
  r = parseServerSpec('', '{"github": {"command": "gh-mcp"}}');
  check('spec: named single entry', r.github && r.github.command === 'gh-mcp');
  check('spec: bad JSON rejected', throwsWith(() => parseServerSpec('x', '{not json'), /could not be parsed/));
  check('spec: empty rejected', throwsWith(() => parseServerSpec('x', '   '), /Enter a command line/));
  check('spec: missing name rejected', throwsWith(() => parseServerSpec('', 'node x.js'), /Give the server a name/));
  check('spec: bad name rejected', throwsWith(() => parseServerSpec('bad name!', 'node x.js'), /Server names use/));
  check('spec: env ignored for http', !parseServerSpec('w', 'https://x.y/z', { A: '1' }).w.env);
  check('env refs: ${HOME}, default, unset', expandEnvRefs('${HOME}/a ${NOPE_X:-dflt} [${NOPE_Y}]') === `${os.homedir()}/a dflt []`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-'));
  check('project: missing file → empty', Object.keys(readProjectServers(tmp).servers).length === 0 && !readProjectServers(tmp).fileError);
  fs.writeFileSync(path.join(tmp, '.mcp.json'), '{"mcpServers": {"good": {"command": "node"}, "bad": {"args": []}}}');
  r = readProjectServers(tmp);
  check('project: valid + invalid entries', r.servers.good && r.servers.good.command === 'node' && /needs a "command"/.test(r.invalid.bad));
  fs.writeFileSync(path.join(tmp, '.mcp.json'), '{oops');
  check('project: malformed file reported', /could not be read/.test(readProjectServers(tmp).fileError));

  check('content: text joined', contentToResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }).content === 'a\nb');
  let c = contentToResult({ content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: 'pic' }] });
  check('content: image → data URL + note', c.image === 'data:image/png;base64,aGk=' && /\[image: image\/png/.test(c.content) && /pic/.test(c.content));
  check('content: resource text', /\[resource file:\/\/x\]\nhello/.test(contentToResult({ content: [{ type: 'resource', resource: { uri: 'file://x', text: 'hello' } }] }).content));
  check('content: isError prefix', contentToResult({ content: [{ type: 'text', text: 'nope' }], isError: true }).content === 'Error: nope');
  check('content: empty → (no output)', contentToResult({ content: [] }).content === '(no output)');
  check('content: structured fallback', /"k": 1/.test(contentToResult({ content: [], structuredContent: { k: 1 } }).content));
  check('approval detail bounded', approvalDetail({ big: 'x'.repeat(5000) }).length < 2100 && /…$/.test(approvalDetail({ big: 'x'.repeat(5000) })));

  // ---- manager lifecycle ----
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-cwd-'));
  const srv = (extraEnv = {}, args = []) => ({ command: 'node', args: [TEST_SERVER, ...args], env: { OC_PROJECT: projectDir, ...extraEnv } });
  let config = {
    mcpServers: { test: srv(), missing: { command: 'definitely-not-a-command-xyz' }, exits: srv({ OC_TEST_CRASH: '1' }), 'my.server': srv() },
    mcpTrusted: {},
  };
  const saved = [];
  const m = new McpManager({ getConfig: () => config, saveConfig: (p) => { saved.push(p); config = { ...config, ...p }; }, cwd: () => cwd });
  let eventCount = 0;
  m.on('servers', () => eventCount++);
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: srv(), bad: { args: [] } } }, null, 2));
  await m.reload();
  const by = () => Object.fromEntries(m.list().map((s) => [`${s.scope}:${s.name}`, s]));
  let s = by();
  check('user server connected with 8 tools', s['user:test'].status === 'connected' && s['user:test'].tools.length === 8 && s['user:test'].serverInfo.name === 'oc-test-server', s['user:test'].error);
  check('tool names mcp__server__tool with annotations', s['user:test'].tools.find((t) => t.name === 'echo').fullName === 'mcp__test__echo' && s['user:test'].tools.find((t) => t.name === 'echo').readOnly && s['user:test'].tools.find((t) => t.name === 'remove_item').destructive && !s['user:test'].tools.find((t) => t.name === 'add').readOnly);
  check('dotted server name sanitised', s['user:my.server'].tools[0].fullName === 'mcp__my_server__echo');
  check('project server blocked until enabled', s['project:proj'].status === 'blocked' && /Enable it in Settings/.test(s['project:proj'].error));
  check('invalid project entry reported', s['project:bad'].status === 'error' && /Invalid entry/.test(s['project:bad'].error));
  check('missing command reported', s['user:missing'].status === 'error' && /Command not found: definitely-not-a-command-xyz/.test(s['user:missing'].error), s['user:missing'].error);
  check('early exit reported with stderr', s['user:exits'].status === 'error' && /exited right after starting/.test(s['user:exits'].error) && /refusing to start/.test(s['user:exits'].error), s['user:exits'].error);
  check('list order: project first, then alphabetical', m.list().map((x) => `${x.scope}:${x.name}`).join(' ') === 'project:bad project:proj user:exits user:missing user:my.server user:test');
  check('servers events emitted', eventCount >= 3, eventCount);
  check('describe lists connected servers only', /^- my\.server \(8 tools\)/m.test(m.describe()) && /^- test \(8 tools\): echo, add/m.test(m.describe()) && !/proj|missing/.test(m.describe()), m.describe());

  await m.setEnabled('proj', 'project', true);
  s = by();
  check('enabling a project server trusts and connects it', s['project:proj'].status === 'connected' && s['project:proj'].tools.length === 8 && config.mcpTrusted[cwd].includes('proj'));
  check('tools() offers connected servers', m.tools().some((t) => t.name === 'mcp__proj__echo') && m.tools().some((t) => t.name === 'mcp__test__echo') && m.tools().every((t) => t.mcp && t.parameters.type === 'object'));
  await m.setEnabled('proj', 'project', false);
  check('disabling a project server blocks it again', by()['project:proj'].status === 'blocked' && !config.mcpTrusted[cwd].includes('proj'));
  await m.setEnabled('test', 'user', false);
  check('disabling a user server', by()['user:test'].status === 'disabled' && config.mcpServers.test.disabled === true && !m.tools().some((t) => t.name === 'mcp__test__echo'));
  await m.setEnabled('test', 'user', true);
  check('re-enabling a user server', by()['user:test'].status === 'connected' && config.mcpServers.test.disabled === undefined);

  await m.add('fs2', `node ${TEST_SERVER} --flag`, 'user', { OC_PROJECT: projectDir });
  check('add: command line into user scope, connected', by()['user:fs2'].status === 'connected' && config.mcpServers.fs2.args[1] === '--flag' && config.mcpServers.fs2.env.OC_PROJECT === projectDir);
  check('add: duplicate name rejected', await rejectsWith(m.add('fs2', 'node x', 'user'), /already exists/));
  await m.add('', JSON.stringify({ mcpServers: { p1: srv(), p2: srv() } }), 'project');
  const projFile = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
  check('add: mcpServers block into .mcp.json, kept the existing entries', projFile.mcpServers.proj && projFile.mcpServers.p1 && projFile.mcpServers.p2 && projFile.mcpServers.bad);
  s = by();
  check('add: project servers added by the user are trusted and connected', s['project:p1'].status === 'connected' && s['project:p2'].status === 'connected' && config.mcpTrusted[cwd].includes('p2'));
  await m.remove('fs2', 'user');
  check('remove: user server gone', !by()['user:fs2'] && !config.mcpServers.fs2);
  await m.remove('p2', 'project');
  check('remove: project server removed from .mcp.json', !by()['project:p2'] && !JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers.p2);
  check('remove: unknown rejected', await rejectsWith(m.remove('nope', 'user'), /No server named/));

  const before = m.list().find((x) => x.name === 'test').tools.length;
  await m.reconnect('test', 'user');
  check('reconnect keeps the tools', by()['user:test'].status === 'connected' && by()['user:test'].tools.length === before);

  // calls through the Tool objects
  const tool = m.tools().find((t) => t.name === 'mcp__test__echo');
  let approved = [];
  const ctx = { approve: async (name, detail) => { approved.push({ name, detail }); return { ok: true }; } };
  let res = await tool.run({ text: 'hey' }, ctx);
  check('Tool.run asks for approval with pretty JSON detail then calls', res.content === 'echo: hey' && approved[0].name === 'mcp__test__echo' && approved[0].detail === '{\n  "text": "hey"\n}');
  res = await tool.run({ text: 'no' }, { approve: async () => ({ ok: false, message: 'Not permitted: test' }) });
  check('Tool.run returns the denial message', res.content === 'Not permitted: test');
  res = await m.call('mcp__test__cwd', {});
  check('stdio server runs in the working directory', res.content === fs.realpathSync(cwd) || res.content === cwd, res.content);
  const ac = new AbortController();
  const t0 = Date.now();
  const slow = m.call('mcp__test__slow', { ms: 5000 }, ac.signal);
  setTimeout(() => ac.abort(), 100);
  check('call honours the abort signal', await rejectsWith(slow, /abort|cancel/i) && Date.now() - t0 < 2000);
  check('unknown tool rejected', await rejectsWith(m.call('mcp__test__none', {}), /Unknown MCP tool/));

  // a config change replaces the connection; an unchanged one is kept
  const gen0 = eventCount;
  await m.reload();
  check('reload without changes is quiet', by()['user:test'].status === 'connected' && eventCount - gen0 <= 1, eventCount - gen0);
  config = { ...config, mcpServers: { ...config.mcpServers, test: srv({ EXTRA: '1' }) } };
  await m.reload();
  res = await m.call('mcp__test__env', { name: 'EXTRA' });
  check('changed config reconnects with the new env', res.content === '1');

  await m.close();
  check('close empties the list', m.list().length === 0 && m.tools().length === 0);
  await sleep(100);
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
