(() => {
  'use strict';
  globalThis.SecretShieldDebug?.dispose();
  const key = 'debugLogs', type = 'ckretguard-debug', RETENTION_DAYS = 7, PAGE_SIZE = 200, CHUNK_SIZE = 1024 * 1024;
  const RETENTION_MS = RETENTION_DAYS * 86400000;
  const sites = { 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'claude.ai': 'Claude', 'gemini.google.com': 'Gemini', 'chat.deepseek.com': 'DeepSeek', 'grok.com': 'Grok', 'www.meta.ai': 'Meta AI', 'meta.ai': 'Meta AI' };
  const promptEvents = ['prompt.scanned', 'prompt.scan_failed', 'prompt.blocked'];
  const events = Object.freeze({
    'recording.started': ['info', 'Recording started'], 'recording.stopped': ['info', 'Recording stopped'],
    'worker.started': ['info', 'Extension worker started'], 'extension.installed': ['info', 'Extension installed'],
    'extension.updated': ['info', 'Extension updated or reloaded'], 'recovery.finished': ['info', 'Open-tab recovery finished'],
    'recovery.failed': ['error', 'Open-tab recovery failed'], 'guard.started': ['info', 'Prompt guard started'],
    'guard.stopped': ['info', 'Prompt guard retired'], 'policy.loaded': ['info', 'Protection settings loaded'],
    'policy.failed': ['error', 'Protection settings unavailable'], 'policy.updated': ['info', 'Protection settings saved'],
    'policy.update_failed': ['error', 'Could not save protection settings'], 'coverage.checked': ['info', 'Input coverage checked'],
    'coverage.failed': ['warn', 'Input coverage unavailable'], 'prompt.scanned': ['info', 'Prompt scanned'],
    'prompt.scan_failed': ['error', 'Prompt scan failed; sending blocked'], 'prompt.blocked': ['warn', 'Sending paused'],
    'review.opened': ['info', 'Secret review opened'], 'review.closed': ['info', 'Secret review closed'],
    'review.choice': ['info', 'Review action selected'], 'mask.applied': ['info', 'Detected values masked'],
    'send.waiting': ['info', 'Waiting for the website send control'], 'send.activated': ['info', 'Website send control activated; delivery not confirmed'],
    'send.failed': ['error', 'Could not activate the website send control'], 'notice.shown': ['warn', 'Guard notice shown'],
    'history.recorded': ['info', 'Unmasked send attempt saved to History'], 'history.removed': ['info', 'History entry deleted'],
    'history.cleared': ['info', 'History cleared'], 'history.pruned': ['info', 'Expired History entries deleted'],
    'history.failed': ['error', 'History operation failed'], 'activity.failed': ['error', 'Activity totals unavailable'],
    'dashboard.opened': ['info', 'Extension page opened'], 'runtime.error': ['error', 'Uncaught extension error'],
    'runtime.rejection': ['error', 'Unhandled extension promise rejection'], 'console.message': ['info', 'Extension console output'],
  });
  const choices = Object.freeze({
    action: ['Send', 'Edit', 'Mask', 'Cancel'], mode: ['redact', 'block'],
    trigger: ['keydown', 'pointerdown', 'click', 'submit'], method: ['log', 'info', 'warn', 'error', 'debug'],
    operation: ['addField', 'removeField', 'mode', 'protectClientIds', 'record', 'list', 'read', 'remove', 'clear', 'prune'],
    reason: ['context_invalidated', 'policy_loading', 'policy_unavailable', 'multiple_editors', 'draft_changed', 'send_unavailable',
      'scan_failed', 'storage_unavailable', 'duplicate', 'limit', 'managed', 'invalid', 'unknown'],
    errorName: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'ScanError', 'DOMException', 'QuotaExceededError'],
    file: ['debug.js', 'content.js', 'adapters.js', 'core.js', 'policy.js', 'stats.js', 'history.js', 'background.js', 'composer.js', 'dashboard.js', 'debug-view.js'],
  });
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  const numeric = ['chars', 'count', 'contextCount', 'editors', 'buttons', 'durationMs', 'line', 'column', 'arguments', 'removed', 'failed'];
  function details(value = {}) {
    const clean = {};
    if (!value || typeof value !== 'object') return clean;
    for (const name of numeric) if (Number.isSafeInteger(value[name]) && value[name] >= 0) clean[name] = value[name];
    for (const [name, values] of Object.entries(choices)) if (values.includes(value[name])) clean[name] = value[name];
    for (const name of ['ready', 'disabled']) if (typeof value[name] === 'boolean') clean[name] = value[name];
    if (uuid(value.attempt)) clean.attempt = value.attempt;
    return clean;
  }
  function siteForUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password && Object.hasOwn(sites, url.hostname) ? sites[url.hostname] : undefined;
    } catch { return undefined; }
  }
  function origin(sender) {
    if (sender?.id !== chrome.runtime.id) throw new Error('Invalid debug source');
    const url = new URL(sender.url);
    if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/composer.html') return { source: 'dashboard' };
    const site = siteForUrl(sender.url);
    if (!site ||
        !sender.tab || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab.id)) throw new Error('Invalid debug source');
    return { source: 'content', site, tabId: sender.tab.id };
  }
  function authorize(message, sender) {
    const context = origin(sender);
    if (message.action === 'record') {
      if (!Object.hasOwn(events, message.event) || message.event.startsWith('recording.')) throw new Error('Invalid debug event');
      if (context.source === 'dashboard' && Object.values(sites).includes(message.site) && Number.isSafeInteger(message.tabId)) {
        Object.assign(context, { site: message.site, tabId: message.tabId });
      }
    } else if (context.source !== 'dashboard' || !['list', 'read', 'clear'].includes(message.action)) throw new Error('Invalid debug action');
    if (message.action === 'read' && (!uuid(message.id) || !Number.isSafeInteger(message.offset) || message.offset < 0)) throw new Error('Invalid debug prompt');
    if (message.action === 'list' && message.before && (!Number.isSafeInteger(message.before.time) || !uuid(message.before.id))) throw new Error('Invalid debug page');
    return context;
  }
  function normalize(value) {
    const cutoff = Date.now() - RETENTION_MS;
    const entries = (Array.isArray(value?.entries) ? value.entries : []).filter(item =>
      uuid(item?.id) && Object.hasOwn(events, item.event) && Number.isSafeInteger(item.time) && item.time >= cutoff && item.time <= Date.now() &&
      ['worker', 'content', 'dashboard'].includes(item.source)).map(item => ({
      id: item.id, time: item.time, event: item.event, source: item.source, details: details(item.details),
      ...(uuid(item.session) ? { session: item.session } : {}),
      ...(uuid(item.promptId) ? { promptId: item.promptId } : {}),
      ...(['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok', 'Meta AI'].includes(item.site) ? { site: item.site } : {}),
      ...(Number.isSafeInteger(item.tabId) ? { tabId: item.tabId } : {}),
    }));
    return { entries, next: value?.next ?? null, count: Number.isSafeInteger(value?.count) ? value.count : entries.length, retentionDays: RETENTION_DAYS };
  }
  let pending = Promise.resolve(), revision = 0, migration;
  const session = (() => { try { return crypto.randomUUID(); } catch { return undefined; } })();
  async function database() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ckretguard-debug', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' }).createIndex('time', 'time');
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
        if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' }).createIndex('time', 'time');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Debug logs unavailable'));
    });
    try {
      if (!migration) migration = (async () => {
        let legacy = {};
        try { legacy = (await chrome.storage.local.get(key))[key] ?? {}; }
        catch { migration = null; return; }
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['events', 'metadata'], 'readwrite');
          const metadata = transaction.objectStore('metadata'), request = metadata.get('legacy-migrated');
          request.onsuccess = () => {
            if (request.result) return;
            for (const entry of normalize(legacy).entries) transaction.objectStore('events').put(entry);
            metadata.put(true, 'legacy-migrated');
          };
          transaction.oncomplete = resolve;
          transaction.onabort = transaction.onerror = () => reject(new Error('Debug logs unavailable'));
        });
      })().catch(error => { migration = null; throw error; });
      await migration;
      return db;
    } catch (error) { db.close(); throw error; }
  }
  async function notify() {
    // Do not replace legacy records if their migration read needs a retry.
    if (!migration) return;
    try { await chrome.storage.local.set({ [key]: { session, revision: ++revision } }); } catch {}
  }
  function perform(action, value = {}, context = { source: 'worker' }) {
    const task = pending.then(async () => {
      if (!['record', 'list', 'read', 'clear', 'prune'].includes(action) ||
          (action === 'record' && !Object.hasOwn(events, value.event))) throw new Error('Invalid debug action');
      if (action === 'read' && (!uuid(value.id) || !Number.isSafeInteger(value.offset) || value.offset < 0)) throw new Error('Invalid debug prompt');
      const db = await database();
      let removed = 0;
      try {
        const result = await new Promise((resolve, reject) => {
          const transaction = db.transaction(['events', 'prompts'], 'readwrite'), records = transaction.objectStore('events'), prompts = transaction.objectStore('prompts');
          const state = { entries: [], next: null, count: 0, retentionDays: RETENTION_DAYS };
          transaction.oncomplete = () => resolve(state);
          transaction.onabort = transaction.onerror = () => reject(new Error('Debug logs unavailable'));
          const expired = records.index('time').openKeyCursor(IDBKeyRange.upperBound(Date.now() - RETENTION_MS, true));
          const expiredPrompts = prompts.index('time').openKeyCursor(IDBKeyRange.upperBound(Date.now() - RETENTION_MS, true));
          expiredPrompts.onsuccess = () => {
            const cursor = expiredPrompts.result;
            if (cursor) { prompts.delete(cursor.primaryKey); cursor.continue(); }
          };
          expired.onsuccess = () => {
            const cursor = expired.result;
            if (cursor) { records.delete(cursor.primaryKey); removed++; cursor.continue(); return; }
            if (action === 'record') {
              const entry = { id: crypto.randomUUID(), time: Date.now(), ...(session ? { session } : {}),
                event: value.event, ...context, details: details(value.details) };
              const hasPrompt = context.source === 'content' && promptEvents.includes(value.event) && typeof value.prompt === 'string';
              const promptId = entry.details.attempt ?? (hasPrompt ? entry.id : undefined);
              if (promptId) {
                const request = prompts.get(promptId);
                request.onsuccess = () => {
                  // Attempt IDs alone never grant access to another tab's snapshot.
                  const saved = request.result, sameSource = saved?.site === context.site && saved?.tabId === context.tabId;
                  if (hasPrompt && !saved) {
                    prompts.put({ id: promptId, time: entry.time, site: context.site, tabId: context.tabId, prompt: value.prompt });
                    entry.promptId = promptId;
                  } else if (saved && sameSource) {
                    prompts.put({ ...saved, time: entry.time });
                    entry.promptId = promptId;
                  }
                  records.add(entry);
                  const count = records.count(); count.onsuccess = () => { state.count = count.result; };
                };
              } else {
                records.add(entry);
                const count = records.count(); count.onsuccess = () => { state.count = count.result; };
              }
            } else if (action === 'clear') { records.clear(); prompts.clear(); }
            if (action === 'read') {
              const request = prompts.get(value.id);
              request.onsuccess = () => {
                const prompt = request.result?.prompt;
                if (typeof prompt !== 'string') { Object.assign(state, { missing: true, text: '', done: true }); return; }
                const text = prompt.slice(value.offset, value.offset + CHUNK_SIZE);
                Object.assign(state, { text, done: value.offset + text.length >= prompt.length });
              };
            }
            if (action !== 'record') { const count = records.count(); count.onsuccess = () => { state.count = count.result; }; }
            if (action !== 'list') return;
            const before = value.before;
            const request = records.index('time').openCursor(before ? IDBKeyRange.upperBound(before.time) : null, 'prev');
            request.onsuccess = () => {
              const item = request.result;
              if (!item) return;
              if (before && item.key === before.time && item.primaryKey >= before.id) { item.continue(); return; }
              if (state.entries.length === PAGE_SIZE) {
                const last = state.entries.at(-1); state.next = { time: last.time, id: last.id }; return;
              }
              const [entry] = normalize({ entries: [item.value] }).entries;
              if (entry) state.entries.push(entry);
              item.continue();
            };
          };
        });
        if (action === 'record' || action === 'clear' || removed) await notify();
        return result;
      } finally { db.close(); }
    });
    pending = task.catch(() => {});
    return task;
  }
  async function write(event, data = {}, context) {
    try { await perform('record', { event, details: data }, context); return true; }
    catch { return false; }
  }
  const worker = typeof document === 'undefined';
  async function record(event, data = {}, context = {}) {
    try {
      if (!Object.hasOwn(events, event)) return false;
      if (worker) return await write(event, data);
      return (await chrome.runtime.sendMessage({ type, action: 'record', event, details: details(data),
        ...(typeof context.prompt === 'string' && promptEvents.includes(event) ? { prompt: context.prompt } : {}),
        ...(Object.values(sites).includes(context.site) && Number.isSafeInteger(context.tabId) ? { site: context.site, tabId: context.tabId } : {}) }))?.ok === true;
    } catch { return false; }
  }
  function attempt() {
    try { return crypto.randomUUID(); } catch { return undefined; }
  }
  async function request(action, extra = {}) {
    const entries = [];
    let before = extra.before, state;
    do {
      const result = await chrome.runtime.sendMessage({ type, action: action === 'export' ? 'list' : action, ...extra, ...(before ? { before } : {}) });
      if (!result?.ok) throw new Error('Debug logs unavailable');
      if (action === 'read') return result.state;
      state = normalize(result.state);
      entries.push(...state.entries);
      before = state.next;
    } while (action === 'export' && before);
    if (action === 'export' && extra.includePrompts) {
      const prompts = [];
      for (const id of new Set(entries.map(entry => entry.promptId).filter(Boolean))) {
        const prompt = await readPrompt(id);
        prompts.push({ id, ...(prompt === undefined ? { missing: true } : { prompt }) });
      }
      return { ...state, entries, prompts };
    }
    return { ...state, entries };
  }
  async function readPrompt(id) {
    let text = '', done = false;
    while (!done) {
      const chunk = await request('read', { id, offset: text.length });
      if (chunk.missing) return undefined;
      if (typeof chunk.text !== 'string' || (!chunk.text.length && !chunk.done)) throw new Error('Debug prompt unavailable');
      text += chunk.text; done = chunk.done;
    }
    return text;
  }
  function errorDetails(error) {
    const clean = {};
    try {
      if (choices.errorName.includes(error?.name)) clean.errorName = error.name;
      const stack = String(error?.stack ?? ''), prefix = chrome.runtime.getURL('');
      const location = stack.split('\n').find(line => line.includes(prefix));
      const match = location?.match(/\/([a-z-]+\.js):(\d+):(\d+)/);
      if (match && choices.file.includes(match[1])) Object.assign(clean, { file: match[1], line: Number(match[2]), column: Number(match[3]) });
      const message = String(error?.message ?? '');
      if (/context invalidated/i.test(message)) clean.reason = 'context_invalidated';
      else if (/quota|storage/i.test(message)) clean.reason = 'storage_unavailable';
      else if (/draft or policy changed/i.test(message)) clean.reason = 'draft_changed';
      else if (/send control unavailable/i.test(message)) clean.reason = 'send_unavailable';
    } catch {}
    return clean;
  }
  let cleanup = () => {};
  function install(signal) {
    cleanup();
    if (typeof globalThis.addEventListener !== 'function') return;
    const listeners = [];
    const listen = (type, callback) => { globalThis.addEventListener(type, callback); listeners.push(() => globalThis.removeEventListener(type, callback)); };
    const ownError = error => {
      try { return String(error?.stack ?? '').includes(chrome.runtime.getURL('')); } catch { return false; }
    };
    listen('error', event => {
      let own = ownError(event.error);
      try { own ||= event.filename?.startsWith(chrome.runtime.getURL('')); } catch {}
      if (own) void record('runtime.error', { ...errorDetails(event.error), line: event.lineno, column: event.colno });
    });
    listen('unhandledrejection', event => { if (ownError(event.reason)) void record('runtime.rejection', errorDetails(event.reason)); });
    const originals = [];
    for (const method of choices.method) {
      const original = console[method];
      if (typeof original !== 'function') continue;
      const wrapped = function(...args) {
        void record('console.message', { method, arguments: args.length, ...errorDetails(args.find(value => value instanceof Error)) });
        return Reflect.apply(original, this, args);
      };
      console[method] = wrapped;
      originals.push(() => { if (console[method] === wrapped) console[method] = original; });
    }
    cleanup = () => { listeners.forEach(remove => remove()); originals.forEach(restore => restore()); cleanup = () => {}; };
    signal?.addEventListener('abort', () => cleanup(), { once: true });
  }
  function dispose() { cleanup(); }
  globalThis.SecretShieldDebug = Object.freeze({ key, type, events, RETENTION_DAYS, PAGE_SIZE, RETENTION_MS, details, normalize, authorize,
    perform, record, write, request, readPrompt, siteForUrl, attempt, errorDetails, install, dispose });
  install();
})();
