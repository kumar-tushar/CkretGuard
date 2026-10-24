(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let current = null, locked = [], revision = 0, activityRevision = 0, saving = false;
  $('sensitive-names').addEventListener('input', () => {
    $('field-status').textContent = '';
    updateFieldButton();
  });
  $('expand').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
  function updateFieldButton() {
    $('save-fields').disabled = !current || saving || locked.includes('sensitiveNames') ||
      current.sensitiveNames.length >= SecretShieldCore.MAX_CUSTOM_FIELDS || $('sensitive-names').value.trim().length < 3;
  }
  function renderSettings() {
    for (const radio of $('mode').querySelectorAll('input')) radio.checked = radio.value === current.mode;
    $('mode').disabled = saving || locked.includes('mode');
    $('client-ids').checked = current.protectClientIds;
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
    if (!names.length) $('saved-fields-panel').open = false;
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
        remove.textContent = '×';
        remove.disabled = saving;
        remove.addEventListener('click', () => {
          if (!current || saving || locked.includes('sensitiveNames')) return;
          void save({ sensitiveNames: current.sensitiveNames.filter(value => value !== name) }, 'field-status');
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
      $('field-status').textContent = locked.includes('sensitiveNames') ? 'These fields are managed by your organization.' : '';
    } catch {
      if (request === revision) $('field-status').textContent = 'Protection settings unavailable. Reload the extension.';
    }
  }
  async function save(patch, status) {
    if (saving) return false;
    saving = true;
    $(status).textContent = '';
    $('save-fields').disabled = true; $('mode').disabled = true; $('client-ids').disabled = true;
    $('saved-fields').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (!current) throw new Error();
      const requested = SecretShieldCore.normalizePolicy({ ...current, ...patch });
      const local = Object.fromEntries(Object.entries(requested).filter(([key]) => !locked.includes(key)));
      await chrome.storage.local.set({ policy: local });
      await reload();
      if (!current) throw new Error();
      return true;
    } catch {
      $(status).textContent = status === 'field-status' ?
        'Could not save fields. Add names of 3–64 characters, starting with a letter. Use letters, numbers, spaces, underscores or hyphens.' :
        'Could not save settings. Reload the extension and try again.';
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
      $('field-status').textContent = 'That field is already saved.';
      return;
    }
    const saved = await save({ sensitiveNames: [name, ...current.sensitiveNames] }, 'field-status');
    if (saved && $('sensitive-names').value.trim() === name) $('sensitive-names').value = '';
    if (saved) $('saved-fields').scrollTop = 0;
    updateFieldButton();
  });
  $('mode').addEventListener('change', event => {
    if (!current || $('mode').disabled) return;
    void save({ mode: event.target.value }, 'settings-status');
  });
  $('client-ids').addEventListener('change', () => {
    if (!current || $('client-ids').disabled) return;
    void save({ protectClientIds: $('client-ids').checked }, 'settings-status');
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
      $('activity-status').textContent = 'Activity counts unavailable.';
      $('activity-status').hidden = false;
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed' || (area === 'local' && Object.hasOwn(changes, 'policy'))) void reload();
    if (area === 'local' && Object.hasOwn(changes, SecretShieldStats.key)) void refreshActivity();
  });
  async function coverage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error();
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'coverage' });
      $('coverage').textContent = state.ready && state.editors === 1 ? `${state.site} input recognized · prompt guard ready. Coverage is limited to supported input and send controls.` : `${state.site} · guard unavailable or input not recognized. Reload the chat tab before sending.`;
      $('coverage').hidden = false;
    } catch { $('coverage').textContent = ''; $('coverage').hidden = true; }
  }
  void reload(); void coverage(); void refreshActivity();
})();
