(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let current = null, locked = [], revision = 0, activityRevision = 0, saving = false;
  function setStatus(id, text, error = false) {
    $(id).textContent = text;
    $(id).classList.toggle('error', error);
    if (error) void globalThis.SecretShieldDebug?.record(id === 'field-status' ? 'policy.update_failed' : 'policy.failed');
  }
  $('sensitive-names').addEventListener('input', () => {
    setStatus('field-status', '');
    updateFieldButton();
  });
  $('expand').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
  function updateFieldButton() {
    $('save-fields').disabled = !current || saving || locked.includes('sensitiveNames') ||
      current.sensitiveNames.length >= SecretShieldCore.MAX_CUSTOM_FIELDS || $('sensitive-names').value.trim().length < 3;
  }
  function renderSettings() {
    if (!saving) {
      for (const radio of $('mode').querySelectorAll('input')) radio.checked = radio.value === current.mode;
      $('client-ids').checked = current.protectClientIds;
    }
    $('mode').disabled = saving || locked.includes('mode');
    $('client-ids').disabled = saving || locked.includes('protectClientIds');
  }
  function renderFields() {
    const names = current?.sensitiveNames ?? [];
    const full = names.length >= SecretShieldCore.MAX_CUSTOM_FIELDS;
    $('field-form').hidden = full;
    $('sensitive-names').disabled = full || locked.includes('sensitiveNames');
    updateFieldButton();
    $('field-help').textContent = full ? 'You can add maximum 50 fields.' : 'Add field names whose values you want to protect.';
    $('field-count').textContent = `${names.length} custom field${names.length === 1 ? '' : 's'} saved.`;
    $('saved-fields-panel').hidden = names.length === 0;
    $('saved-fields').replaceChildren();
    for (const name of names) {
      const item = document.createElement('li');
      item.className = 'saved-field';
      const label = document.createElement('span');
      label.textContent = name;
      item.append(label);
      if (!locked.includes('sensitiveNames')) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-field';
        remove.setAttribute('aria-label', `Remove ${name}`);
        remove.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
        remove.disabled = saving;
        remove.addEventListener('click', () => {
          if (!current || saving || locked.includes('sensitiveNames')) return;
          void save({ kind: 'removeField', name }, 'field-status');
        });
        item.append(remove);
      }
      $('saved-fields').append(item);
    }
  }
  async function reload() {
    const request = ++revision;
    current = null; $('sensitive-names').disabled = true; $('save-fields').disabled = true;
    $('mode').disabled = true; $('client-ids').disabled = true;
    $('saved-fields').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const loaded = await SecretShieldPolicy.loadPolicy();
      if (request !== revision) return;
      current = loaded.policy; locked = loaded.locked;
      renderSettings();
      $('managed-label').textContent = locked.length ? 'Managed by your organization' : '';
      renderFields();
      setStatus('field-status', locked.includes('sensitiveNames') ? 'These fields are managed by your organization.' : '');
    } catch {
      if (request === revision) setStatus('field-status', 'Protection settings unavailable. Reload the extension.', true);
    }
  }
  async function save(change, status) {
    if (saving) return false;
    saving = true;
    setStatus(status, '');
    $('save-fields').disabled = true; $('mode').disabled = true; $('client-ids').disabled = true;
    $('saved-fields').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (!current) throw new Error();
      await SecretShieldPolicy.update(change);
      await reload();
      return true;
    } catch (error) {
      let message = status === 'field-status' ? 'Could not save fields. Try again.' :
        'Could not save settings. Reload the extension and try again.';
      if (status === 'field-status' && error instanceof SecretShieldCore.ScanError) {
        message = 'Use 3–64 characters, starting with a letter. Allowed: letters, numbers, spaces, _ and -.';
      }
      if (error.code === 'duplicate') message = 'That field is already saved.';
      if (error.code === 'limit') message = 'You can add maximum 50 fields.';
      if (error.code === 'managed') message = 'These settings are managed by your organization.';
      setStatus(status, message, true);
      return false;
    } finally {
      saving = false;
      if (current) {
        renderSettings();
        renderFields();
      }
    }
  }
  $('field-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!current || $('save-fields').disabled) return;
    const name = $('sensitive-names').value.trim();
    if (current.sensitiveNames.some(value => value.toLowerCase() === name.toLowerCase())) {
      setStatus('field-status', 'That field is already saved.', true);
      return;
    }
    const saved = await save({ kind: 'addField', name }, 'field-status');
    if (saved && $('sensitive-names').value.trim() === name) $('sensitive-names').value = '';
    if (saved) $('saved-fields').scrollTop = 0;
    updateFieldButton();
  });
  $('mode').addEventListener('change', event => {
    if (!current || $('mode').disabled) return;
    void save({ kind: 'set', key: 'mode', value: event.target.value }, 'settings-status');
  });
  $('client-ids').addEventListener('change', () => {
    if (!current || $('client-ids').disabled) return;
    void save({ kind: 'set', key: 'protectClientIds', value: $('client-ids').checked }, 'settings-status');
  });
  async function refreshActivity() {
    const request = ++activityRevision;
    try {
      const counters = await SecretShieldStats.read();
      if (request !== activityRevision) return;
      for (const field of SecretShieldStats.fields) $('stat-' + field).textContent = counters[field].toLocaleString();
      $('activity-status').textContent = ''; $('activity-status').hidden = true;
    } catch {
      if (request !== activityRevision) return;
      for (const field of SecretShieldStats.fields) $('stat-' + field).textContent = '—';
      void globalThis.SecretShieldDebug?.record('activity.failed');
      $('activity-status').textContent = 'Activity counts unavailable.';
      $('activity-status').hidden = false;
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed' || (area === 'local' && Object.hasOwn(changes, 'policy'))) void reload();
    if (area === 'local' && Object.hasOwn(changes, SecretShieldStats.key)) void refreshActivity();
  });
  async function coverage() {
    let context;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error();
      context = { site: globalThis.SecretShieldDebug?.siteForUrl(tab.url), tabId: tab.id };
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'coverage' });
      const ready = state.ready && state.editors === 1;
      void globalThis.SecretShieldDebug?.record('coverage.checked', { ready: Boolean(ready), editors: state.editors }, context);
      $('coverage').textContent = ready ? `${state.site} input recognized · prompt guard ready.` : `${state.site} · guard unavailable or input not recognized. Reload the chat tab before sending.`;
      if (ready) $('coverage').append(document.createElement('br'), 'Coverage is limited to supported input and send controls.');
      $('coverage').hidden = false;
    } catch { void globalThis.SecretShieldDebug?.record('coverage.failed', {}, context); $('coverage').textContent = ''; $('coverage').hidden = true; }
  }
  void globalThis.SecretShieldDebug?.record('dashboard.opened');
  void reload(); void coverage(); void refreshActivity();
})();
