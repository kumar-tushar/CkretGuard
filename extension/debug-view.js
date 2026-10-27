(() => {
  'use strict';
  const $ = id => document.getElementById(id), debug = SecretShieldDebug;
  let state = null, changing = false, revision = 0, refreshTimer;
  const expanded = new Set(), promptCache = new Map();
  function level(entry) { return ['error', 'warn'].includes(entry.details.method) ? entry.details.method : debug.events[entry.event][0]; }
  function active() { return !document.getElementById('sidebar').hidden && location.hash === '#debug'; }
  function render() {
    $('debug-export').disabled = changing || !state?.entries.length;
    $('debug-clear').disabled = changing || !state?.count;
    $('debug-more').hidden = !state?.next;
    $('debug-more').disabled = changing;
    if (!state) return;
    const retained = new Set(state.entries.map(entry => entry.promptId));
    for (const id of promptCache.keys()) if (!retained.has(id)) promptCache.delete(id);
    $('debug-status').textContent = `Logging automatically · Showing ${state.entries.length.toLocaleString()} of ${state.count.toLocaleString()} events.`;
    const items = state.entries.map(entry => {
      const item = document.createElement('li'), heading = document.createElement('div');
      item.className = 'debug-entry'; heading.className = 'debug-entry-heading';
      const [, label] = debug.events[entry.event];
      const title = document.createElement('strong');
      title.textContent = label; title.className = `debug-level-${level(entry)}`;
      const time = document.createElement('time');
      time.dateTime = new Date(entry.time).toISOString(); time.textContent = new Date(entry.time).toLocaleString();
      heading.append(title, time);
      const context = document.createElement('p');
      context.textContent = [entry.site ? `Chatbot: ${entry.site}` : 'Extension', entry.source, entry.tabId === undefined ? '' : `Tab ${entry.tabId}`, entry.event].filter(Boolean).join(' · ');
      item.append(heading, context);
      if (Object.keys(entry.details).length) {
        const details = document.createElement('p');
        details.className = 'debug-details';
        details.textContent = Object.entries(entry.details).map(([name, value]) => `${name}: ${value}`).join(' · ');
        item.append(details);
      }
      if (entry.promptId) {
        const group = document.createElement('details'), summary = document.createElement('summary'), prompt = document.createElement('pre');
        group.className = 'debug-prompt'; summary.textContent = 'View prompt';
        prompt.textContent = 'Loading prompt…'; group.append(summary, prompt);
        group.open = expanded.has(entry.id);
        async function load() {
          try {
            if (!promptCache.has(entry.promptId)) promptCache.set(entry.promptId, debug.readPrompt(entry.promptId));
            const text = await promptCache.get(entry.promptId);
            prompt.textContent = text === undefined ? 'Prompt unavailable. It may have expired or been cleared.' : text;
          } catch {
            promptCache.delete(entry.promptId);
            prompt.textContent = 'Could not load this prompt. Close and reopen it to retry.';
          }
        }
        group.addEventListener('toggle', () => {
          if (group.open) { expanded.add(entry.id); void load(); }
          else expanded.delete(entry.id);
        });
        if (group.open) void load();
        item.append(group);
      }
      return item;
    });
    $('debug-list').replaceChildren(...items);
  }
  async function refresh() {
    const request = ++revision;
    try {
      const loaded = await debug.request('list');
      if (request !== revision) return;
      if (state?.entries.length > debug.PAGE_SIZE && loaded.count >= state.count) {
        const entries = [...new Map([...loaded.entries, ...state.entries].map(entry => [entry.id, entry])).values()];
        state = { ...loaded, entries, next: state.next };
      } else state = loaded;
      render();
    } catch {
      if (request !== revision) return;
      state = null; render();
      $('debug-status').textContent = 'Could not load logs. Reload the extension and try again.';
    }
  }
  async function change(action, extra = {}) {
    if (changing) return;
    changing = true; render();
    let failed = false;
    try {
      ++revision; await debug.request(action, extra);
      if (action === 'clear') { expanded.clear(); promptCache.clear(); }
      state = await debug.request('list'); render();
    }
    catch { failed = true; }
    finally { changing = false; render(); if (failed) $('debug-status').textContent = 'Could not update logs. Try again.'; }
  }
  $('debug-more').addEventListener('click', async () => {
    if (changing || !state?.next) return;
    changing = true; render();
    let failed = false;
    try {
      ++revision;
      const older = await debug.request('list', { before: state.next });
      state = { ...older, entries: [...state.entries, ...older.entries] };
    } catch { failed = true; }
    finally { changing = false; render(); if (failed) $('debug-status').textContent = 'Could not load older logs. Try again.'; }
  });
  $('debug-clear').addEventListener('click', () => { void change('clear'); });
  $('debug-export').addEventListener('click', async () => {
    if (changing || !state) return;
    changing = true; render();
    let failed = false;
    try {
      const snapshot = await debug.request('export', { includePrompts: true });
      const data = { version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(),
        deliveryConfirmed: false, includesPromptText: true, includesSecrets: true, ...snapshot,
        entries: snapshot.entries.map(entry => ({ ...entry, level: level(entry), message: debug.events[entry.event][1] })) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `ckretguard-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { failed = true; }
    finally { changing = false; render(); if (failed) $('debug-status').textContent = 'Could not export logs. Try again.'; }
  });
  function schedule() {
    if (!active()) { clearTimeout(refreshTimer); refreshTimer = null; expanded.clear(); promptCache.clear(); return; }
    if (!refreshTimer && !changing) refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 100);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, debug.key)) schedule();
  });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('ckretguard-debug-open', schedule);
  schedule();
})();
