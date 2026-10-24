(() => {
  'use strict';
  const key = 'activity';
  const fields = Object.freeze(['detected', 'maskedPrompts', 'unmaskedPrompts']);
  function valid(kind, count) {
    return fields.includes(kind) && Number.isSafeInteger(count) && count > 0 &&
      (kind === 'detected' || count === 1);
  }
  function normalize(value) {
    return Object.fromEntries(fields.map(field => [field,
      Number.isSafeInteger(value?.[field]) && value[field] >= 0 ? value[field] : 0]));
  }
  async function read() {
    const saved = await chrome.storage.local.get(key);
    return normalize(saved[key]);
  }
  async function record(kind, count = 1) {
    if (!valid(kind, count)) return false;
    try { return (await chrome.runtime.sendMessage({ type: 'ckretguard-activity', kind, count }))?.ok === true; }
    catch { return false; }
  }
  globalThis.SecretShieldStats = Object.freeze({ key, fields, valid, normalize, read, record });
})();
