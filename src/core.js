/* Shared local-only scanner. Loaded as a classic script in Chrome and by index.mjs. */
(() => {
  'use strict';
  const MAX_CHARACTERS = 100_000;
  const MAX_CUSTOM_FIELDS = 50;
  const MASK = 'xxxxxxxxxx';
  const defaults = Object.freeze({ mode: 'redact', protectClientIds: true, sensitiveNames: [] });
  class ScanError extends Error {
    constructor() { super('This text could not be scanned. Keep it local and shorten it before retrying.'); }
  }

  function normalizePolicy(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScanError();
    const mode = value.mode ?? defaults.mode;
    if (!['redact', 'block'].includes(mode)) throw new ScanError();
    if (value.protectClientIds !== undefined && typeof value.protectClientIds !== 'boolean') throw new ScanError();
    const sensitiveNames = value.sensitiveNames ?? [];
    if (!Array.isArray(sensitiveNames) || sensitiveNames.length > MAX_CUSTOM_FIELDS ||
        sensitiveNames.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_ -]{1,63}$/.test(name))) {
      throw new ScanError();
    }
    return { mode, protectClientIds: value.protectClientIds ?? true, sensitiveNames: [...new Set(sensitiveNames)] };
  }

  function scan(text, policy = defaults, maxCharacters = MAX_CHARACTERS) {
    if (typeof text !== 'string' || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || text.length > maxCharacters) throw new ScanError();
    normalizePolicy(policy);
    // Detection rules are intentionally empty until the replacement detector is added.
    return [];
  }

  function redact(text, policy, maxCharacters) {
    const findings = scan(text, policy, maxCharacters);
    let output = '', cursor = 0;
    for (const item of findings) {
      output += text.slice(cursor, item.start) + MASK;
      cursor = item.end;
    }
    return { text: output + text.slice(cursor), count: findings.length, findings };
  }
  globalThis.SecretShieldCore = Object.freeze({ scan, redact, normalizePolicy, defaults, ScanError, MASK, MAX_CHARACTERS, MAX_CUSTOM_FIELDS });
})();
