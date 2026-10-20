'use strict';
// Run: node test/controller.test.js   (no dependencies)
const assert = require('node:assert/strict');
const {createController, sanitizeCommand, RETRY_LIMIT} = require('../content.js');

// Fake page: one composer whose text we control, every action is logged.
function makeEnv() {
  const e = {
    p: '/direct/t/100/', chat: true, hasComposer: true, focusOk: true,
    insertWorks: true, pasteWorks: true, insertLate: false,
    composer: {text: ''}, log: [], timers: [], warnings: [],
    path: () => e.p,
    isChat: () => e.chat,
    findComposer: () => (e.hasComposer ? e.composer : null),
    composerOf: t => t,
    text: el => el.text.trim(),
    isEmpty: el => el.text.trim() === '',
    canTakeFocus: () => e.focusOk,
    insert(el, t) { e.log.push('insert'); if (e.insertLate) e.pending = () => { el.text += t; }; else if (e.insertWorks) el.text += t; },
    paste(el, t) { e.log.push('paste'); if (e.pasteWorks) el.text += t; },
    clear(el) { e.log.push('clear'); el.text = ''; },
    sleeps: 0, lateAt: 1,
    sleep: async () => { e.sleeps++; if (e.pending && e.sleeps === e.lateAt) { e.pending(); e.pending = null; } },
    after: (ms, fn) => e.timers.push(fn),
    warn: m => e.warnings.push(m),
    flush() { const t = e.timers.splice(0); t.forEach(f => f()); },
  };
  return e;
}
const count = (e, what) => e.log.filter(x => x === what).length;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { console.log('  FAIL ' + name + '\n       ' + err.message); process.exitCode = 1; }
}

