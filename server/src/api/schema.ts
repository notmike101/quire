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
    messages: z.array(messageSchema).max(100_000),
  })
  .strict();

export const unlockBodySchema = z.object({ password: z.string().min(1).max(200) }).strict();

export const patchBodySchema = z
  .object({
    password: z.string().min(1).max(200).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    revoke: z.boolean().optional(),
  })
  .strict();

export type ShapedSession = z.infer<typeof shapedSessionSchema>;

const presetSchema = z.enum(['strict', 'normal', 'none']);

export const previewBodySchema = z
  .object({ session: shapedSessionSchema, preset: presetSchema.default('strict') })
  .strict();

export const createBodySchema = z
  .object({
    session: shapedSessionSchema,
    preset: presetSchema.default('strict'),
    password: z.string().min(1).max(200).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    // Chain E: how many chunks the publisher will send. The public endpoint
    // returns 404 until this many distinct chunkSeqs have arrived, so a killed
    // upload never serves a partial share as complete. Default 1 (single upload).
    expectedChunks: z.number().int().positive().max(10_000).default(1),
  })
  .strict();

export const chunkBodySchema = z
  .object({
    uploadId: z.string().min(1).max(64),
    chunkSeq: z.number().int().nonnegative(),
    messages: z.array(messageSchema),
  })
  .strict();

export type ChunkBody = z.infer<typeof chunkBodySchema>;

export type PreviewBody = z.infer<typeof previewBodySchema>;
export type CreateBody = z.infer<typeof createBodySchema>;
