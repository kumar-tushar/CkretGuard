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

  function looksLikeSecret(value, strong) {
    const minimum = strong ? 12 : 20;
    if (value.length < minimum || value.length > 512 || placeholders.test(value) ||
        !/^[A-Za-z0-9_+/.~!@$%^&*?=-]+$/.test(value) || !/[a-z]/i.test(value)) return false;
    const letters = value.replace(/[^a-z]/gi, ''), digits = value.replace(/[^0-9]/g, '');
    const parts = value.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean);
    const readable = part => /^(?:a|i|an|as|at|be|by|do|if|in|is|it|no|of|on|or|so|to|up|us|we|api|http|https|json|html|css|sql|sdk|uuid|url|jwt|xml|id|ip|db|os|ui)$/i.test(part) ||
      (part.length >= 3 && (part.match(/[aeiouy]/gi)?.length ?? 0) / part.length >= .25 && !/[bcdfghjklmnpqrstvwxz]{5}/i.test(part));
    // Human-readable identifiers and word-separated examples are weak evidence, even with digits.
    const frequencies = new Map();
    for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    if (frequencies.size < 8) return false;
    let entropy = 0;
    for (const count of frequencies.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
    if (/^[a-f0-9]{32,}$/i.test(value)) return entropy >= (strong ? 3 : 3.3);
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return strong && entropy >= 3.2;
    if (parts.length && parts.every(readable)) return false;
    const changes = (value.match(/[a-z][A-Z]|[A-Z][a-z]/g) ?? []).length;
    if (letters.length >= 4 && digits.length) return entropy >= (strong ? 3.2 : 3.8) &&
      (digits.length >= 3 || changes >= 3 || /[_+/~!@$%^&*?=-]/.test(value));
    if (/^[A-Za-z0-9+/]+={1,2}$/.test(value)) return entropy >= (strong ? 3.2 : 3.8);
    const vowelRatio = (letters.match(/[aeiouy]/gi)?.length ?? 0) / letters.length;
    return value.length >= (strong ? 20 : 24) && entropy >= (strong ? 3.6 : 4) &&
      ((changes >= 4 && /[a-z]/.test(value) && /[A-Z]/.test(value)) ||
        (vowelRatio < .17 && /[bcdfghjklmnpqrstvwxz]{5}/i.test(letters)));
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
    // An empty field must not consume another assignment on the following line.
    const assignment = new RegExp(`(${label})["'”’\x60]*${horizontal}*${separator}${horizontal}*(?:(?:\\r\\n|[\\r\\n])${horizontal}*(?!${followingField}))?(?:${valuePattern})`, 'dgi');
    for (const match of text.matchAll(assignment)) {
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
      if (group === match.length - 1 && /\bis\b/i.test(text.slice(match.indices[1][1], start)) &&
          /^(?:above|below|here|there|at|in|the|provided|listed|located|shown|available|following|mentioned|stored|placed|included|written|present|not)$/i.test(value.replace(/[.!?]+$/, ''))) continue;
      add(start, end, 'named-secret');
    }
    // Field mentions enable one independent whole-draft pass, regardless of direct matches.
    const weakNames = new Set(['key', 'secret', 'token']);
    const fieldPattern = name => name.split(/[_ -]+/).map(escape).join(`(?:${horizontal}|[_-])*`);
    const keywordPattern = fields => fields.length ? new RegExp(`(?<![\\w-])(?:[a-zA-Z][a-zA-Z0-9]*[_-])*?(?:${fields.join('|')})(?![\\w-])`, 'gi') : null;
    const strongFields = [...new Set(builtIn.filter(name => !weakNames.has(name)).map(name => `(?:${fieldPattern(name)})s?`)),
      ...policy.sensitiveNames.map(escape).sort((a, b) => b.length - a.length)];
    const strongMentions = [...text.matchAll(keywordPattern(strongFields))];
    const weakMentions = [...text.matchAll(keywordPattern([...weakNames].map(name => `${name}s?`)))];
    if (strongMentions.length || weakMentions.length) {
      const ignored = [...candidates, ...strongMentions.map(match => ({ start: match.index, end: match.index + match[0].length })),
        ...weakMentions.map(match => ({ start: match.index, end: match.index + match[0].length }))];
      for (const match of text.matchAll(/\$\{[^{}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>\s]+>|\[REDACTED\]|\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'“”‘’`]+/gi)) {
        ignored.push({ start: match.index, end: match.index + match[0].length });
      }
      const publicFields = ['request_id', 'trace_id', 'correlation_id', 'transaction_id', 'commit_hash',
        'checksum', 'sha256', 'sha512', 'md5', 'hash', 'uuid'];
      if (!policy.protectClientIds && !policy.sensitiveNames.some(name => /^client[_ -]*id$/i.test(name))) publicFields.push('client_id');
      const publicPatterns = publicFields.filter(field => !policy.sensitiveNames.some(name => name.replace(/[_ -]/g, '').toLowerCase() === field.replace(/_/g, ''))).map(fieldPattern);
      const publicValue = new RegExp(`(?<![\\w-])(?:${publicPatterns.length ? publicPatterns.join('|') : '(?!)'})(?![\\w-])["'”’\x60]*(?:${horizontal}*(?::|=|：|＝|\\bis\\b)${horizontal}*(?:(?:\\r\\n|[\\r\\n])${horizontal}*)?|${horizontal}+)(?:${valuePattern})`, 'dgi');
      for (const match of text.matchAll(publicValue)) {
        const group = match.findIndex((value, index) => index >= 1 && value !== undefined);
        ignored.push({ start: match.indices[group][0], end: match.indices[group][1] });
      }
      ignored.sort((a, b) => a.start - b.start || b.end - a.end);
      const ranges = [];
      for (const item of ignored) {
        const previous = ranges.at(-1);
        if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
        else ranges.push({ start: item.start, end: item.end });
      }
      let cursor = 0;
      for (const match of text.matchAll(/[^\s"'“”‘’`<>{}\[\](),;]+/g)) {
        let value = match[0], start = match.index;
        const assignment = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}[:=]/.exec(value);
        if (assignment && !looksLikeSecret(assignment[0].slice(0, -1), strongMentions.length > 0)) { value = value.slice(assignment[0].length); start += assignment[0].length; }
        const wrapped = /^(?:\*\*)?(.+?)(?:\*\*)?[.:]?$/.exec(value);
        if (!wrapped) continue;
        start += value.indexOf(wrapped[1]); value = wrapped[1];
        const end = start + value.length;
        while (cursor < ranges.length && ranges[cursor].end <= start) cursor++;
        if (cursor < ranges.length && ranges[cursor].start < end) continue;
        if (/^[^@]+@[^@]+\.[^@]+$/.test(value) || /^(?:\/|\.\.?\/)/.test(value) || /\.[a-z]{1,6}$/i.test(value)) continue;
        if (looksLikeSecret(value, strongMentions.length > 0)) add(start, end, 'context-secret');
      }
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
