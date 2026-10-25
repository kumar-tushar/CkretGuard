'use strict';
importScripts('core.js', 'policy.js', 'stats.js', 'history.js');

chrome.runtime.onInstalled.addListener(async () => {
  try {
    for (const script of chrome.runtime.getManifest().content_scripts) {
      const tabs = await chrome.tabs.query({ url: script.matches });
      await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(async tab => {
        const target = { tabId: tab.id };
        await Promise.allSettled([
          chrome.scripting.executeScript({ target, files: script.js, injectImmediately: true }),
          ...(script.css?.length ? [chrome.scripting.insertCSS({ target, files: script.css })] : []),
        ]);
      }));
    }
  } catch { /* Closed tabs and restricted site access must not break the worker. */ }
});

// Serialize policy, activity, and History changes across views.
let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === SecretShieldPolicy.type) {
    try {
      const source = new URL(sender.url);
      if (sender.id !== chrome.runtime.id || source.protocol !== 'chrome-extension:' ||
          source.hostname !== chrome.runtime.id || source.pathname !== '/composer.html') throw new Error();
    } catch { reply({ ok: false }); return; }
    const update = pending.then(() => SecretShieldPolicy.apply(message.change));
    pending = update.catch(() => {});
    update.then(() => reply({ ok: true }), error => reply({ ok: false,
      error: error instanceof SecretShieldCore.ScanError ? 'invalid' :
        ['duplicate', 'limit', 'managed'].includes(error.message) ? error.message : 'unavailable' }));
    return true;
  }
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
            !['list', 'read', 'remove', 'clear'].includes(message.action)) throw new Error();
        if (['remove','read'].includes(message.action) && (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id))) throw new Error();
        if (message.action === 'read') {
          if (!Number.isSafeInteger(message.offset) || message.offset < 0) throw new Error();
          value = { id: message.id, offset: message.offset };
        } else if (message.action === 'list') {
          if (message.before && (!Number.isSafeInteger(message.before.time) || typeof message.before.id !== 'string' ||
              !/^[a-f0-9-]{36}$/.test(message.before.id))) throw new Error();
          value = message.before;
        } else value = message.id;
      }
    } catch { reply({ ok: false }); return; }
    const update = pending.then(() => SecretShieldHistory.perform(message.action, value));
    pending = update.catch(() => {});
    update.then(result => {
      reply({ ok: true, ...result });
      if (['record','remove','clear'].includes(message.action) || result.removed) void chrome.runtime.sendMessage({ type: 'ckretguard-history-changed' }).catch(() => {});
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

if (chrome.alarms) {
  const prune = () => {
    const update = pending.then(() => SecretShieldHistory.perform('prune'));
    pending = update.catch(() => {});
    void update.then(result => {
      if (result.removed) void chrome.runtime.sendMessage({ type: 'ckretguard-history-changed' }).catch(() => {});
    }).catch(() => {});
  };
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'history-retention') prune(); });
  void chrome.alarms.create('history-retention', { periodInMinutes: 60 }).catch(() => {});
  prune();
}
