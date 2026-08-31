# Codex Sharing Support

- **Date:** 2026-08-31
- **Status:** Approved design

## Goal

Let Quire publish Codex desktop and CLI tasks through the existing sharing pipeline. Users can run the CLI directly with `--harness codex` or invoke a native Codex `$share` skill. Codex content is shaped locally, sent to the existing server, redacted at ingestion, and rendered by the existing viewer.

## Scope

This change adds:

- a Codex harness adapter in the CLI;
- Codex-aware harness detection and CLI help/validation;
- a native Codex plugin manifest and `$share` skill;
- deterministic adapter and plugin tests; and
- Codex installation and usage documentation.

It does not change the server API, database schema, redaction pipeline, or viewer. It does not publish internal agent coordination or combine child-task transcripts into a parent task.

## Architecture

### Task discovery

The adapter reads `~/.codex/state_5.sqlite` in read-only mode. The `threads` table provides task IDs, titles, update times, model/provider metadata, and rollout paths. Normal discovery excludes rows whose IDs appear as children in `thread_spawn_edges`, matching ZCode's behavior of omitting subagent sessions from the ordinary session list.

Explicit task IDs may still load child tasks. This preserves ZCode's model: top-level sessions are discoverable by default, while subagents remain publishable when deliberately selected.

`resolveCurrent()` uses `CODEX_THREAD_ID` when present. If the variable names a missing task, resolution fails rather than silently publishing a different task. When no current-task signal exists, resolution falls back to the newest top-level Codex task. `CODEX_SESSION_ID` may be accepted as a compatibility alias only if inspection during implementation confirms it identifies the same task.

### Transcript source

The task row's `rollout_path` JSONL is the canonical transcript source. The adapter streams it rather than loading the full file into memory. `thread_history_1.sqlite` is not used because it is derived projection state and adds schema coupling without improving the required behavior.

The adapter normalizes Codex rollout events into the existing `ShapedSession` contract. All previewing, chunking, uploading, server-side redaction, storage, and rendering remain harness-agnostic.

### Native Codex skill

The existing `plugin/` package gains:

```text
plugin/
  .codex-plugin/plugin.json
  skills/share/SKILL.md
```

The Codex manifest points to the skill directory. The skill infers password, expiry, and redaction flags using the same rules as the existing `/share` command, then runs:

```text
quire publish --current --harness codex <inferred flags> --yes
```

It always supplies `--harness codex` so another installed harness store cannot win auto-detection. It always supplies `--yes` so an agent never blocks on an interactive confirmation. The existing Claude Code/ZCode slash command remains intact.

## Transcript shaping

The adapter preserves rollout order and maps only user-visible conversation content:

| Codex rollout item | Quire result |
|---|---|
| `response_item` message with role `user` and `input_text` | user text part |
| `response_item` message with role `assistant` and `output_text` | assistant text part |
| assistant message phase `commentary` or `final` | retained in rollout order |
| `function_call` or `custom_tool_call` | assistant tool part |
| matching call output with the same `call_id` | output on the tool part |
| reasoning summary text | assistant reasoning part |
| encrypted reasoning payload | omitted |

Developer messages, world state, turn context, compaction payloads, telemetry/event messages, inter-agent metadata, `agent_message` items, and other internal coordination records are omitted.

Tool inputs and outputs reuse Quire's existing truncation limits. The session-wide message and image budgets also apply. Embedded data images and readable local-image references may be included within those budgets; the adapter never fetches remote images.

Malformed JSONL lines are skipped. Missing or unreadable state databases and rollout files produce clear Codex-specific errors. Reaching a shaping cap emits one warning, consistent with the existing adapters.

## Harness detection and CLI

`codex` is added to `HarnessName`, `HarnessAdapter.name`, CLI validation, and help text.

Detection order is:

1. an explicit `--harness` value;
2. a Codex current-task environment signal;
3. existing Claude Code or ZCode environment signals; and
4. the most recently updated available harness store.

The last step compares store/task recency, preserving the current behavior when more than one harness is installed. Error messages list all three accepted harness names.

## Testing

CLI tests use synthetic, byte-stable fixtures with fixed timestamps:

- a Codex state database containing top-level and child tasks;
- rollout JSONL covering user and assistant text, commentary/final phases, reasoning summaries, both tool-call encodings, matching outputs, and ignored internal records;
- discovery ordering and top-level filtering;
- explicit child-task loading;
- exact current-task resolution and missing-current-task failure;
- malformed lines, missing rollouts, and shaping caps;
- Codex detection precedence and recency fallback; and
- publish/help validation for `--harness codex`.

Plugin tests validate the Codex manifest and `$share` skill, including `--current`, `--harness codex`, `--yes`, safe handling of free-text arguments, and the hard prohibition on unredacted sharing.

Relevant verification comprises CLI and plugin unit tests, their typechecks, and rebuilt CLI/plugin artifacts where applicable. Because the normalized wire contract is unchanged, server, web, and full-stack behavior require no new implementation, though the repository's full green gate remains the completion bar before pushing.

## Documentation

Update the root README and plugin README to describe:

- Codex desktop and CLI support;
- `quire publish --current --harness codex`;
- installation and invocation of `$share`;
- normal top-level discovery and explicit subagent publishing; and
- the unchanged server-side redaction boundary.

## Security and compatibility invariants

- The Codex adapter shapes content but never redacts it locally.
- Only server-redacted content is persisted or served.
- Codex state and rollout files are opened read-only.
- Internal developer instructions and agent-to-agent traffic are never published.
- No remote content is fetched while shaping a task.
- No raw task title or transcript content is added to CLI diagnostics.
- Existing ZCode and Claude Code behavior remains unchanged.
