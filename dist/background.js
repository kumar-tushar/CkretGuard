'use strict';
importScripts('stats.js');

// Serialize counter writes from all tabs without storing prompts or event history.
let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
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
