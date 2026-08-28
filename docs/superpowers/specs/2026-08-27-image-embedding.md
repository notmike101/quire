# Image Embedding in Shares — Design Spec

**Status:** Draft for review
**Date:** 2026-08-27
**Test session:** `sess_5644681b-c452-4f07-9391-bd8289f62270` ("Create Christmas Saguaro Cactus SVG")

## Problem

Sessions where the agent viewed images (screenshots, images read from disk) currently share with no visual content. The `Read` tool output is a placeholder string (`[Attached image/jpeg: Read image]`), and screenshot tool output is a markdown link to a local file. The viewer shows neither as an image.

The user wants those images visible in the share, **without storing the image file on the server** (storage grows unboundedly; tracking files on expiry/revocation is hard).

## How images actually flow in ZCode (verified against the test session)

Two image sources exist in the test session:

### Source 1 — `Read` tool on an image file (17 parts, the reliable source)

When the agent `Read`s an image, the part's `state` carries an **`attachments` array**:

```json
{
  "type": "file",
  "mime": "image/jpeg",
  "filename": "Read image",
  "url": "zcode-artifact://sess_5644681b-…/tool-result-5a6b0d18-…",
  "metadata": { "artifactUri": "zcode-artifact://…", "sizeBytes": 281691, "storageKind": "artifact" }
}
```

The image bytes are stored as a **data URI** (base64) in ZCode's artifact store:
`~/.zcode/cli/artifacts/<sessionId>/<random>-media-1-<toolResultId>.txt`

The file content is `data:<mime>;base64,<payload>`. Verified: all 17 image attachments in the test session resolve to an artifact on disk (0 missing). The `toolResultId` is the last path segment of the attachment `url`.

The part's `state.output` is just the placeholder string `[Attached image/jpeg: Read image]` — no base64 in the DB.

### Source 2 — `browser_take_screenshot` tool (11 parts, file on disk)

The tool `input` is `{filename: "cactus_v3.png", type: "png", scale: "css"}` and the `output` is a markdown link `[Screenshot of viewport](./cactus_v3.png)`. The file lives in the session's working directory (`session.directory`). **No attachments, no base64** — the bytes are only on disk at the relative path.

### Why Source 1 is the primary target

- It's self-contained: the data URI is already base64; no file-path resolution, no working-directory dependency.
- It's what the agent actually *viewed* (the model saw these images).
- Source 2's files may be deleted (the working dir is ephemeral); resolving them adds a failure mode. We'll handle Source 2 as a best-effort secondary.

## Design

### Core decision: data URI in the `parts` jsonb, no new table, no binary blob

The CLI reads each image at **publish time**, base64-encodes it, and emits a new **`image` part** carrying a `data:` URI. The server stores it in the existing `share_messages.parts` jsonb column. No new table, no binary/blob column, no file on the server's disk.

**Interpreting "no server storage":** the constraint is *no separate file/blob that must be tracked and cleaned up on expiry*. A data URI in the existing jsonb row is not a file — it's part of the message row that already cascade-deletes on revocation/expiry. Tracking is free (the row is the unit of lifecycle). The trade-off is that the base64 *is* in Postgres (a 500 KB image → ~670 KB in the row). To bound worst-case row size, the CLI **caps per-image bytes** and skips oversized images with a placeholder.

