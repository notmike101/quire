# Oh My Pi Sharing Support

- **Date:** 2026-08-31
- **Status:** Approved design

## Goal

Replace Oh My Pi's interactive TUI `/share` behavior with Quire while preserving
the existing command name and Quire's security model. Running `/share` in a
persistent OMP TUI session publishes the exact active conversation through
Quire's existing preview, chunking, upload, server-side redaction, storage, and
viewer pipeline.

The first release deliberately uses strict redaction, no password, and no
expiration. Advanced options remain available through the Quire CLI rather than
adding a second prompt or configuration layer to OMP's argumentless command.

## Scope

This change adds:

- an OMP export adapter in the Quire CLI;
- `omp` harness selection, validation, and help text;
- a bundled OMP custom-share handler;
- a safe `quire setup omp` installer;
- deterministic adapter, handler, installer, and CLI tests; and
- OMP installation, usage, limitations, and recovery documentation.

It does not change Quire's server API, database schema, redaction engine, or
viewer. It does not replace OMP sharing in headless or ACP mode, publish
`--no-session` sessions, reproduce OMP's branch tree or subagent viewer, add
password/expiry prompts, or alter OMP itself.

## Current OMP constraints

OMP reserves built-in slash-command names, so an extension cannot shadow
`/share`. The supported TUI replacement seam is a custom handler at the first
existing path among:

- `${PI_CODING_AGENT_DIR}/share.ts`, `share.js`, or `share.mjs` when
  `PI_CODING_AGENT_DIR` is set; or
- `~/.omp/agent/share.ts`, `share.js`, or `share.mjs` otherwise.

OMP calls the handler with a temporary HTML export of the exact active session.
The export contains a base64-encoded JSON `SessionData` payload in a single
`<script id="session-data" type="application/json">` element. OMP removes the
temporary file after the handler returns.

Custom share handlers run only in the interactive TUI. Headless and ACP
`/share` bypass them and use OMP's native encrypted sharing. OMP cannot generate
the temporary HTML for an in-memory `--no-session` session, so that case also
remains outside Quire support.

These behaviors are documented by OMP's
[`session-operations-export-share-fork-resume.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/session-operations-export-share-fork-resume.md),
[`custom-share.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/export/custom-share.ts),
and [HTML exporter](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/export/html/index.ts).

## Decision and alternatives

### Selected: custom handler plus OMP export adapter

Install a supported OMP custom-share handler. The handler passes OMP's exact
temporary HTML path to the Quire CLI, which decodes the structured session data
and maps it into the existing `ShapedSession` contract.

This preserves `/share`, avoids an active-session discovery race, keeps the
server and viewer harness-agnostic, and requires no OMP fork. Its compatibility
cost is a narrow dependency on OMP's documented export payload. Fixture tests
and fail-closed parsing make changes to that contract visible.

### Rejected: locate and parse the current OMP JSONL

OMP persists sessions as JSONL, which would be a natural source for historical
CLI publishing. The custom-share handler does not receive the active JSONL path,
however. Selecting the newest store can publish the wrong conversation when two
OMP terminals are active, and matching the HTML snapshot back to a file adds an
avoidable search and race. Direct JSONL publishing can be designed separately
if historical-session support becomes a requirement.

### Rejected: emulate OMP's native share server

Pointing OMP's `share.serverUrl` at Quire would minimize client installation,
but OMP uploads an AES-256-GCM encrypted blob whose key exists only in the URL
fragment. Quire's server could not inspect and redact that content at ingestion.
Accepting it would require a separate storage/viewer protocol and would violate
Quire's defining invariant that only server-redacted content is persisted or
served.

### Rejected: extension command named `/quire`

A differently named command avoids OMP's reserved `/share`, but fails the stated
goal of replacing the built-in command and leaves two competing share paths in
the TUI. The supported custom-handler seam provides the intended replacement
without this UX split.

## Architecture

### OMP custom-share handler

The CLI package includes a plain ESM asset for OMP. OMP invokes its default
exported async function with `htmlPath`. The handler starts Quire with an
argument array, never a shell-composed command:

```text
quire publish <htmlPath> --harness omp --preset strict --yes
```

On Windows it invokes the platform-appropriate command shim without putting the
HTML path through a shell. The path is supplied as one argument even when it
contains spaces or shell metacharacters.

The handler captures stdout and stderr. On success it extracts the one
`Published:` URL emitted by Quire and returns `{ url, message }` to OMP. The
message contains Quire's message count, stored size when reported, and redaction
summary, allowing OMP to display the normal result and open the returned URL.
It must not echo raw title or transcript content.

