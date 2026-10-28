import './gitleaks-rules.js';
import './core.js';
export const { scan, redact, normalizePolicy, defaults, ScanError, MASK, MAX_CHARACTERS, MAX_CUSTOM_FIELDS } = globalThis.SecretShieldCore;
