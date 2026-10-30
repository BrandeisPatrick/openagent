// UX tick 2, part 1: turnSnapshot and rewindSession as pure functions. Run: node test-tick2.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { toTranscript, rewindSession, turnSnapshot } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { check, done } = require('./support/check.js');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tick2-'));
const f = (rel) => path.join(cwd, rel);
fs.writeFileSync(f('a.txt'), 'a0');
fs.writeFileSync(f('bin.dat'), Buffer.from([1, 0, 2]));

// turn 0: creates new.txt, edits a.txt, touches a binary
const t0 = { at: 0, createdAt: 1, text: 'first', files: {} };
turnSnapshot(t0, f('new.txt'));
turnSnapshot(t0, f('a.txt'));
turnSnapshot(t0, f('bin.dat'));
turnSnapshot(t0, f('a.txt'));
fs.writeFileSync(f('new.txt'), 'n1');
fs.writeFileSync(f('a.txt'), 'a1');
check('snapshot: absent file null, first content kept, binary skipped', t0.files[f('new.txt')] === null && t0.files[f('a.txt')] === 'a0' && t0.skipped.length === 1, t0);

require('./rewind-and-tasks-2.js')({ cwd, f, t0, read, toTranscript, rewindSession, turnSnapshot, check, done });
