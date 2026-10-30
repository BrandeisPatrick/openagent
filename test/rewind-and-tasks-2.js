// UX tick 2, part 2: rewind scenarios on a hand-built session.
module.exports = ({ cwd, f, t0, read, toTranscript, rewindSession, turnSnapshot, check, done }) => {
  const fs = require('node:fs');
  // turn 1: edits a.txt again and creates b.txt
  const t1 = { at: 4, createdAt: 2, text: 'second', files: {} };
  turnSnapshot(t1, f('a.txt'));
  fs.writeFileSync(f('a.txt'), 'a2');
  turnSnapshot(t1, f('b.txt'));
  fs.writeFileSync(f('b.txt'), 'b1');
  const msg = (role, content) => ({ role, content });
  const s = {
    id: 's', title: 't', createdAt: 0, updatedAt: 0,
    messages: [msg('user', 'first'), msg('assistant', 'x'), msg('user', 'mid'), msg('assistant', 'y'), msg('user', 'second'), msg('assistant', 'z')],
    turns: [t0, t1], lastPrompt: { tokens: 100, at: 6 },
  };
  const items = toTranscript(s);
  check('transcript marks checkpointed user messages only', items[0].turn === 0 && items[2].turn === undefined && items[4].turn === 1, items.map((i) => i.turn));
  let r = rewindSession(s, cwd, 1);
  check('rewind to the middle: a.txt back to a1, b.txt removed, new.txt kept', read(f('a.txt')) === 'a1' && read(f('b.txt')) === null && read(f('new.txt')) === 'n1', r);
  check('result lists relative paths and the text', r.text === 'second' && r.restored.join() === 'a.txt' && r.deleted.join() === 'b.txt' && r.skipped.length === 0, r);
  check('conversation cut before the message, earlier turn kept, lastPrompt dropped', s.messages.length === 4 && s.turns.length === 1 && s.lastPrompt === undefined);
  r = rewindSession(s, cwd, 0);
  check('rewind to the start restores the original state', read(f('a.txt')) === 'a0' && read(f('new.txt')) === null && s.messages.length === 0 && s.turns.length === 0 && r.text === 'first' && r.skipped.join() === 'bin.dat', r);
  let threw = false;
  try { rewindSession(s, cwd, 0); } catch (e) { threw = /no longer/.test(e.message); }
  check('rewinding to a missing checkpoint throws', threw);
  require('./rewind-and-tasks-3.js')({ check, done }).catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
};