This is the only option that fits the existing single-VPS deployment with no external static host, no new upload step, and no file lifecycle to manage. (A "public URL to publisher's host" alternative was rejected: it requires the publisher to run a public static host, breaks when they delete files, and adds an external dependency + upload step that doesn't fit the deployment.)

### New part type: `image`

```ts
// ShapedPart (cli) / SharePart (web) / partSchema (server)
{
  type: 'image',
  src: string,        // data: URI, e.g. "data:image/jpeg;base64,…"
  mime: string,       // "image/jpeg" | "image/png" | …
  alt?: string,       // short label, e.g. "Read image" or "cactus_v3.png"
  bytes?: number,     // original file size (for display / debugging)
}
```

The `src` is the data URI. The viewer renders `<img :src="part.src" :alt="part.alt">`.

### Per-image size cap

`MAX_IMAGE_BYTES = 2 * 1024 * 1024` (2 MB raw). The CLI:
- If the image file is ≤ 2 MB → read, base64-encode, emit an `image` part.
- If > 2 MB → emit an `image` part with `src: null`-ish marker (or a `placeholder: true` flag) and the viewer shows a muted "image too large to embed" chip. (Simpler: emit a `system`-style note. Decision: emit an `image` part with a `tooLarge: true` flag and no `src`; viewer renders a placeholder.)

Base64 inflates ~33%, so 2 MB raw → ~2.7 MB base64 in the row. Bounded.

### CLI changes

#### `cli/src/harness/types.ts`
Extend `ShapedPart`:
```ts
export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  // image parts:
  src?: string;     // data: URI
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}
```

#### `cli/src/harness/zcode.ts`
1. Extend `RawPart.state` to include `attachments?: Attachment[]` where:
   ```ts
   interface Attachment {
     type?: string; mime?: string; filename?: string; url?: string;
     metadata?: { sizeBytes?: number; artifactUri?: string };
   }
   ```
2. In `partToShaped` (or a new `extractImageParts` step), for a `tool` part:
   - Look at `state.attachments`. For each attachment with `type === 'file'` and `mime` starting with `image/`:
     - Derive the artifact path: `~/.zcode/cli/artifacts/<sessionId>/<dir>-media-1-<toolResultId>.txt` where `toolResultId = url.split('/').pop()`. Since the random prefix is unknown, **readdir the artifact dir and match on the `toolResultId` suffix** (verified: exactly one file matches per toolResultId).
     - Read the file. It's a data URI string. Parse out the base64 payload + mime.
     - If `sizeBytes` (or decoded length) ≤ `MAX_IMAGE_BYTES` → emit an `image` part `{type:'image', src: dataUri, mime, alt: filename, bytes: sizeBytes}`.
     - Else → emit `{type:'image', tooLarge: true, mime, alt: filename, bytes: sizeBytes}` (no `src`).
   - **Dedupe:** the same image may be Read multiple times (the test session Reads `cactus.svg` 11×, `cactus_final.png` appears in 3 screenshot calls). Key by `toolResultId` (or by data-URI hash) and emit each unique image once per message. Actually — each Read is a separate tool part in a separate message, so dedupe is per-message (one image part per tool part). Cross-message dedupe is optional; skip it for v1 (the transcript shows the image at each point it was viewed, which is correct).
3. **Placement:** the `image` part is emitted **immediately after** the `tool` part it belongs to (so the viewer shows the tool card, then the image). This keeps the transcript chronological.
4. **Source 2 (screenshots) — best-effort:** for a `tool` part whose `tool` name matches a screenshot tool (`browser_take_screenshot`) and whose `input.filename` is present, resolve `path.join(session.directory, input.filename)`. If the file exists and is an image (by extension) and ≤ cap → emit an `image` part. If not → skip (the markdown link in `output` still renders as text). This is best-effort; no error if the file is gone.
   - *Note:* this requires `loadSession` to know `session.directory` (currently it only selects `id, title`). Add `directory` to the session query.

#### `cli/src/harness/claude-code.ts`
Claude Code encodes images as `{type:'image', source:{type:'base64', media_type, data}}` blocks inside `tool_result` content. The current `toolResultText` flattens non-string content to JSON. Extend the tool-result handling: if the `tool_result` content is an array containing an `image` block, emit an `image` part with the base64 data as a data URI. (Lower priority — the test session is ZCode; implement after the ZCode path is verified.)

#### `cli/src/shape.ts` (or a new `cli/src/image.ts`)
- `MAX_IMAGE_BYTES` constant.
- `readArtifactDataUri(artifactDir, toolResultId): { dataUri, mime, bytes } | null` — readdir + suffix match + parse.
- `fileToDataUri(filePath, mime): { dataUri, bytes } | null` — for Source 2.
- `isImageMime(mime)`, `mimeFromExtension(ext)`.

### Server changes

#### `server/src/api/schema.ts`
Extend `partSchema` (currently `.strict()`):
```ts
type: z.enum(['text', 'tool', 'reasoning', 'system', 'image']),
src: z.string().max(4_000_000).optional(),   // data URI; 4MB base64 cap
mime: z.string().max(100).optional(),
alt: z.string().max(200).optional(),
bytes: z.number().int().nonnegative().optional(),
tooLarge: z.boolean().optional(),
```

#### `server/src/redact/prepare.ts`
Extend the local `ShapedPart` copy with the image fields. **Critical:** `redactPart` must NOT run the data URI through `redactText` — the base64 payload could false-positive on the `generic-secret` rule (a long `[A-Za-z0-9+/=_-]{16,}` run after a `=`). Add the image fields to the "pass through untouched" set: `redactPart` copies `src`, `mime`, `alt`, `bytes`, `tooLarge` verbatim. (The data URI is not a secret; it's the image. Redacting it would corrupt the image.)

**Redaction-safety verification (done):** I checked all 10 rules against a data URI. The only risk is `generic-secret` (`/\b(api[_-]?key|secret|token|…)(\s*[:=]\s*)(['"]?)([A-Za-z0-9+/=_\-]{16,})\3/gi`) — but it requires a *keyword* (`api_key`, `secret`, `token`, etc.) immediately before the `=`, which a data URI's `base64,` prefix does not have. The `jwt` rule requires `eyJ…` (a JWT header), which base64 image data does not start with. So a data URI is safe *if* it's excluded from `redactText` — and we exclude it explicitly, so it's doubly safe.

### Web changes

#### `web/src/api.ts`
Extend `SharePart` with the image fields (mirror the server schema).

#### `web/src/components/`
- New `ImagePart.vue` (or inline in `AssistantMessage.vue`): renders `<img :src="part.src" :alt="part.alt" loading="lazy">` with max-width 100%, rounded corners, a subtle border. If `part.tooLarge` → a muted placeholder chip "📷 image too large to embed (N MB)".
- `AssistantMessage.vue`: add an `image` branch in the part dispatch (before the `else`/`ReasoningBlock` fallback).
- `App.vue` `userParts`: images on user messages (if a user pastes an image) — add `image` to the filter. (Low priority; ZCode user messages don't carry image attachments in the test session.)
- `style.css`: add `.prose-quire img` / `.image-part img` rules (max-width 100%, height auto, border-radius, margin).

**CSP:** `server/src/api/headers.ts` already has `img-src 'self' data:` — data URIs are allowed. No CSP change needed.

### No DB migration

`share_messages.parts` is jsonb — a new part type/field needs no migration.

## Chunking interaction

The CLI's `chunkMessages()` greedy-packs ≤19 MB message-groups. An image part's base64 (up to ~2.7 MB) counts toward the chunk byte total (computed from `JSON.stringify` of the redacted parts). This is correct — a chunk with a large image simply packs fewer messages. No change needed, but the chunker's byte estimate must include the `src` field (it does, since it stringifies the whole part).

## Expiry / revocation

No change. The image is part of the message row; `DELETE` on the share cascade-deletes all rows (including the base64). No orphan files to clean up. This is the whole point of the data-URI approach.

## Testing

- **CLI unit:** `zcode.test.ts` — fixture gains a `Read`-image part with an attachment; assert an `image` part is emitted with the correct data URI (use a tiny 1×1 PNG data URI in the fixture artifact). Assert oversized → `tooLarge`. Assert non-image attachment (e.g. a `.json` artifact) is NOT emitted as an image.
- **CLI unit:** `shape.test.ts` (or `image.test.ts`) — `readArtifactDataUri` suffix-match, `fileToDataUri`, `isImageMime`, cap logic.
- **Server unit:** `prepare.test.ts` — an `image` part's `src` passes through `redactPart` untouched (not mangled by any rule).
- **Web unit:** `components.test.ts` — `ImagePart` renders `<img>` with the data URI; `tooLarge` renders the placeholder.
- **E2E:** a share with an image part renders the `<img>` in-browser (use a tiny data URI so the test is fast).
- **Live verification (the test session):** publish `sess_5644681b` to the live server, fetch the public API, confirm the 17 Read-image parts are stored as `image` parts with data URIs, and view in-browser (CloakBrowser) to confirm the cactus screenshots render.

## Out of scope (v1)

- Cross-message image dedupe (same image viewed 3× shows 3× — acceptable, it's the transcript).
- Image compression/resizing on the CLI (the 2 MB cap handles size; no re-encoding).
- Source 2 (screenshot files) is best-effort; if the file is gone, the markdown link renders as text (current behavior).
- Claude Code image blocks (implement after ZCode is verified; the test session is ZCode).

## Open questions for the user

1. **Per-image cap:** 2 MB raw (→ ~2.7 MB base64) — reasonable? The test session's images are 140 KB–747 KB, all well under.
2. **Oversized behavior:** placeholder chip ("image too large to embed") vs. skip entirely (no part emitted). I recommend the placeholder (the transcript shows an image was there).
3. **Source 2 (screenshots):** include the best-effort on-disk file resolution, or v1 = Read-attachments only? I recommend including it (the cactus screenshots are the headline content of the test session), but it's the higher-complexity part.
