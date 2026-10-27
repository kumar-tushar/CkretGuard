(() => {
  'use strict';
  const type = 'ckretguard-history';
  const RETENTION_DAYS = 90, PAGE_SIZE = 200, CHUNK_SIZE = 1024 * 1024;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const sites = Object.freeze({ 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'claude.ai': 'Claude', 'gemini.google.com': 'Gemini', 'chat.deepseek.com': 'DeepSeek', 'grok.com': 'Grok', 'www.meta.ai': 'Meta AI', 'meta.ai': 'Meta AI' });
  function entry(prompt, count, source) {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !Object.hasOwn(sites, url.hostname) ||
        typeof prompt !== 'string' || !prompt.trim() || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid history entry');
    const conversation = url.hostname === 'claude.ai' ? /^\/chat\/[a-zA-Z0-9-]{1,256}$/ :
      url.hostname === 'gemini.google.com' ? /^\/(?:u\/[0-9]{1,3}\/)?app\/[a-zA-Z0-9-]{1,256}$/ :
      ['www.meta.ai', 'meta.ai'].includes(url.hostname) ? /^\/(?:prompt|c)\/[a-zA-Z0-9-]{1,256}$/ :
      url.hostname === 'chat.deepseek.com' ? /^\/a\/chat\/s\/[a-zA-Z0-9-]{1,256}$/ : /^\/c\/[a-zA-Z0-9-]{1,256}$/;
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
    if (!['record','list','read','remove','clear','prune'].includes(action)) throw new Error('Invalid history action');
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('prompts', 'readwrite');
        const records = transaction.objectStore('prompts');
        let result = {}, removed = 0;
        transaction.oncomplete = () => resolve({ ...result, removed });
        transaction.onabort = transaction.onerror = () => reject(new Error('History unavailable'));
        // Remove expired records before any read or write, including existing databases.
        const expired = records.index('createdAt').openKeyCursor(IDBKeyRange.upperBound(Date.now() - RETENTION_MS, true));
        expired.onsuccess = () => {
          const cursor = expired.result;
          if (cursor) { records.delete(cursor.primaryKey); removed++; cursor.continue(); return; }
          if (action === 'prune') return;
          if (action === 'record') { records.add(value); return; }
          if (action === 'remove') { records.delete(value); return; }
          if (action === 'clear') { records.clear(); return; }
          if (action === 'read') {
            const request = records.get(value.id);
            request.onsuccess = () => {
              const item = request.result;
              result = item ? { text: item.prompt.slice(value.offset, value.offset + CHUNK_SIZE),
                done: value.offset + CHUNK_SIZE >= item.prompt.length } : { missing: true };
            };
            return;
          }
          const entries = [];
          const request = records.index('createdAt').openCursor(value ? IDBKeyRange.upperBound(value.time) : null, 'prev');
          result = { entries, next: null };
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (value && cursor.key === value.time && cursor.primaryKey >= value.id) { cursor.continue(); return; }
            if (entries.length === PAGE_SIZE) {
              const last = entries.at(-1);
              result.next = { time: last.createdAt, id: last.id };
              return;
            }
            const { id, createdAt, site, url, count } = cursor.value;
            entries.push({ id, createdAt, site, url, count });
            cursor.continue();
          };
        };
      });
    } finally { db.close(); }
  }
  async function request(action, extra = {}) {
    const entries = [];
    let before = extra.before;
    do {
      const response = await chrome.runtime.sendMessage({ type, action, ...extra, ...(before ? { before } : {}) });
      if (!response?.ok) throw new Error('History unavailable');
      if (action !== 'list') return response;
      entries.push(...response.entries);
      before = response.next;
    } while (before);
    return entries;
  }
  async function readPrompt(id) {
    let text = '', done = false;
    while (!done) {
      const chunk = await request('read', { id, offset: text.length });
      if (chunk.missing || typeof chunk.text !== 'string' || (!chunk.text.length && !chunk.done)) throw new Error('History unavailable');
      text += chunk.text; done = chunk.done;
    }
    return text;
  }
  globalThis.SecretShieldHistory = Object.freeze({ type, entry, perform, request, readPrompt, RETENTION_DAYS });
})();
