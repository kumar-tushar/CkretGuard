(() => {
  'use strict';
  const keys = ['mode', 'protectClientIds', 'sensitiveNames'];
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
  globalThis.SecretShieldPolicy = Object.freeze({ loadPolicy, keys });
})();
