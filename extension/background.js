'use strict';
importScripts('stats.js', 'history.js');

// Serialize activity and history changes from all tabs.
let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === SecretShieldHistory.type) {
    let value;
    try {
      if (sender.id !== chrome.runtime.id) throw new Error();
      if (message.action === 'record') {
        if (!sender.tab || sender.frameId !== 0) throw new Error();
        value = SecretShieldHistory.entry(message.prompt, message.count, sender.url);
      } else {
        const source = new URL(sender.url);
        if (source.protocol !== 'chrome-extension:' || source.hostname !== chrome.runtime.id || source.pathname !== '/composer.html' ||
            !['list', 'remove', 'clear'].includes(message.action)) throw new Error();
        if (message.action === 'remove' && (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id))) throw new Error();
        value = message.id;
      }
    } catch { reply({ ok: false }); return; }
    const update = pending.then(() => SecretShieldHistory.perform(message.action, value));
    pending = update.catch(() => {});
    update.then(entries => {
      reply({ ok: true, entries });
      if (message.action !== 'list') void chrome.runtime.sendMessage({ type: 'ckretguard-history-changed' }).catch(() => {});
    }, () => reply({ ok: false }));
    return true;
  }
  if (message?.type !== 'ckretguard-activity') return;
  const { kind, count } = message;
  const { key, valid, normalize } = SecretShieldStats;
  if (sender.id !== chrome.runtime.id || !valid(kind, count)) {
    reply({ ok: false });
    return;
  }
  const update = pending.then(async () => {
    const saved = await chrome.storage.local.get(key);
    const counters = normalize(saved[key]);
    counters[kind] = Math.min(Number.MAX_SAFE_INTEGER, counters[kind] + count);
    await chrome.storage.local.set({ [key]: counters });
  });
  pending = update.catch(() => {});
  update.then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});
