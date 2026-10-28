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
  let detector;

  function compileAllowlists(values = []) {
    return values.map(value => {
      const condition = value.condition ?? 'OR', target = value.regexTarget ?? 'secret';
      if (!['AND', 'OR'].includes(condition) || !['secret', 'match', 'line'].includes(target) ||
          !Array.isArray(value.regexes) || !Array.isArray(value.stopwords) || !Array.isArray(value.paths) ||
          [...value.regexes, ...value.stopwords, ...value.paths].some(item => typeof item !== 'string') ||
          !value.regexes.length && !value.stopwords.length && !value.paths.length) throw new ScanError();
      return { condition, target, regexes: value.regexes.map(pattern => new RegExp(pattern)),
        stopwords: value.stopwords.map(word => word.toLowerCase()), hasPaths: value.paths.length > 0 };
    });
  }

  function detectionRules() {
    if (detector) return detector;
    try {
      const source = globalThis.SecretShieldRules;
      if (!source || !Array.isArray(source.rules) || !source.rules.length) throw new ScanError();
      const ids = new Set();
      const rules = source.rules.map(rule => {
        if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || typeof rule.regex !== 'string' ||
            !Number.isInteger(rule.secretGroup) || rule.secretGroup < 1 || !Number.isFinite(rule.entropy) || rule.entropy < 0 ||
            !Array.isArray(rule.keywords) || rule.keywords.some(word => typeof word !== 'string' || !word)) throw new ScanError();
        ids.add(rule.id);
        const regex = new RegExp(rule.regex, 'gd');
        // The pinned rule has one capture group. Validate its extraction against
        // the empty alternative without requiring a credential to match.
        if (new RegExp(`(?:${rule.regex})|`).exec('').length <= rule.secretGroup) throw new ScanError();
        return { ...rule, regex, keywords: rule.keywords.map(word => word.toLowerCase()), allowlists: compileAllowlists(rule.allowlists) };
      });
      detector = { rules, allowlists: compileAllowlists(source.globalAllowlists) };
      return detector;
    } catch { throw new ScanError(); }
  }

  function entropy(value) {
    const counts = new Map();
    let length = 0;
    for (const char of value) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
      const point = char.codePointAt(0);
      length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    // Gitleaks counts runes but uses the UTF-8 byte length as its denominator.
    // Preserve that behavior for the Unicode case folds allowed by the rule.
    let result = 0;
    for (const count of counts.values()) { const frequency = count / length; result -= frequency * Math.log2(frequency); }
    return result;
  }

  function allowed(allowlists, secret, match, line) {
    const lower = secret.toLowerCase();
    return allowlists.some(list => {
      const checks = [];
      // Prompt fragments have no file path. Do not turn an upstream path+line
      // exclusion into a line-only exclusion by dropping its path requirement.
      if (list.hasPaths && list.condition === 'AND') checks.push(false);
      if (list.regexes.length) checks.push(list.regexes.some(regex => regex.test(list.target === 'line' ? line : list.target === 'match' ? match : secret)));
      if (list.stopwords.length) checks.push(list.stopwords.some(word => lower.includes(word)));
      return checks.length > 0 && (list.condition === 'AND' ? checks.every(Boolean) : checks.some(Boolean));
    });
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
    const { rules, allowlists } = detectionRules(), lower = text.toLowerCase(), findings = [], seen = new Set();
    for (const rule of rules) {
      if (rule.keywords.length && !rule.keywords.some(word => lower.includes(word))) continue;
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(text)) !== null) {
        const bounds = match.indices[rule.secretGroup], secret = match[rule.secretGroup];
        if (!bounds || !secret) throw new ScanError();
        if (rule.entropy && entropy(secret) <= rule.entropy) continue;
        const matched = match[0].replace(/^\n+|\n+$/g, '');
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = text.indexOf('\n', match.index + matched.length);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (allowed(allowlists, secret, matched, line) || allowed(rule.allowlists, secret, matched, line)) continue;
        const [start, end] = bounds, identity = `${start}:${end}`;
        if (!seen.has(identity)) { findings.push({ start, end, type: rule.id }); seen.add(identity); }
      }
    }
    return findings.sort((a, b) => a.start - b.start || a.end - b.end);
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