A missing executable, nonzero exit, timeout, missing/ambiguous published URL,
or malformed CLI output raises a concise error. OMP intentionally does not fall
back to native sharing after a custom-handler failure; recovery is to fix the
Quire configuration or rename/remove the installed handler.

### CLI input and adapter selection

`omp` is added to `HarnessName`, `HarnessAdapter.name`, `--harness` validation,
adapter construction, usage text, and errors listing accepted harnesses.

For this integration the publish positional identifies the input export path,
not a discovered OMP session ID. `resolveSession()` already attempts
`adapter.loadSession(id)` when a positional is absent from the recent-session
list, so the OMP adapter can deliberately expose an empty discovery list and
load the exact `.html` path directly. The custom handler always supplies both
the path and `--harness omp`; no automatic OMP detection is added because it is
unnecessary for the supported flow and would require a less reliable current
session heuristic.

`--current --harness omp` fails with an actionable message explaining that the
OMP handler supplies the exact export path. Supporting historical OMP discovery
or direct JSONL loading is future work, not latent behavior in this adapter.

### HTML payload extraction

The adapter reads the temporary HTML as data. It does not load it in a browser,
evaluate JavaScript, resolve external resources, or use a general DOM runtime.
A bounded extractor locates exactly one script element whose `id` is
`session-data` and whose `type` is `application/json`, accepting harmless
attribute order and whitespace differences. It then:

1. rejects a missing or duplicate matching element;
2. enforces a maximum encoded-payload size before decoding;
3. validates that the element body is base64 text only;
4. decodes with a maximum decoded size;
5. parses JSON; and
6. validates only the fields needed for shaping.

Unexpected or malformed data fails closed with an OMP-specific error. The
adapter does not fall back to scraping rendered HTML.

### Active branch reconstruction

OMP exports an append-only entry tree and identifies the selected leaf with
`leafId`. Quire's viewer is linear, so the adapter publishes only the active
branch:

1. index entries by unique non-empty `id`;
2. start at `leafId`;
3. follow each entry's `parentId` to the root;
4. reject missing parents, duplicate IDs, or cycles; and
5. reverse the collected chain into conversation order.

Entries on abandoned sibling branches are not flattened into the share.
Top-level `subSessions` are omitted in this release because Quire has no
sub-session navigation contract and agent-internal transcripts are not part of
the selected user conversation.

## Transcript shaping

The adapter maps only user-visible content on the reconstructed active branch:

| OMP content | Quire result |
|---|---|
| User text | user text part |
| User inline image | user image part within existing image limits |
| Assistant text | assistant text part |
| Assistant thinking | assistant reasoning part |
| Assistant tool call | assistant tool part with bounded input |
| Matching tool result | bounded output attached by tool-call ID |
| Visible `custom_message` (`display: true`) | system-notice part |
| `reset_boundary` | short `Conversation cleared` system notice |

Tool results without a retained matching call are omitted. A retained tool call
without a result remains visible with its available status. Multiple content
parts from one OMP message retain their source order. Empty shaped messages are
discarded.

The adapter omits:

- exported `systemPrompt` and tool definitions;
- `session_init` prompts, tasks, tool lists, and output schemas;
- hidden custom messages and every generic custom entry;
- credential pins and other account identifiers;
- model, thinking-level, service-tier, mode, label, title-change, and TTSR
  bookkeeping entries;
- compaction summaries, branch summaries, extension `details`, `data`, and
  `preserveData` payloads; and
- exported subagent sessions.

The session header provides `sessionId` and title. Model and provider metadata
come only from retained ordinary messages, never from internal initialization
records. Quire's server redacts the title, model, provider, messages, tool data,
and image metadata through the existing ingestion path.

### Images and local-file safety

Embedded data images use Quire's existing per-image and cumulative session
budgets. Oversized images become `tooLarge` placeholders when the existing
shaped contract supports them. Remote image URLs remain non-fetched text or are
omitted according to the source content type.

If an OMP content part references a local image rather than embedding it, the
adapter may read it only when the resolved path is contained by the header's
`cwd` or one of its `additionalDirectories`. Missing, unreadable, unsupported,
or out-of-workspace paths are not opened. No remote content is fetched while
shaping.

### Resource limits

The adapter reuses Quire's existing message count, tool-input, tool-output,
per-image, and total-image limits. It also adds explicit encoded HTML payload
and decoded JSON limits no larger than Quire's accepted single-session request
budget. Reaching a shaping limit emits one content-free warning. Preview and
chunk upload limits remain unchanged.

## Installation and recovery

`quire setup omp` installs the bundled asset as `share.mjs` under OMP's agent
directory. It creates the agent directory when absent and respects
`PI_CODING_AGENT_DIR`.

