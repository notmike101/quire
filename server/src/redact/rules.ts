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
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
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
    pattern: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^@\s]+@/g,
    presets: ['strict', 'normal'],
    replace: (_m, scheme) => `${scheme}://[REDACTED:connection-string]@`,
  },
  {
    category: 'bearer-token',
    pattern: /\b(?:[Aa]uthorization:\s*Bearer\s+|bearer\s+)[A-Za-z0-9._-]{20,}/g,
    presets: ['strict', 'normal'],
  },
  {
    category: 'generic-secret',
    pattern: /\b(api[_-]?key|secret|token|passwd|password)(\s*[:=]\s*)(['"]?)([A-Za-z0-9+/=_\-]{16,})\3/gi,
    presets: ['strict', 'normal'],
    replace: (_m, key, sep, _q, _v) => `${key}${sep}[REDACTED:generic-secret]`,
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
