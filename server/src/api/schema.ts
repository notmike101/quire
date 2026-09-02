import { z } from 'zod';

const imageSchema = z
  .object({
    src: z.string().max(4_000_000).optional(), // data: URI; ~2.7 MB base64 cap
    mime: z.string().max(100).optional(),
    alt: z.string().max(200).optional(),
    bytes: z.number().int().nonnegative().optional(),
    tooLarge: z.boolean().optional(),
  })
  .strict();

export const partSchema = z
  .object({
    type: z.enum(['text', 'tool', 'reasoning', 'system', 'image']),
    text: z.string().max(1_000_000).optional(),
    callID: z.string().max(200).optional(),
    tool: z.string().max(200).optional(),
    status: z.string().max(100).optional(),
    // Round 8: z.unknown() is unbounded BY DESIGN — depth is handled elsewhere.
    // The 20 MB request cap bounds size; a body nested deep enough to overflow
    // the JSON.parse stack throws a RangeError that c.req.json().catch() maps
    // to a 400; and the redaction walk (walkStrings) is iterative with an
    // explicit depth cap, collapsing over-deep subtrees to a redacted JSON
    // string. No schema-level depth limit is needed.
    input: z.unknown().optional(),
    output: z.string().max(1_000_000).optional(),
    // tool parts: images the agent viewed, rendered inside the tool card's
    // collapsible body (Read attachments, screenshot tool output, etc.).
    images: z.array(imageSchema).max(20).optional(),
    // standalone image parts (type: 'image'): the agent's deliberate markdown
    // screenshots in text parts — rendered expanded, outside any tool card.
    src: z.string().max(4_000_000).optional(),
    mime: z.string().max(100).optional(),
    alt: z.string().max(200).optional(),
    bytes: z.number().int().nonnegative().optional(),
    tooLarge: z.boolean().optional(),
  })
  .strict();

export const messageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    time: z.string().datetime({ offset: true }).optional(),
    parts: z.array(partSchema).max(10_000),
  })
  .strict();

export const shapedSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    model: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
// .min(1): a zero-message session would create a share whose first page
// has 0 rows, so the public endpoint would 404 it forever.
    messages: z.array(messageSchema).min(1).max(100_000),
  })
  .strict();

export const unlockBodySchema = z.object({ password: z.string().min(1).max(200) }).strict();

export const patchBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