Before writing, it checks all supported candidates (`share.ts`, `share.js`, and
`share.mjs`). If any exists, installation refuses to overwrite or chain it and
prints the exact conflict plus manual migration guidance. Chaining is rejected
because it can double-publish, obscure which URL is authoritative, and make
failure semantics unpredictable.

Installation uses an atomic same-directory temporary file followed by rename so
OMP never observes a partial handler. Re-running against an identical
Quire-installed file succeeds idempotently; a different `share.mjs` is treated
as a conflict. The installer prints the final path and the exact `/share`
behavior it enables.

There is no automatic uninstall command in this release. To restore OMP-native
sharing, the user renames or removes the installed `share.mjs` and restarts or
reloads OMP. This procedure and the fact that custom-handler failures do not
fall back are documented prominently.

## Error behavior

- Unsupported `--current --harness omp`: explain that OMP must supply its exact
  temporary export path.
- Missing/unreadable export: fail before preview or upload without printing raw
  path-adjacent content.
- Invalid HTML/payload/branch graph: fail closed with a short OMP-specific
  diagnostic.
- Quire CLI missing or misconfigured: handler reports installation/configuration
  guidance; OMP does not fall back automatically.
- Preview rejection, aborted confirmation, or upload failure: existing Quire
  behavior applies. The handler supplies `--yes`, so it never waits for input.
- Installer collision: preserve the existing handler byte-for-byte and explain
  the manual choices.

No error includes raw transcript text, title, tool input/output, secrets, or the
Quire API key.

## Testing

All fixtures are synthetic and byte-stable, with fixed timestamps and no real
OMP sessions.

### Adapter fixtures and tests

- minimal exported HTML with a valid base64 `SessionData` payload;
- harmless script-attribute order and whitespace variations;
- missing, duplicate, non-base64, invalid-JSON, oversized, and schema-invalid
  payloads;
- linear and branched entry graphs, including exact active-leaf selection;
- duplicate IDs, missing parents, missing leaf, and parent cycles;
- user/assistant text, thinking, tool calls, matching results, images, visible
  custom messages, and reset boundaries;
- every explicitly omitted entry and exported top-level field;
- orphan tool results and incomplete tool calls;
- message, input/output, and image limits;
- remote-image non-fetching and multi-root local-file containment; and
- title/model/provider shaping without raw-content diagnostics.

### Handler tests

- exact argument vector, including paths with spaces and metacharacters;
- strict preset, explicit OMP harness, and noninteractive confirmation;
- successful URL and summary extraction;
- missing or multiple `Published:` lines;
- missing executable, nonzero exit, stderr, and timeout handling; and
- no shell interpolation on Windows or POSIX.

### Installer and CLI tests

- default and `PI_CODING_AGENT_DIR` destinations;
- missing-directory creation and atomic installation;
- idempotent reinstall of the identical bundled handler;
- refusal for each existing candidate and for modified `share.mjs`;
- `omp` harness construction, validation, usage, and error text;
- direct export-path publishing and rejected OMP `--current`; and
- unchanged ZCode, Claude Code, and Codex detection/publishing tests.

### Completion gate

Focused CLI and plugin tests and typechecks run first. Because `cli/src` and the
published CLI asset change, `cli/dist` is removed and rebuilt before smoke tests
use the built binary. The repository's full green gate from `AGENTS.md`,
including server, web, plugin, builds, and Docker E2E, remains required before
the implementation is considered complete.

## Documentation

Update the root README, plugin README, CLI usage, and `AGENTS.md` to cover:

- supported OMP interactive persistent TUI sessions;
- installation with `quire setup omp`;
- `/share` publishing with strict redaction, no password, and no expiry;
- direct CLI use for advanced Quire options;
- the unchanged server-side redaction boundary;
- headless/ACP and `--no-session` exclusions;
- existing-handler collision behavior; and
- manual removal/rename recovery when Quire or its configuration is unavailable.

## Security and compatibility invariants

- The OMP adapter shapes content but never treats local shaping as redaction.
- Only server-redacted content is persisted or served by Quire.
- The temporary HTML is parsed as bounded data and never executed.
- The handler publishes the exact OMP-provided export, never a guessed recent
  session.
- Internal prompts, extension-private state, account pins, abandoned branches,
  and subagent transcripts are never published.
- Remote content is never fetched during shaping.
- Local file reads are restricted to OMP-declared workspace roots.
- No raw session content or secrets appear in diagnostics.
- Existing share handlers are never overwritten or implicitly chained.
- Existing ZCode, Claude Code, Codex, server, and viewer behavior remains
  unchanged.
