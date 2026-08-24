import { z } from 'zod';

export const partSchema = z
  .object({
    type: z.enum(['text', 'tool', 'reasoning']),
    text: z.string().max(1_000_000).optional(),
    callID: z.string().max(200).optional(),
    tool: z.string().max(200).optional(),
    status: z.string().max(100).optional(),
    input: z.unknown().optional(),
    output: z.string().max(1_000_000).optional(),
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
  })
  .strict();

export type PreviewBody = z.infer<typeof previewBodySchema>;
export type CreateBody = z.infer<typeof createBodySchema>;
