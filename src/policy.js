(() => {
  'use strict';
  const keys = ['mode', 'protectClientIds', 'sensitiveNames'];
  const type = 'ckretguard-policy';
  async function loadPolicy() {
    // Fail closed on storage errors; an unreadable policy is never a default-policy fallback.
    const [local, managed] = await Promise.all([
      chrome.storage.local.get('policy'), chrome.storage.managed.get(keys),
    ]);
    if (local.policy !== undefined && (!local.policy || typeof local.policy !== 'object' || Array.isArray(local.policy))) {
      throw new SecretShieldCore.ScanError();
    }
    const combined = { ...(local.policy ?? {}) };
    const locked = [];
    for (const key of keys) {
      if (Object.hasOwn(managed, key)) { combined[key] = managed[key]; locked.push(key); }
    }
    return { policy: SecretShieldCore.normalizePolicy(combined), locked };
  }
  async function apply(change) {
    if (!change || typeof change !== 'object') throw new SecretShieldCore.ScanError();
    const { policy, locked } = await loadPolicy();
    let key, value;
    if (change.kind === 'addField' || change.kind === 'removeField') {
      key = 'sensitiveNames';
      if (typeof change.name !== 'string') throw new SecretShieldCore.ScanError();
      if (change.kind === 'addField') {
        if (policy.sensitiveNames.some(name => name.toLowerCase() === change.name.toLowerCase())) throw new Error('duplicate');
        if (policy.sensitiveNames.length >= SecretShieldCore.MAX_CUSTOM_FIELDS) throw new Error('limit');
        if (!/^[a-zA-Z][a-zA-Z0-9_ -]{2,63}$/.test(change.name)) throw new SecretShieldCore.ScanError();
        value = [change.name, ...policy.sensitiveNames];
      } else value = policy.sensitiveNames.filter(name => name !== change.name);
    } else if (change.kind === 'set' && ['mode', 'protectClientIds'].includes(change.key)) {
      if (typeof change.value !== (change.key === 'mode' ? 'string' : 'boolean')) throw new SecretShieldCore.ScanError();
      key = change.key; value = change.value;
    } else throw new SecretShieldCore.ScanError();
    if (locked.includes(key)) throw new Error('managed');
    const requested = SecretShieldCore.normalizePolicy({ ...policy, [key]: value });
    await chrome.storage.local.set({ policy: Object.fromEntries(Object.entries(requested).filter(([name]) => !locked.includes(name))) });
  }
  async function update(change) {
    const response = await chrome.runtime.sendMessage({ type, change });
    if (!response?.ok) {
      if (response?.error === 'invalid') throw new SecretShieldCore.ScanError();
      const error = new Error('Could not save policy');
      error.code = response?.error;
      throw error;
    }
  }
  globalThis.SecretShieldPolicy = Object.freeze({ loadPolicy, apply, update, type, keys });
})();
