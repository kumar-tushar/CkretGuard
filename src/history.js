(() => {
  'use strict';
  const type = 'ckretguard-history';
  const sites = Object.freeze({ 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'claude.ai': 'Claude' });
  function entry(prompt, count, source) {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !Object.hasOwn(sites, url.hostname) ||
        typeof prompt !== 'string' || !prompt.trim() || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid history entry');
    const conversation = url.hostname === 'claude.ai' ? /^\/chat\/[a-zA-Z0-9-]+$/ : /^\/c\/[a-zA-Z0-9-]+$/;
    return { id: crypto.randomUUID(), createdAt: Date.now(), site: sites[url.hostname],
      url: url.origin + (conversation.test(url.pathname) ? url.pathname : '/'), prompt, count };
  }
  async function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ckretguard-history', 1);
      request.onupgradeneeded = () => {
        const records = request.result.createObjectStore('prompts', { keyPath: 'id' });
        records.createIndex('createdAt', 'createdAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('History unavailable'));
    });
  }
  async function perform(action, value) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('prompts', action === 'list' ? 'readonly' : 'readwrite');
        const records = transaction.objectStore('prompts');
        const request = action === 'list' ? records.index('createdAt').getAll() :
          action === 'record' ? records.add(value) : action === 'remove' ? records.delete(value) : records.clear();
        transaction.oncomplete = () => resolve(action === 'list' ? request.result.reverse() : undefined);
        transaction.onabort = () => reject(new Error('History unavailable'));
        transaction.onerror = () => reject(new Error('History unavailable'));
      });
    } finally { db.close(); }
  }
  async function request(action, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, action, ...extra });
    if (!response?.ok) throw new Error('History unavailable');
    return response.entries;
  }
  globalThis.SecretShieldHistory = Object.freeze({ type, entry, perform, request });
})();