(async () => {
  await test('fills an empty box with "/silent " once', async () => {
    const e = makeEnv(), c = createController(e);
    assert.equal(await c.check(), 'inserted');
    assert.equal(e.composer.text, '/silent ');
    assert.equal(await c.check(), 'not-empty');      // does not add it twice
    assert.equal(count(e, 'insert'), 1);
    assert.equal(e.sleeps, 1);                         // no needless extra wait when it worked first time
  });

  await test('fills again after a message was sent (box emptied by Instagram)', async () => {
    const e = makeEnv(), c = createController(e);
    await c.check();
    e.composer.text = '';                              // send: the editor clears the box
    assert.equal(await c.check(), 'inserted');
    assert.equal(e.composer.text, '/silent ');
  });

  await test('a user who deletes the prefix is left alone', async () => {
    const e = makeEnv(), c = createController(e);
    await c.check();
    e.composer.text = '';                              // user deleted everything
    c.onUserInput('deleteContentBackward', e.composer); e.flush();
    assert.equal(await c.check(), 'suppressed');
    assert.equal(e.composer.text, '');
  });

  await test('after typing again, the next send gets the prefix back', async () => {
    const e = makeEnv(), c = createController(e);
    await c.check();
    e.composer.text = '';
    c.onUserInput('deleteContentBackward', e.composer); e.flush();
    e.composer.text = 'hi';
    c.onUserInput('insertText', e.composer);           // user types: suppression ends
    e.composer.text = '';                              // …and sends
    assert.equal(await c.check(), 'inserted');
  });

  await test('partial deletion (box not empty) does not suppress', async () => {
    const e = makeEnv(), c = createController(e);
    await c.check();
    e.composer.text = '/sil';
    c.onUserInput('deleteContentBackward', e.composer); e.flush();
    assert.equal(c.state.suppressed, false);
  });

  await test('opening another chat clears the suppression', async () => {
    const e = makeEnv(), c = createController(e);
    c.state.suppressed = true;
    e.p = '/direct/t/200/';
    assert.equal(await c.check(), 'inserted');
  });

  await test('does nothing outside /direct (feed, stories, comments)', async () => {
    const e = makeEnv(), c = createController(e);
    e.chat = false; e.p = '/stories/someone/1/';
    assert.equal(await c.check(), 'not-chat');
    assert.equal(e.composer.text, '');
  });

  await test('does nothing when there is no composer', async () => {
    const e = makeEnv(), c = createController(e);
    e.hasComposer = false;
    assert.equal(await c.check(), 'no-composer');
  });

  await test('never steals focus from another text field', async () => {
    const e = makeEnv(), c = createController(e);
    e.focusOk = false;
    assert.equal(await c.check(), 'focus-elsewhere');
    assert.equal(count(e, 'insert'), 0);
  });

  await test('never overwrites a draft or typed text', async () => {
    const e = makeEnv(), c = createController(e);
    e.composer.text = 'draft I wrote';
    assert.equal(await c.check(), 'not-empty');
    assert.equal(e.composer.text, 'draft I wrote');
  });

  await test('disabled: no insert; turning off removes only the untouched prefill', async () => {
    const e = makeEnv(), c = createController(e);
    await c.check();
    c.setEnabled(false);
    assert.equal(e.composer.text, '');                 // untouched prefill removed
    e.composer.text = '';
    assert.equal(await c.check(), 'skipped');
    assert.equal(e.composer.text, '');
    c.setEnabled(true);
    e.composer.text = '/silent hello';
    c.setEnabled(false);
    assert.equal(e.composer.text, '/silent hello');    // user's text is kept
  });

  await test('falls back to paste when the first insert does not land', async () => {
    const e = makeEnv(), c = createController(e);
    e.insertWorks = false;
    assert.equal(await c.check(), 'inserted');
    assert.deepEqual(e.log, ['insert', 'paste']);
    assert.equal(e.composer.text, '/silent ');
  });

  await test('a late edit by the editor is not doubled by the fallback', async () => {
    for (const lateAt of [1, 2]) {                     // lands during the 1st or the 2nd wait
      const e = makeEnv(), c = createController(e);
      e.insertLate = true; e.lateAt = lateAt;
      assert.equal(await c.check(), 'inserted', `lateAt=${lateAt}`);
      assert.equal(count(e, 'paste'), 0, `lateAt=${lateAt}`);
      assert.equal(e.composer.text, '/silent ', `lateAt=${lateAt}`);
    }
  });

  await test('gives up quietly after repeated failures (no endless retry loop)', async () => {
    const e = makeEnv(), c = createController(e);
    e.insertWorks = false; e.pasteWorks = false;
    for (let i = 0; i < RETRY_LIMIT; i++) assert.equal(await c.check(), 'failed');
    assert.equal(await c.check(), 'gave-up');
    assert.equal(e.log.filter(x => x === 'insert').length, RETRY_LIMIT);
    assert.equal(e.warnings.length, 1);                // one warning, not a flood
    e.p = '/direct/t/300/';                            // new chat: tries again
    assert.equal(await c.check(), 'failed');
  });

  await test('concurrent checks insert only once', async () => {
    const e = makeEnv(), c = createController(e);
    const [a, b] = await Promise.all([c.check(), c.check()]);
    assert.deepEqual([a, b].sort(), ['inserted', 'skipped']);
    assert.equal(e.composer.text, '/silent ');
  });

  await test('our own edits are not mistaken for user input', async () => {
    const e = makeEnv(), c = createController(e);
    const p = c.check();
    c.onUserInput('deleteContentBackward', e.composer); e.flush();   // fires while we are editing
    await p;
    assert.equal(c.state.suppressed, false);
  });

  await test('our own clear fires a delete event but must not suppress the prefill', async () => {
    const e = makeEnv(), c = createController(e);
    e.clear = el => { e.log.push('clear'); el.text = ''; c.onUserInput('deleteContentBackward', el); };  // like the browser
    c.setCommand('@silent');
    await c.check();                                   // box now "@silent "
    c.setCommand('/silent');                           // we clear it ourselves -> delete event
    e.flush();                                         // the delayed "is it empty?" look
    assert.equal(c.state.suppressed, false);
    assert.equal(await c.check(), 'inserted');
    assert.equal(e.composer.text, '/silent ');
  });

  await test('custom command is used; changing it swaps our old prefill', async () => {
    const e = makeEnv(), c = createController(e);
    c.setCommand('@silent');
    await c.check();
    assert.equal(e.composer.text, '@silent ');
    c.setCommand('/silent');
    assert.equal(e.composer.text, '');
    assert.equal(await c.check(), 'inserted');
    assert.equal(e.composer.text, '/silent ');
  });

  await test('command input is sanitised', () => {
    assert.equal(sanitizeCommand('  /silent \n'), '/silent');
    assert.equal(sanitizeCommand(''), '/silent');
    assert.equal(sanitizeCommand(null), '/silent');
    assert.equal(sanitizeCommand('x'.repeat(100)).length, 32);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
