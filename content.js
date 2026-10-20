'use strict';
/*
 * Instagram /silent — content script.
 *
 * What it does: on instagram.com/direct/… (the Messages view), whenever the message box is
 * EMPTY (chat opened, or a message was just sent) it types "/silent " into it, so the next
 * message is a silent one without typing the command by hand.
 *
 * What it never does: it does not send anything, does not read message text, does not touch
 * the network and stores only two settings (on/off and the command text).
 *
 * Structure: createController(env) holds all decisions and is unit-tested in Node with a fake
 * env; realEnv() is the only code that touches the Instagram page.
 */

const DEFAULTS = {enabled: true, command: '/silent'};
const RETRY_LIMIT = 3;           // failed insert attempts per chat before giving up quietly
const COMPOSER_SELECTOR = 'div[contenteditable="true"][role="textbox"]';

function sanitizeCommand(value) {
  const v = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 32);
  return v || DEFAULTS.command;
}

function createController(env) {
  const state = {
    enabled: true,
    command: DEFAULTS.command,
    suppressed: false,   // the user deliberately emptied the box: leave it alone
    failures: 0,
    busy: false,
    own: false,          // true while WE are editing, so our own edits are not read as user input
    path: env.path(),
  };

  const prefix = () => `${state.command} `;
  const hasPrefix = el => env.text(el).startsWith(state.command);

  function syncPath() {
    const p = env.path();
    if (p !== state.path) {      // another chat: forget per-chat decisions
      state.path = p;
      state.suppressed = false;
      state.failures = 0;
    }
  }

  // Returns a short reason string (used by tests and diagnostics).
  async function check() {
    if (!state.enabled || state.busy) return 'skipped';
    syncPath();
    if (!env.isChat()) return 'not-chat';
    if (state.suppressed) return 'suppressed';
    if (state.failures >= RETRY_LIMIT) return 'gave-up';
    const el = env.findComposer();
    if (!el) return 'no-composer';
    if (!env.isEmpty(el)) return 'not-empty';
    if (!env.canTakeFocus(el)) return 'focus-elsewhere';   // never steal focus from another field

    state.busy = true;
    state.own = true;
    try {
      env.insert(el, prefix());
      await env.sleep(60);
      if (!hasPrefix(el) && env.isEmpty(el)) {
        await env.sleep(100);                              // the editor may apply the edit late
        if (!hasPrefix(el) && env.isEmpty(el)) {
          env.paste(el, prefix());                         // fallback path
          await env.sleep(100);
        }
      }
      if (hasPrefix(el)) {
        state.failures = 0;
        return 'inserted';
      }
      state.failures += 1;
      if (state.failures >= RETRY_LIMIT)
        env.warn('could not type into the message box; Instagram layout may have changed');
      return 'failed';
    } catch (e) {
      state.failures += 1;
      return 'error';
    } finally {
      state.busy = false;
      state.own = false;
    }
  }

  // Called for every beforeinput/input event in the page. The user emptying the box by
  // deleting must stick; typing again re-enables the prefill for the next send.
  function onUserInput(inputType, target) {
    if (!state.enabled || state.own) return;
    const el = env.composerOf(target);
    if (!el) return;
    if (inputType.startsWith('delete') || inputType === 'historyUndo') {
      env.after(40, () => {                                // look at the result of the deletion
        if (!state.own && env.isEmpty(el)) state.suppressed = true;
      });
    } else if (inputType.startsWith('insert')) {
      state.suppressed = false;
    }
  }

  // Removes our own untouched prefill (used when the switch is turned off).
  function clearPrefill(command = state.command) {
    const el = env.isChat() ? env.findComposer() : null;
    if (!el || env.text(el) !== command) return false;     // user typed more: keep their text
    state.own = true;
    try { env.clear(el); } finally { state.own = false; }
    return true;
  }

  function setEnabled(value) {
    const next = !!value;
    if (!next && state.enabled) clearPrefill();
    state.enabled = next;
    if (next) {
      state.suppressed = false;
      state.failures = 0;
    }
  }

  function setCommand(value) {
    const next = sanitizeCommand(value);
    if (next === state.command) return;
    if (state.enabled) clearPrefill(state.command);        // swap our old prefill for the new one
    state.command = next;
    state.failures = 0;
  }

  return {state, check, onUserInput, clearPrefill, setEnabled, setCommand};
}

// ---------------------------------------------------------------------------------------
// The only part that touches the Instagram page.
function realEnv() {
  const clean = s => (s || '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();

  function caretToEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  return {
    path: () => location.pathname,
    isChat: () => location.pathname.startsWith('/direct/'),   // not stories, comments or the feed

    // The composer is the visible contenteditable textbox lowest on the screen.
    findComposer() {
      let best = null;
      let bestBottom = -Infinity;
      for (const el of document.querySelectorAll(COMPOSER_SELECTOR)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.bottom > bestBottom) { best = el; bestBottom = r.bottom; }
      }
      return best;
    },
    composerOf: t => (t instanceof Element ? t.closest(COMPOSER_SELECTOR) : null),
    text: el => clean(el.textContent),
    isEmpty: el => clean(el.textContent) === '',

    canTakeFocus(el) {
      const a = document.activeElement;
      if (!a || a === document.body || a === el || el.contains(a)) return true;
      return !(a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    },

    // Primary path: a real "typed text" edit, which Instagram's editor accepts.
    insert(el, text) {
      el.focus({preventScroll: true});
      caretToEnd(el);
      document.execCommand('insertText', false, text);
    },

    // Fallback: simulate pasting plain text.
    paste(el, text) {
      el.focus({preventScroll: true});
      caretToEnd(el);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    },

    clear(el) {
      el.focus({preventScroll: true});
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    },

    sleep: ms => new Promise(r => setTimeout(r, ms)),
    after: (ms, fn) => setTimeout(fn, ms),
    warn: msg => console.warn(`[ig-silent] ${msg}`),
  };
}

function bootstrap() {
  if (typeof browser === 'undefined' || !browser.storage) return;
  const ctl = createController(realEnv());
  let observer = null;
  let timer = 0;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.check(), 150);   // debounce bursts of DOM changes
  };
  const start = () => {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, {childList: true, subtree: true});
    schedule();
  };
  const stop = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  };
  const apply = ({enabled, command}) => {
    ctl.setCommand(command);
    ctl.setEnabled(enabled);
    if (ctl.state.enabled) start(); else stop();
  };

  for (const type of ['beforeinput', 'input'])
    document.addEventListener(type, e => ctl.onUserInput(e.inputType || '', e.target), true);

  browser.storage.local.get(DEFAULTS).then(apply).catch(() => apply(DEFAULTS));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    apply({
      enabled: changes.enabled ? changes.enabled.newValue !== false : ctl.state.enabled,
      command: changes.command ? changes.command.newValue : ctl.state.command,
    });
  });
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = {createController, sanitizeCommand, DEFAULTS, RETRY_LIMIT};
else
  bootstrap();
