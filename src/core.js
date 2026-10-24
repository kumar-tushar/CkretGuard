/* Shared local-only scanner. Loaded as a classic script in Chrome and by index.mjs. */
(() => {
  'use strict';
  const MAX_CHARACTERS = 100_000;
  const MAX_CUSTOM_FIELDS = 50;
  const MASK = 'xxxxx';
  const defaults = Object.freeze({ mode: 'redact', protectClientIds: true, sensitiveNames: [] });
  const names = ['key', 'api_key', 'apikey', 'api-key', 'api key', 'api_token', 'api token', 'secret', 'secret_key', 'secret key',
    'client_secret', 'client secret', 'access_token', 'access token', 'auth_token', 'auth token',
    'refresh_token', 'refresh token', 'password', 'passwd', 'pwd', 'token', 'private_key',
    'aws_secret_access_key', 'aws_access_key_id', 'authorization'];
  const placeholders = /^(?:\[REDACTED\]|x{4,}|\*{4,}|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|<[^>]+>)$/i;
  const horizontal = '[^\\S\\r\\n\\u2028\\u2029]';
  const valuePattern = String.raw`"((?:\\.|[^"\\\r\n])*)(?:"|(?=\r?\n|\r|$))|'((?:\\.|[^'\\\r\n])*)(?:'|(?=\r?\n|\r|$))|“([^”\r\n]*)(?:”|(?=\r?\n|\r|$))|‘([^’\r\n]*)(?:’|(?=\r?\n|\r|$))|((?:\$\{[^{}\s]+\}|[^\s,;\x60"'“”‘’<>}&])+)`;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    policy = normalizePolicy(policy);
    const candidates = [];
    const add = (start, end, type) => {
      if (end > start && !placeholders.test(text.slice(start, end))) candidates.push({ start, end, type });
    };
    const matchAll = (pattern, type, group = 0) => {
      for (const match of text.matchAll(pattern)) {
        const offset = group ? match[0].lastIndexOf(match[group]) : 0;
        add(match.index + offset, match.index + offset + match[group].length, type);
      }
    };
    matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, 'private-key');
    matchAll(/(?<![\w-])(?:sk-(?:(?:proj|svcacct)-|ant-(?:api03|admin01)-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,})(?![\w-])/g, 'provider-key');
    matchAll(/(?<![\w-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}(?![\w-])/g, 'jwt');
    const authorizationSchemes = new Set();
    const authorization = new RegExp(`\\b(Bearer|Basic)${horizontal}+(?:${valuePattern})`, 'dgi');
    for (const match of text.matchAll(authorization)) {
      const group = match.findIndex((value, index) => index >= 2 && value !== undefined);
      const [start, end] = match.indices[group];
      add(start, end, 'authorization');
      authorizationSchemes.add(match.index + match[1].length);
    }
    matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi, 'connection-password', 1);
    // Built-in word boundaries accept joined, spaced, underscore and hyphen spellings.
    // Custom fields remain escaped literal labels.
    const builtIn = policy.protectClientIds ? [...names, 'client_id'] : names;
    const sensitive = [...new Set(builtIn.map(name => name.split(/[_ -]+/).map(escape).join(`(?:${horizontal}|[_-])*`))),
      ...policy.sensitiveNames.map(escape)];
    // Prefixes cover environment variable names such as STRIPE_SECRET_KEY.
    const label = `(?<![\\w-])(?:[a-zA-Z][a-zA-Z0-9]*[_-])*?(?:${sensitive.join('|')})(?![\\w-])`;
    const assignment = new RegExp(`(${label})["'”’]?${horizontal}*(?::|=|：|＝|\\bis\\b)${horizontal}*(?:(?:\\r\\n|[\\r\\n])${horizontal}*)?(?:${valuePattern})`, 'dgi');
    for (const match of text.matchAll(assignment)) {
      const group = match.findIndex((value, index) => index >= 2 && value !== undefined);
      const value = match[group];
      const [start, end] = match.indices[group];
      // The authorization rule already protects the token following its scheme.
      if (/authorization$/i.test(match[1]) && /^(?:Bearer|Basic)$/i.test(value) && authorizationSchemes.has(end)) continue;
      add(start, end, 'named-secret');
    }
    // Protect repeated occurrences of a detected value without retaining a vault.
    const repeated = new Set();
    let work = 0;
    for (const item of [...candidates]) {
      const value = text.slice(item.start, item.end);
      if (value.length < 8 || value.includes('\n') || repeated.has(value)) continue;
      repeated.add(value);
      work += text.length;
      if (work > 10_000_000) throw new ScanError();
      let from = 0;
      while ((from = text.indexOf(value, from)) !== -1) {
        add(from, from + value.length, item.type);
        from += value.length;
      }
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const item of candidates) {
      const previous = merged.at(-1);
      if (previous && item.start < previous.end) previous.end = Math.max(previous.end, item.end);
      else merged.push({ ...item });
    }
    return merged;
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
