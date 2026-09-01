import { describe, expect, it } from 'vitest';
import fixture from './fixtures/page-small.json' with { type: 'json' };
import {
  blobAad,
  layoutBlob,
  parseBlob,
  parseShareIndexSegment,
  parseShareManifest,
  parseSharePage,
  ProtocolError,
} from '../src/index.js';

const SHARE_ID = 'fixture-share';

describe('envelope', () => {
  it('round-trips nonce and ciphertext through layoutBlob/parseBlob', () => {
    const nonce = new Uint8Array(12).fill(0xab);
    // 5 payload bytes + 16-byte GCM tag, as a real sealed blob carries.
    const ciphertext = new Uint8Array([...[0xde, 0xad, 0xbe, 0xef, 0x01], ...new Array(16).fill(0x5a)]);
    const blob = layoutBlob(nonce, ciphertext);
    expect(blob.length).toBe(4 + 1 + 12 + ciphertext.length);
    expect(Array.from(blob.slice(0, 4))).toEqual([0x51, 0x53, 0x48, 0x52]); // "QSHR"
    expect(blob[4]).toBe(1);
    const parsed = parseBlob(blob);
    expect(parsed.nonce).toEqual(nonce);
    expect(parsed.ciphertext).toEqual(ciphertext);
  });

  it('rejects a blob shorter than magic+version+nonce+tag', () => {
    expect(() => parseBlob(new Uint8Array(10))).toThrow();
  });

  it('blobAad emits the exact literal bytes', () => {
    const aad = blobAad('share-123', 'page', 7);
    expect(Array.from(aad)).toEqual([
      0x71, 0x75, 0x69, 0x72, 0x65, 0x2d, 0x73, 0x68, 0x61, 0x72, 0x65, 0x2d, 0x76, 0x31, // "quire-share-v1"
      0x00,
      0x73, 0x68, 0x61, 0x72, 0x65, 0x2d, 0x31, 0x32, 0x33, // "share-123"
      0x00,
      0x70, 0x61, 0x67, 0x65, // "page"
      0x00,
      0x37, // "7"
    ]);
  });
});

describe('parseSharePage', () => {
  it('accepts the byte-stable fixture', () => {
    const page = parseSharePage(fixture);
    expect(page.protocol).toBe('quire-share-v1');
    expect(page.shareId).toBe(SHARE_ID);
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]?.role).toBe('user');
    expect(page.messages[1]?.parts).toHaveLength(2);
  });

  it('rejects a bad protocol', () => {
    expect(() => parseSharePage({ ...fixture, protocol: 'quire-share-v9' })).toThrow(ProtocolError);
  });

  it('rejects more than 50 messages', () => {
    const messages = Array.from({ length: 51 }, () => ({
      chunkSeq: 0,
      seq: 0,
      role: 'user',
      time: null,
      parts: [{ type: 'text', text: 'x' }],
    }));
    expect(() => parseSharePage({ ...fixture, messages })).toThrow(ProtocolError);
  });

  it('rejects empty messages', () => {
    expect(() => parseSharePage({ ...fixture, messages: [] })).toThrow(ProtocolError);
  });

  it('rejects a bad role', () => {
    const messages = [{ chunkSeq: 0, seq: 0, role: 'system', time: null, parts: [] }];
    expect(() => parseSharePage({ ...fixture, messages })).toThrow(ProtocolError);
  });

  it('rejects a non-integer seq', () => {
    expect(() => parseSharePage({ ...fixture, seq: 1.5 })).toThrow(ProtocolError);
  });
});

describe('parseShareIndexSegment', () => {
  it('rejects more than 2000 entries', () => {
    const entries = Array.from({ length: 2001 }, () => ({ chunkSeq: 0, seq: 0, preview: 'p' }));
    expect(() => parseShareIndexSegment({ protocol: 'quire-share-v1', shareId: SHARE_ID, seq: 0, entries })).toThrow(ProtocolError);
  });
});

describe('parseShareManifest', () => {
  it('rejects a negative redaction count', () => {
    const manifest = {
      protocol: 'quire-share-v1',
      shareId: SHARE_ID,
      title: 't',
      createdAt: '1970-01-01T00:00:00.000Z',
      expiresAt: null,
      messageCount: 2,
      redactions: { 'private-key': -1 },
      pageCount: 1,
    };
    expect(() => parseShareManifest(manifest)).toThrow(ProtocolError);
  });
});
