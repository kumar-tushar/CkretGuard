/* Shared local-only scanner. Loaded as a classic script in Chrome and by index.mjs. */
(() => {
  'use strict';
  const MAX_CHARACTERS = 100_000;
  const MAX_CUSTOM_FIELDS = 50;
  const MASK = 'xxxxxxxxxx';
  const defaults = Object.freeze({ mode: 'redact', protectClientIds: true, sensitiveNames: [] });
  const names = ['key', 'api_key', 'apikey', 'api-key', 'api key', 'api_token', 'api token', 'secret', 'secret_key', 'secret key',
    'client_secret', 'client secret', 'access_token', 'access token', 'auth_token', 'auth token',
    'refresh_token', 'refresh token', 'password', 'passwd', 'pwd', 'token', 'private_key',
    'aws_secret_access_key', 'aws_access_key_id', 'authorization'];
  const placeholders = /^(?:\[REDACTED\]|x{4,}|\*{4,}|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|<[^>]+>)$/i;
  const horizontal = '[^\\S\\r\\n\\u2028\\u2029]';
  const valuePattern = String.raw`"((?:\\.|[^"\\\r\n])*)(?:"|(?=\r?\n|\r|$))|'((?:\\.|[^'\\\r\n])*)(?:'|(?=\r?\n|\r|$))|“([^”\r\n]*)(?:”|(?=\r?\n|\r|$))|‘([^’\r\n]*)(?:’|(?=\r?\n|\r|$))|\x60{3}([\s\S]*?)(?:\x60{3}|$)|\x60+([^\x60\r\n]*)(?:\x60+|(?=\r?\n|\r|$))|((?:\$\{[^{}\s]+\}|[^\s,;\x60"'“”‘’<>}&])+)`;
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
    matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi, 'connection-password', 1);
    // Built-in word boundaries accept joined, spaced, underscore and hyphen spellings.
    // Custom fields remain escaped literal labels.
    const builtIn = policy.protectClientIds ? [...names, 'client_id'] : names;
    const sensitive = [...new Set(builtIn.map(name => name.split(/[_ -]+/).map(escape).join(`(?:${horizontal}|[_-])*`))),
      ...policy.sensitiveNames.map(escape)];
    // Prefixes cover environment variable names such as STRIPE_SECRET_KEY.
    const label = `(?<![\\w-])(?:[a-zA-Z][a-zA-Z0-9]*[_-])*?(?:${sensitive.join('|')})(?![\\w-])`;
    const separator = '(?::|=|：|＝|\\bis\\b)';
    const followingField = `(?:${label}|["'“‘\x60]+${label}["'”’\x60]+)${horizontal}*${separator}`;
    const authorizationSchemes = new Set();
    const authorization = new RegExp(`(?:\\b((?:[a-zA-Z][a-zA-Z0-9]*[_-])*authorization)["'”’\x60]*${horizontal}*(?::|=|：|＝|\\bis\\b)\\s*["'“‘\x60]*\\s*)?\\b(Bearer|Basic)\\s+(?:${valuePattern})`, 'dgi');
    const nextAssignment = new RegExp(`^(?:${followingField})`, 'i');
    for (const match of text.matchAll(authorization)) {
      const group = match.findIndex((value, index) => index >= 3 && value !== undefined);
      const value = match[group];
      // A header explicitly identifies credentials; bare schemes need token evidence.
      let basicCredential = false;
      if (!match[1] && /^basic$/i.test(match[2])) {
        try { basicCredential = atob(value).includes(':'); } catch {}
      }
      const bareToken = /^[A-Za-z0-9._~+/-]+=*$/.test(value) &&
        (/[0-9_~+/=]/.test(value) || value.replace(/[.!?]+$/, '').length >= 20);
      if (!match[1] && !basicCredential && !bareToken && group === match.length - 1) continue;
      if (match[1] && nextAssignment.test(value)) throw new ScanError();
      const [start, end] = match.indices[group];
      add(start, end, 'authorization');
      authorizationSchemes.add(match.indices[2][1]);
    }
    // Read ordered value lines only after an explicit list of recognized labels.
    // Include opted-out client IDs while parsing so later values never shift positions.
    const groupedNames = [...new Set([...policy.sensitiveNames.map(escape).sort((a, b) => b.length - a.length),
      ...sensitive, 'client(?:' + horizontal + '|[_-])*id'])];
    const groupedLabel = `(?<![\\w-])(?:[a-zA-Z][a-zA-Z0-9]*[_-])*?(?:${groupedNames.join('|')})(?![\\w-])`;
    const wrappedLabel = `["'“‘\x60]*${groupedLabel}["'”’\x60]*`;
    const join = `${horizontal}*(?:,${horizontal}*(?:(?:and|&)${horizontal}+)?|and${horizontal}+|&${horizontal}*)`;
    const groupedHeader = new RegExp(`^${horizontal}*(?:(?:my|our|the)${horizontal}+)?(${wrappedLabel}(?:${join}${wrappedLabel})+)${horizontal}*(?:are${horizontal}*[:=：＝]?|[:=：＝])${horizontal}*$`, 'i');
    const enabledLabel = new RegExp(`^(?:${label})$`, 'i');
    const blankLines = new RegExp(`(?:${horizontal}*(?:\\r\\n|[\\r\\n]))*`, 'y');
    const groupedValue = new RegExp(`${horizontal}*(?:(?:[-*]|\\d+[.)])${horizontal}+)?(?:${valuePattern})${horizontal}*[,;]?${horizontal}*(?:\\r\\n|[\\r\\n]|$)`, 'dy');
    const groupedHeaders = [];
    for (const line of text.matchAll(/[^\r\n]+/g)) {
      const header = groupedHeader.exec(line[0]);
      if (!header) continue;
      const fields = [...header[1].matchAll(new RegExp(`${groupedLabel}(?=["'”’\x60]*(?:${join}|${horizontal}*$))`, 'gi'))];
      if (!fields.some(field => enabledLabel.test(field[0]))) continue;
      if (fields.length > MAX_CUSTOM_FIELDS) throw new ScanError();
      groupedHeaders.push({ start: line.index, end: line.index + line[0].length });
      let cursor = line.index + line[0].length;
      const newline = /^(?:\r\n|[\r\n])/.exec(text.slice(cursor, cursor + 2));
      if (!newline) continue;
      cursor += newline[0].length;
      const values = [];
      for (const field of fields) {
        blankLines.lastIndex = cursor;
        blankLines.exec(text);
        cursor = blankLines.lastIndex;
        groupedValue.lastIndex = cursor;
        const value = groupedValue.exec(text);
        if (!value || nextAssignment.test(value[0].trimStart())) {
          if (values.length) throw new ScanError();
          break;
        }
        const group = value.findIndex((item, index) => index >= 1 && item !== undefined);
        values.push({ field: field[0], range: value.indices[group] });
        cursor = groupedValue.lastIndex;
      }
      if (values.length === fields.length) for (const value of values) {
        if (enabledLabel.test(value.field)) add(...value.range, 'named-secret');
      }
    }
    // An empty field must not consume another assignment on the following line.
    const assignment = new RegExp(`(${label})["'”’\x60]*${horizontal}*${separator}${horizontal}*(?:(?:\\r\\n|[\\r\\n])${horizontal}*(?!${followingField}))?(?:${valuePattern})`, 'dgi');
    let headerIndex = 0;
    for (const match of text.matchAll(assignment)) {
      while (headerIndex < groupedHeaders.length && match.index >= groupedHeaders[headerIndex].end) headerIndex++;
      if (headerIndex < groupedHeaders.length && match.index >= groupedHeaders[headerIndex].start) continue;
      const group = match.findIndex((value, index) => index >= 2 && value !== undefined);
      const value = match[group];
      const [start, end] = match.indices[group];
      // The authorization rule already protects the token following its scheme.
      if (/authorization$/i.test(match[1]) && /^(?:Bearer|Basic)$/i.test(value)) {
        if (!authorizationSchemes.has(end)) throw new ScanError();
        continue;
      }
      // Generic English instructions are not unquoted credential assignments.
      if (/^(?:key|secret)$/i.test(match[1]) && group === match.length - 1 &&
          /\bis\b/i.test(text.slice(match.indices[1][1], start)) && /^(?:to|that)$/i.test(value) &&
          /^\s+[a-z]+(?:\s|[.!?]|$)/i.test(text.slice(end))) continue;
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
