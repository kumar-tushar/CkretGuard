(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const views = ['home', 'history', 'privacy', 'contact'];
  let fullPage = false, revision = 0, changing = false;
  function activeView() { return views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home'; }
  async function refreshHistory() {
    const request = ++revision;
    $('history-status').textContent = 'Loading history…';
    try {
      const entries = await SecretShieldHistory.request('list');
      if (request !== revision) return;
      const expanded = new Set([...$('history-list').querySelectorAll('details[open]')].map(item => item.dataset.id));
      $('history-list').replaceChildren();
      for (const entry of entries) {
        const item = document.createElement('li');
        item.className = 'history-entry';
        const header = document.createElement('div');
        header.className = 'history-entry-heading';
        const source = document.createElement('a');
        source.textContent = entry.site;
        source.href = entry.url;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
        const time = document.createElement('time');
        time.dateTime = new Date(entry.createdAt).toISOString();
        time.textContent = new Date(entry.createdAt).toLocaleString();
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-field';
        remove.textContent = '×';
        remove.disabled = changing;
        remove.setAttribute('aria-label', `Delete ${entry.site} entry from ${time.textContent}`);
        remove.addEventListener('click', () => { void changeHistory('remove', { id: entry.id }); });
        header.append(source, time, remove);
        const count = document.createElement('p');
        count.className = 'history-count';
        count.textContent = `${entry.count} secret${entry.count === 1 ? '' : 's'} sent unmasked`;
        const details = document.createElement('details');
        details.dataset.id = entry.id;
        details.open = expanded.has(entry.id);
        const summary = document.createElement('summary');
        summary.textContent = 'View unmasked prompt';
        const prompt = document.createElement('pre');
        let loading = false, loaded = false;
        details.addEventListener('toggle', async () => {
          if (!details.open || loading || loaded) return;
          loading = true;
          prompt.textContent = 'Loading prompt…';
          try {
            const text = await SecretShieldHistory.readPrompt(entry.id);
            if (details.isConnected) { prompt.textContent = text; loaded = true; }
          } catch { if (details.isConnected) prompt.textContent = 'Could not load this prompt. Close and reopen to retry.'; }
          finally { loading = false; }
        });
        details.append(summary, prompt);
        item.append(header, count, details);
        $('history-list').append(item);
      }
      $('clear-history').hidden = entries.length === 0;
      $('history-status').textContent = entries.length ? '' : 'No unmasked prompts sent yet.';
    } catch {
      if (request !== revision) return;
      $('history-list').replaceChildren();
      $('clear-history').hidden = false;
      $('history-status').textContent = 'Could not load history. Reload this tab and try again.';
    }
  }
  async function changeHistory(action, extra) {
    if (changing) return false;
    changing = true;
    $('clear-history').disabled = true;
    $('confirm-clear-history').disabled = true;
    $('cancel-clear-history').disabled = true;
    $('history-list').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await SecretShieldHistory.request(action, extra);
      await refreshHistory();
      return true;
    } catch { $('history-status').textContent = 'Could not delete history. Try again.'; return false; }
    finally {
      changing = false;
      $('clear-history').disabled = false;
      $('confirm-clear-history').disabled = false;
      $('cancel-clear-history').disabled = false;
      $('history-list').querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
  function renderView(focus = false) {
    const selected = fullPage ? activeView() : 'home';
    if (selected !== 'history') $('clear-history-dialog').close();
    for (const view of views) $(view + '-view').hidden = view !== selected;
    for (const link of $('sidebar').querySelectorAll('a')) {
      if (link.hash === '#' + selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `CkretGuard · ${selected === 'privacy' ? 'Privacy Policy' : selected === 'contact' ? 'Contact Us' : selected === 'history' ? 'History' : 'Protection'}`;
    if (selected === 'history') void refreshHistory();
    if (focus) document.querySelector(`#${selected}-view h2`)?.focus();
  }
  $('clear-history').addEventListener('click', () => {
    if (changing || $('clear-history-dialog').open) return;
    $('clear-history-error').textContent = '';
    $('clear-history-dialog').showModal();
  });
  $('cancel-clear-history').addEventListener('click', () => $('clear-history-dialog').close());
  $('clear-history-dialog').addEventListener('cancel', event => { if (changing) event.preventDefault(); });
  $('confirm-clear-history').addEventListener('click', async () => {
    if (changing) return;
    $('clear-history-error').textContent = '';
    if (await changeHistory('clear')) {
      $('clear-history-dialog').close();
      $('history-title').focus();
    } else $('clear-history-error').textContent = 'Could not clear history. Try again.';
  });
  window.addEventListener('hashchange', () => renderView(true));
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'ckretguard-history-changed' && sender.id === chrome.runtime.id && fullPage && activeView() === 'history') void refreshHistory();
  });
  void chrome.tabs.getCurrent().then(tab => {
    fullPage = Boolean(tab);
    document.body.classList.toggle('full-page', fullPage);
    $('sidebar').hidden = !fullPage;
    $('expand').hidden = fullPage;
    renderView();
  }).catch(() => renderView());
})();
