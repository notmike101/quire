export type Preset = 'strict' | 'normal' | 'none';

export interface RedactRule {
  category: string;
  pattern: RegExp;
  presets: Preset[];
  /** Produce the replacement from the match (default: `[REDACTED:<category>]`). */
  replace?: (match: string, ...groups: string[]) => string;
}

// Order matters: earlier rules claim their span first, and their placeholder
// shields that span from later rules.
export const rules: RedactRule[] = [
  {
    category: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'jwt',
    // Chain F: the eyJ branch is preferred (real JWTs start with the base64 of
    // '{"'); the generic branch also catches non-eyJ three-segment dot tokens.
    pattern: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'connection-string',
    // Chain F: the first branch is the user:pass@host form; the second catches
    // query-string credentials (?password=… / &token=…) that carry no user@host.
    pattern: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^@\s]+@|(?::|&|\?)(password|passwd|pwd|token|key|secret)s?=[^&\s]+/gi,
    presets: ['strict', 'normal'],
    replace: (m, scheme, _q, _s, credKey) => (scheme ? `${scheme}://[REDACTED:connection-string]@` : `${credKey}=[REDACTED:connection-string]`),
  },
  {
    category: 'bearer-token',
    pattern: /\b(?:[Aa]uthorization:\s*Bearer\s+|bearer\s+)[A-Za-z0-9._-]{20,}/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'generic-secret',
    // Chain F: floor lowered 16→8 and the key-name list widened so short
    // secrets and more naming conventions are caught.
    pattern: /\b(api[_-]?key|secret|token|passwd|password|auth|credential|access|jwt|session|cookie|dsn|conn|private)(\s*[:=]\s*)(['"]?)([A-Za-z0-9+/=_\-]{8,})\3/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key, sep, _q, _v) => `${key}${sep}[REDACTED:generic-secret]`,
  },
  {
    category: 'bare-token',
    // Chain F: a keyword-less high-entropy fallback. Runs LAST so the specific
    // rules above claim their spans first; the lookaround requires at least one
    // of . _ - so ordinary long prose words (no separators) are not redacted.
    pattern: /\b(?=[A-Za-z0-9._-]*[._-])[A-Za-z0-9._-]{24,}\b/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'private-ip',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    presets: ['strict'],
  },
  {
    category: 'local-path',
    pattern: /\b[A-Za-z]:\\[^\s"'<>|*?]+|(?<!\w)(?:\/home|\/Users|\/root)\/[^\s"'<>|*?]+/g,
    presets: ['strict'],
  },
];
