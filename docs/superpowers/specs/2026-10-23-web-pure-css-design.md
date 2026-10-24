# Web pure-CSS migration design

**Date:** 2026-10-23 · **Status:** approved by owner in session
**Goal:** Remove Tailwind (`tailwindcss` + `@tailwindcss/vite`) from `web/` and restyle the
viewer with hand-written CSS only — Vue component scoped styles where possible, global
styles where patterns are shared — with zero visual change for readers.

## 1. Why / what exists today

- `web/src/style.css` starts with `@import "tailwindcss"` + an `@theme` block, then already
  contains hand-written globals (shiki dual-theme, `.prose-quire`, `.image-part-img`,
  the rail cluster, `msg-*`, the ≤640px rail media query). Those survive untouched.
- All other styling is Tailwind utilities in templates: 15 components, 166 distinct
  utility tokens, no `<style>` block anywhere. Only `dark:`, `hover:`, `group-hover:` and
  `[]` arbitrary values are used — no responsive utilities.
- Tests (unit + e2e) couple only to semantic classes: `active`, `is-overflowing`,
  `msg-target`, `msg-flash`, `rail-tick`, `rail-col`, `rail-tip`, `rail-dash` and the
  unstyled hook classes `tool-group`, `image-part`. None of them is a utility; all stay.
- `MessageRail.vue` and the server/CLI have no Tailwind usage.

## 2. Approach (owner-approved: semantic scoped rewrite)

Every component gets a `<style scoped>` block with meaningful class names
(`tool-card`, `page-card`, `user-bubble`, …). Declarations are **transcribed from the
current built CSS** (`web/dist/assets/index-*.css`, 19.9 KB), not from Tailwind docs —
the built file contains exactly what readers currently receive: Preflight, the OKLCH
theme tokens, and the generated rules (incl. `@supports color-mix` alpha fallbacks and
the `@media (hover: hover)` guards) for the utilities in use.

### Kept / dropped from the Tailwind output

- **Transcribed verbatim:** the Preflight base layer (the reset every layout depends on),
  the `@media (hover: hover)` wrappers around hover rules, the hex fallback +
  `@supports (color: color-mix(in lab, red, red))` pattern for alpha colors,
  the OKLCH palette values, the two font stacks.
- **Dropped:** `@layer` machinery, `@property --tw-*` registrations and the
  `@layer properties` fallback block (nothing in the new CSS references `--tw-*`), the
  `var(--tw-leading)`/`var(--tw-font-weight)` indirection (flattened to plain
  `line-height`/`font-weight`; source order fixes the two known conflicts:
  `.text-sm`+`.leading-relaxed` → 1.625; `.break-words`+`[overflow-wrap:anywhere]` →
  `break-word`), and scanner-noise utilities that no template uses (`.visible`,
  `.fixed`, `.table`, `.grow`, `.resize`, `.truncate`, `.filter`, `.transition`).
- `space-y-2` (which sets `--tw-space-y-reverse`) flattens to
  `:not(:last-child) { margin-block-end: .5rem }` — no other rule sets those margins.

### Global vs scoped split

- `style.css`: tokens (`--font-sans`, `--font-mono`, the used `--color-*` values), the
  Preflight transcription (first in the file so everything later overrides), and the
  shared full-page card shell (`.page-wrap`, `.page-card`, `.page-title`, `.page-sub`)
  used by PasswordGate/Expired/NotFound/Error. Everything else is component-scoped.
- Scoped blocks use `@media (prefers-color-scheme: dark)` for what were `dark:` variants,
  `:hover` inside `@media (hover: hover)` for `hover:`/`dark:hover:`, and parent
  `:hover .copy-btn` for the `group`/`group-hover:` pattern.
- Conditional `:class` bindings keep behavior: ToolCard `failed` and ToolGroup `failed`
  become modifier classes; rail `active` is untouched.

## 3. Invariants

1. **Pixels:** every captured surface is byte-identical before/after (see §4), and the
   per-element computed-style diff is empty in light and dark.
2. **Test contracts:** §1's semantic classes and DOM structure are unchanged.
3. **No dependency or config remnants:** `tailwindcss`, `@tailwindcss/vite`, the vite
   plugin, and doc mentions are all removed in the cutover.

## 4. Verification (throwaway harness, never committed)

Matrix over `http://127.0.0.1:8790` (the e2e compose stack, whose helpers publish
byte-stable v2 sealed fixtures — fixed epoch timestamps, no `Date.now()`):

| surface | how |
|---|---|
| transcript (title, meta chips, redacted badge, user/assistant bubbles) | `createV2Share(smallSession(6, secret))` |
| long share: rail ticks + active tick + hover tooltip + scrolled pagination tail | `createV2LongShare(40)`, scroll + tick click + hover |
| tool group: collapsed/expanded, failing card + Failed badge + failure strip, inline tool image | custom fixture: 3 tool parts (one `status:'error'`, one with images) |
| CodeBlock incl. shiki block + hover Copy button | long share code fence, hover |
| system notice + reasoning: collapsed and expanded | `systemNoticeSession`, `reasoningSession`, clicks |
| embedded image + image placeholder | `imageSession`, oversized-attachment fixture |
| password gate: empty / filled / wrong-password error | `createV2Share({password})`, wrong submit |
| expired / not-found / error page / loading skeleton | near-future `expiresAt` + wait; bogus id; `page.route` 500; `page.route` delay |

Each surface × **light + dark** (`colorScheme`) × **1280×900** (+ **390×844** for
transcript/long/gate) yields a full-page or viewport PNG **and** a computed-style dump of
every element keyed by DOM path (class-free, since class names are what change).
Animations are paused at `currentTime = 0` before capture; transitions/hover settle with
fixed waits. Baselines are captured from the current build **before** any source edit;
after migration the same script recaptures and diffs (pixel diff zero; style diff empty).

Finally the standard green gate (lint, typecheck, all unit, builds, Docker e2e).

## 5. Delivery

Branch `refactor/web-pure-css` off `main`; conventional commits per package
(`refactor(web): …`); spec + this plan committed under `docs/superpowers/`; PR against
`main` requesting the owner's review. No server, CLI, plugin, protocol, or test changes.
