// Project instructions: loading order, truncation and the "#" shortcut's append. Run: node test/instructions.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { loadInstructions, instructionsPrompt, appendInstruction } = require(path.join(projectDir, 'dist/main/instructions.js'));
const { check, done } = require('./support/check.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr-'));
const read = (name) => fs.readFileSync(path.join(cwd, name), 'utf8');

let r = appendInstruction(cwd, '  always run   npm test  ');
check('append creates OPENAGENT.md with a header and the bullet', r.label === 'OPENAGENT.md' && read('OPENAGENT.md') === '# Project instructions\n\nNotes for the agent working in this project.\n- always run npm test\n', read('OPENAGENT.md'));
r = appendInstruction(cwd, 'prefer small commits');
check('append adds to the existing file', read('OPENAGENT.md').endsWith('- always run npm test\n- prefer small commits\n') && r.path === path.join(cwd, 'OPENAGENT.md'));
let threw = false;
try { appendInstruction(cwd, '   '); } catch (e) { threw = /Nothing to add/.test(e.message); }
check('empty text rejected', threw);

const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr2-'));
fs.writeFileSync(path.join(cwd2, 'AGENTS.md'), '# Rules\nBe brief');
r = appendInstruction(cwd2, 'use tabs');
check('append goes to the existing project file and adds the missing newline', r.label === 'AGENTS.md' && fs.readFileSync(path.join(cwd2, 'AGENTS.md'), 'utf8') === '# Rules\nBe brief\n- use tabs\n');
const files = loadInstructions(cwd2);
check('loader picks AGENTS.md and the prompt names it', files.some((f) => f.label === 'AGENTS.md' && /use tabs/.test(f.text)) && /Instructions from AGENTS\.md/.test(instructionsPrompt(files)));
fs.writeFileSync(path.join(cwd2, 'OPENAGENT.md'), 'x'.repeat(30000));
const big = loadInstructions(cwd2).find((f) => f.label === 'OPENAGENT.md');
check('OPENAGENT.md wins and long files are truncated', big && big.truncated && big.text.length < 24100 && !loadInstructions(cwd2).some((f) => f.label === 'AGENTS.md'));
done();
