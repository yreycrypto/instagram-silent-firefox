'use strict';
const DEFAULTS = {enabled: true, command: '/silent'};
const ru = (navigator.language || '').toLowerCase().startsWith('ru');
const T = ru ? {
  on: 'Включено: пустое поле сообщения заполняется «{c}» само.',
  off: 'Выключено: поле сообщения не меняется.',
  advanced: 'Настройки',
  commandLabel: 'Команда',
  hint: 'Работает на instagram.com/direct. Если Instagram сменит команду (раньше была @silent), измените её здесь.',
} : {
  on: 'On: an empty message box is filled with “{c}” automatically.',
  off: 'Off: the message box is left alone.',
  advanced: 'Settings',
  commandLabel: 'Command',
  hint: 'Works on instagram.com/direct. If Instagram changes the command (it used to be @silent), change it here.',
};

const $ = id => document.getElementById(id);
const toggle = $('toggle');
const commandInput = $('command');

function render(state) {
  toggle.checked = state.enabled;
  $('title').textContent = `${state.command} mode`;
  $('status').textContent = (state.enabled ? T.on : T.off).replace('{c}', state.command);
}

async function load() {
  const state = await browser.storage.local.get(DEFAULTS);
  $('advanced').textContent = T.advanced;
  $('commandLabel').textContent = T.commandLabel;
  $('commandHint').textContent = T.hint;
  commandInput.value = state.command;
  render(state);
}

toggle.addEventListener('change', async () => {
  await browser.storage.local.set({enabled: toggle.checked});
  render(await browser.storage.local.get(DEFAULTS));
});

commandInput.addEventListener('change', async () => {
  const value = commandInput.value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 32);
  if (!value) {                        // empty is not allowed: restore the saved value
    commandInput.value = (await browser.storage.local.get(DEFAULTS)).command;
    return;
  }
  await browser.storage.local.set({command: value});
  commandInput.value = value;
  render(await browser.storage.local.get(DEFAULTS));
});

load();
