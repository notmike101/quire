# Web pure-CSS migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Tailwind from `web/` and restyle the viewer with hand-written CSS (component-scoped + shared globals), pixel-identical to today.

**Architecture:** All CSS declarations are transcribed from the built CSS (`web/dist/assets/index-*.css`) — the exact bytes readers receive today: Preflight reset, OKLCH theme tokens, and the generated utility rules including `@supports color-mix` alpha fallbacks and `@media (hover: hover)` guards. Utilities become semantic classes: single-user patterns go into each component's `<style scoped>`; the four full-page card states share global `.page-*` classes. Tailwind's `--tw-*` machinery, `@layer`s, and `@property` registrations are dropped — nothing in the new CSS reads them.

**Tech Stack:** Vue 3 SFC scoped styles, plain CSS, Vite (plugin removed), Playwright (throwaway capture harness only).

**Spec:** `docs/superpowers/specs/2026-10-23-web-pure-css-design.md`

## Global Constraints

- Zero visual change: final proof is the pixel + computed-style diff of Task 8 (spec §4). Never "improve" a value; copy it from this plan.
- These class names are load-bearing (JS/unit/e2e coupling) and MUST stay byte-identical: `rail-col rail-cluster rail-tick rail-dash rail-tip rail-tip-n active is-overflowing msg-target msg-flash prose-quire image-part image-part-img shiki tool-group`. `MessageRail.vue` is NEVER touched.
- `docs/superpowers/plans/2026-10-23-web-pure-css.md` and the spec are committed with the work. Commit style: `refactor(web): …`.
- The capture harness lives under `.superpowers/scratch/` (untracked) and is never committed.
- After each editing task: `pnpm --filter @quire/web test` (expect 155 passed) and `pnpm --filter @quire/web build` (expect success). The repo checks out CRLF; use the edit tool, and if it rejects a CRLF file, patch with a Node `readFileSync`/`indexOf` (found+unique assertions)/`writeFileSync` script that preserves `\r\n`.

### Token reference (verbatim from the built `@layer theme` block)

These exact custom-property definitions go into `style.css` (`:root`); component CSS references them:

```css
--font-sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
--font-mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
--color-red-50: oklch(97.1% .013 17.38);
--color-red-100: oklch(93.6% .032 17.717);
--color-red-200: oklch(88.5% .062 18.334);
--color-red-300: oklch(80.8% .114 19.571);
--color-red-400: oklch(70.4% .191 22.216);
--color-red-600: oklch(57.7% .245 27.325);
--color-red-800: oklch(44.4% .177 26.899);
--color-red-900: oklch(39.6% .141 25.723);
--color-red-950: oklch(25.8% .092 26.042);
--color-amber-100: oklch(96.2% .059 95.617);
--color-amber-300: oklch(87.9% .169 91.605);
--color-amber-400: oklch(82.8% .189 84.429);
--color-amber-600: oklch(66.6% .179 58.318);
--color-amber-700: oklch(55.5% .163 48.998);
--color-amber-900: oklch(41.4% .112 45.904);
--color-neutral-50: oklch(98.5% 0 none);
--color-neutral-100: oklch(97% 0 none);
--color-neutral-200: oklch(92.2% 0 none);
--color-neutral-300: oklch(87% 0 none);
--color-neutral-400: oklch(70.8% 0 none);
--color-neutral-500: oklch(55.6% 0 none);
--color-neutral-600: oklch(43.9% 0 none);
--color-neutral-700: oklch(37.1% 0 none);
--color-neutral-800: oklch(26.9% 0 none);
--color-neutral-900: oklch(20.5% 0 none);
--color-neutral-950: oklch(14.5% 0 none);
--color-white: #fff;
```

Alpha backgrounds always keep the pre-`color-mix` hex fallback + the `@supports` override, exactly as Tailwind emitted them:

| utility | fallback | override |
|---|---|---|
| `bg-red-50/70` | `#fef2f2b3` | `color-mix(in oklab, var(--color-red-50) 70%, transparent)` |
| `bg-amber-900/40` (dark) | `#7b330666` | `color-mix(in oklab, var(--color-amber-900) 40%, transparent)` |
| `bg-neutral-900/40` (dark) | `#17171766` | `color-mix(in oklab, var(--color-neutral-900) 40%, transparent)` |
| `bg-red-900/60` (dark) | `#82181a99` | `color-mix(in oklab, var(--color-red-900) 60%, transparent)` |
| `bg-red-950/30` (dark) | `#4608094d` | `color-mix(in oklab, var(--color-red-950) 30%, transparent)` |
| `bg-red-950/40` (dark) | `#46080966` | `color-mix(in oklab, var(--color-red-950) 40%, transparent)` |

`@supports` guard verbatim: `@supports (color: color-mix(in lab, red, red)) { … }`.

Text utilities flatten to `font-size` + the unitless line-height: `text-xs` `.75rem`/`calc(1 / .75)`, `text-sm` `.875rem`/`calc(1.25 / .875)`, `text-lg` `1.125rem`/`calc(1.75 / 1.125)`, `text-xl` `1.25rem`/`calc(1.75 / 1.25)`. `leading-relaxed` = `1.625`. Two known Tailwind conflicts resolve this way (do not "fix"): `text-sm`+`leading-relaxed` → line-height `1.625`; `break-words`+`[overflow-wrap:anywhere]` → `overflow-wrap: break-word` (named utility came later in the utilities layer). Radii: `rounded` `.25rem`, `rounded-md` `.375rem`, `rounded-lg` `.5rem`, `rounded-xl` `.75rem`, `rounded-2xl` `1rem`, `rounded-full` `2147483647px`. Spacing base `.25rem` (`px-4` → `1rem` etc.). Hover rules MUST sit inside `@media (hover: hover)`; `dark:` → `@media (prefers-color-scheme: dark)`.

Never transcribe (scanner noise, no template uses them): `.visible .fixed .table .grow .resize .truncate .filter .transition`.

---

### Task 1: Capture harness + baselines (throwaway)

**Files:**
- Create: `.superpowers/scratch/capture.spec.ts` (copied into `e2e/test/` only while running)
- Output dir: `.superpowers/scratch/capture/baseline/`

**Interfaces:**
- Produces: `baseline/<name>.png` + `baseline/<name>.styles.json` per surface×scheme×viewport; Task 8 re-runs the identical script against the migrated build and diffs.

- [ ] **Step 1: Bring up the e2e stack.** `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build` (port 8790). The compose stack has its own Postgres; the `:54329` test DB is not involved.
- [ ] **Step 2: Write the harness** as a Playwright spec that imports `./helpers` (createV2Share, createV2LongShare, smallSession, systemNoticeSession, reasoningSession, imageSession, TINY_PNG_DATA_URI). One test per capture below; per capture: `goto`, wait for the known anchor locator (copy the waiting patterns from `sealed-share.spec.ts`), settle interactions, freeze animations, capture:

```ts
async function snap(page: Page, name: string, fullPage: boolean) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 0; } catch { /* ended */ } }
  });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  const styles = await page.evaluate(() => {
    const walk = (el: Element, path: string, out: object[]) => {
      const cs = getComputedStyle(el);
      const props: Record<string, string> = {};
      for (const p of Array.from(cs)) props[p] = cs.getPropertyValue(p);
      out.push({ path, props });
      let i = 0;
      for (const child of el.children) walk(child, `${path}>${child.tagName.toLowerCase()}[${i++}]`, out);
    };
    const out: object[] = [];
    walk(document.documentElement, 'html', out);
    return out;
  });
  writeFileSync(`${OUT}/${name}.styles.json`, JSON.stringify(styles)); // import { writeFileSync } from 'node:fs' at the top of the spec
}
```

4. `share-tools` — custom session, one assistant message, parts:
```ts
[
  { type: 'text', text: 'Run the migration and summarize.\n\n```ts\nconst x = 1;\nconsole.log(x);\n```' },
  { type: 'tool', tool: 'Read', status: 'completed', input: { file_path: 'D:\\quire\\README.md' }, output: 'file contents here\nline two\nline three' },
  { type: 'tool', tool: 'Bash', status: 'completed', input: { command: 'pnpm build && pnpm test' }, output: 'ok' },
  { type: 'tool', tool: 'Edit', status: 'failed', input: { path: 'D:\\quire\\web\\src\\App.vue', old_string: 'x'.repeat(80) }, output: 'Error: old_string not found in file after 3 attempts' },
  { type: 'tool', tool: 'Read', status: 'completed', input: { file_path: '/tmp/example.png' }, output: '[Attached image/png: Read image]', images: [{ src: TINY_PNG_DATA_URI, mime: 'image/png', alt: 'Read image', bytes: 70 }] },
]
```
Wait for `.tool-group`; full-page → `share-tools-collapsed`; click group toggle, click the failed card, wait 200 ms → `share-tools-expanded` full-page; hover the CodeBlock copy button → `share-tools-copy` viewport shot.
5. `share-notice` — `systemNoticeSession()`; full-page → click chip → `share-notice-open` full-page.
6. `share-reasoning` — `reasoningSession()`; full-page → click "thinking…" → `share-reasoning-open` full-page.
7. `share-image` — `imageSession()`; full-page.
8. `gate` — `createV2Share(request, { session: smallSession(2), password: 'correct-horse' })`; gate shot; `fill('wrong')`, click Unlock, wait "Wrong password." → `gate-error` (filled input + error).
9. `expired` — `createV2Share(request, { expiresAt: new Date(Date.now() + 10_000).toISOString() })`; wait 12 s; goto; wait "This share has expired" → shot.
10. `notfound` — goto `/chats/000000000000000000000000` (no fragment) → shot.
11. `error` — page.route on `/api/**` → fulfil 500 `{error:{code:'server_error',message:'x'}}` over a working share URL → wait "Something went wrong" → shot.
12. `skeleton` — page.route on the v2 public endpoints → 30 s delay; goto, wait for `[aria-busy="true"]`, immediate shot (skeleton is animation-frozen at currentTime 0).
13. `@390`: `share-main@390`, `share-long@390` (scrolled variant too), `gate@390`.
- [ ] **Step 3:** Copy the spec to `e2e/test/capture.spec.ts`, `OUT` env → `.superpowers/scratch/capture/baseline`, run `pnpm --filter @quire/e2e exec playwright test capture.spec.ts` with `workers: 1` (config already serial). Remove the spec from `e2e/test/` afterwards.
- [ ] **Step 4:** Verify every expected file exists; keep the stack up for Task 8.

---

### Task 2: Global CSS + App.vue

**Files:**
- Modify: `web/src/style.css` (replace lines 1–26: `@import`, comments, `html/body` block, `@theme`; rest of the file untouched)
- Modify: `web/src/App.vue` (template class attributes + new `<style scoped>`)

- [ ] **Step 1: style.css head.** Replace everything from line 1 through the closing `}` of `@theme` with (then keep the existing `html, body` dark block and everything after it byte-identical, and reword the comment above it to drop Tailwind class names):

```css
/* Design tokens: the custom properties Tailwind's @theme used to emit; the
   names are preserved because the rules below reference them. */
:root {
  /* token block from the Token reference above, verbatim */
}

/* Reset: transcribed from Tailwind v4.3.3 Preflight, kept first in the file so
   every rule below overrides it. Dropped on purpose: the @layer plumbing, the
   @property --tw-* registrations and their fallback block — nothing here reads
   --tw-* variables any more. */
*,
*::before,
*::after,
::backdrop {
  box-sizing: border-box;
  border: 0 solid;
  margin: 0;
  padding: 0;
}
::file-selector-button {
  box-sizing: border-box;
  border: 0 solid;
  margin: 0;
  padding: 0;
}
html {
  -webkit-text-size-adjust: 100%;
  tab-size: 4;
  line-height: 1.5;
  font-family: var(--font-sans);
  -webkit-tap-highlight-color: transparent;
}
hr {
  height: 0;
  color: inherit;
  border-top-width: 1px;
}
abbr:where([title]) {
  text-decoration: underline dotted;
}
h1,
h2,
h3,
h4,
h5,
h6 {
  font-size: inherit;
  font-weight: inherit;
}
a {
  color: inherit;
  text-decoration: inherit;
}
b,
strong {
  font-weight: bolder;
}
code,
kbd,
samp,
pre {
  font-family: var(--font-mono);
  font-size: 1em;
}
small {
  font-size: 80%;
}
sub,
sup {
  vertical-align: baseline;
  font-size: 75%;
  line-height: 0;
  position: relative;
}
sub {
  bottom: -0.25em;
}
sup {
  top: -0.5em;
}
table {
  text-indent: 0;
  border-color: inherit;
  border-collapse: collapse;
}
::-moz-focusring:where(:not(iframe)) {
  outline: auto;
}
progress {
  vertical-align: baseline;
}
summary {
  display: list-item;
}
ol,
ul,
menu {
  list-style: none;
}
img,
svg,
video,
canvas,
audio,
iframe,
embed,
object {
  vertical-align: middle;
  display: block;
}
img,
video {
  max-width: 100%;
  height: auto;
}
button,
input,
select,
optgroup,
textarea {
  font: inherit;
  font-feature-settings: inherit;
  font-variation-settings: inherit;
  letter-spacing: inherit;
  color: inherit;
  opacity: 1;
  background-color: transparent;
  border-radius: 0;
}
::file-selector-button {
  font: inherit;
  font-feature-settings: inherit;
  font-variation-settings: inherit;
  letter-spacing: inherit;
  color: inherit;
  opacity: 1;
  background-color: transparent;
  border-radius: 0;
  margin-inline-end: 4px;
}
:where(select:is([multiple], [size])) optgroup {
  font-weight: bolder;
}
:where(select:is([multiple], [size])) optgroup option {
  padding-inline-start: 20px;
}
::placeholder {
  opacity: 1;
  color: currentColor;
}
@supports (color: color-mix(in lab, red, red)) {
  ::placeholder {
    color: color-mix(in oklab, currentColor 50%, transparent);
  }
}
textarea {
  resize: vertical;
}
::-webkit-search-decoration {
  -webkit-appearance: none;
}
::-webkit-date-and-time-value {
  min-height: 1lh;
  text-align: inherit;
}
::-webkit-datetime-edit {
  display: inline-flex;
  padding-block: 0;
}
::-webkit-datetime-edit-fields-wrapper {
  padding: 0;
}
::-webkit-datetime-edit-year-field,
::-webkit-datetime-edit-month-field,
::-webkit-datetime-edit-day-field,
::-webkit-datetime-edit-hour-field,
::-webkit-datetime-edit-minute-field,
::-webkit-datetime-edit-second-field,
::-webkit-datetime-edit-millisecond-field,
::-webkit-datetime-edit-meridiem-field {
  padding-block: 0;
}
::-webkit-calendar-picker-indicator {
  line-height: 1;
}
::-moz-ui-invalid {
  box-shadow: none;
}
button,
input:where([type="button"], [type="reset"], [type="submit"]) {
  appearance: button;
}
:-webkit-inner-spin-button,
:-webkit-outer-spin-button {
  height: auto;
}
[hidden]:where(:not([hidden="until-found"])) {
  display: none !important;
}

/* Card shell shared by the password gate and the full-page states
   (expired / not-found / error). */
.page-wrap {
  margin-inline: auto;
  margin-top: 6rem;
  width: 100%;
  max-width: 24rem;
  padding-inline: 1rem;
}
.page-card {
  border-radius: 0.75rem;
  border: 1px solid var(--color-neutral-200);
  padding: 1.5rem;
}
@media (prefers-color-scheme: dark) {
  .page-card {
    border-color: var(--color-neutral-800);
  }
}
.page-title {
  margin-bottom: 0.25rem;
  font-size: 1.125rem;
  line-height: calc(1.75 / 1.125);
  font-weight: 600;
}
.page-sub {
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .page-sub {
    color: var(--color-neutral-400);
  }
}
```

The surviving `html, body` background comment becomes:

```css
/* Paint html/body with the same theme-aware background as the root .app-shell
   so the browser canvas never shows through in the overscroll region or the
   top margin of the short full-page states (password gate, expired, not-found,
   error). Without this, dark-mode readers see a white band at the top: the
   root div is dark but body/html are transparent, so the UA default white
   canvas bleeds through. */
```

- [ ] **Step 2: App.vue template.** Replace utility class attributes in the template (lines 89–142):

```html
  <div class="app-shell">
    …state branches unchanged…
      <header class="share-header">
        <h1 class="share-title">{{ meta?.title ?? 'Shared session' }}</h1>
        <div class="share-meta">
          <span v-if="meta?.model" class="meta-chip">
            {{ meta.model }}
          </span>
          <span v-if="meta?.provider">{{ meta.provider }}</span>
          <span>{{ formatDate(meta?.createdAt ?? new Date().toISOString()) }}</span>
          <span v-if="meta?.expiresAt" class="meta-expires">
            expires {{ formatDate(meta.expiresAt) }}
          </span>
          <span
            v-if="Object.values(meta?.redactions ?? {}).reduce((a, b) => a + b, 0) > 0"
            class="meta-redacted"
          >{{ … }} redacted</span>
        </div>
      </header>
      <div class="content-wrap">
        <MessageRail … />
        <main class="msg-col">
          …msg-target branch unchanged…
        <div v-if="loadingMore" class="feed-note">Loading more…</div>
        <div v-else-if="messages.length === 0" class="feed-note feed-note-empty">
          This session has no shareable messages.
        </div>
        <div ref="sentinel" class="sentinel" />
        </main>
      </div>
```

- [ ] **Step 3: App.vue scoped styles.** Append after `</template>`:

```html
<style scoped>
.app-shell {
  min-height: 100vh;
  background-color: var(--color-white);
  color: var(--color-neutral-900);
}
@media (prefers-color-scheme: dark) {
  .app-shell {
    background-color: var(--color-neutral-950);
    color: var(--color-neutral-100);
  }
}
.share-header {
  margin-inline: auto;
  width: 100%;
  max-width: 760px;
  padding-inline: 1rem;
  padding-block-end: 1.5rem;
  padding-top: 2.5rem;
}
.share-title {
  font-size: 1.25rem;
  line-height: calc(1.75 / 1.25);
  font-weight: 600;
}
.share-meta {
  margin-top: 0.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .share-meta {
    color: var(--color-neutral-400);
  }
}
.meta-chip {
  border-radius: 2147483647px;
  border: 1px solid var(--color-neutral-200);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
}
@media (prefers-color-scheme: dark) {
  .meta-chip {
    border-color: var(--color-neutral-800);
  }
}
.meta-expires {
  color: var(--color-amber-600);
}
@media (prefers-color-scheme: dark) {
  .meta-expires {
    color: var(--color-amber-400);
  }
}
.meta-redacted {
  border-radius: 2147483647px;
  background-color: var(--color-amber-100);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  color: var(--color-amber-700);
}
@media (prefers-color-scheme: dark) {
  .meta-redacted {
    background-color: #7b330666;
    color: var(--color-amber-300);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .meta-redacted {
      background-color: color-mix(in oklab, var(--color-amber-900) 40%, transparent);
    }
  }
}
.content-wrap {
  margin-inline: auto;
  display: flex;
  width: 100%;
  max-width: 800px;
  align-items: stretch;
}
.msg-col {
  min-width: 0;
  flex: 1;
  padding-inline: 1rem;
  padding-bottom: 4rem;
}
.feed-note {
  padding-block: 1rem;
  text-align: center;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-neutral-400);
}
.feed-note-empty {
  padding-block: 4rem;
}
@media (prefers-color-scheme: dark) {
  .feed-note {
    color: var(--color-neutral-500);
  }
}
.sentinel {
  height: 0.25rem;
}
</style>
```

- [ ] **Step 4:** `pnpm --filter @quire/web test && pnpm --filter @quire/web build`. Commit: `refactor(web): add base reset, design tokens, and App scoped styles`.

---

### Task 3: Full-page states (Error/Expired/NotFound/PasswordGate)

**Files:** `web/src/components/ErrorPage.vue`, `ExpiredPage.vue`, `NotFoundPage.vue`, `PasswordGate.vue`

- [ ] **Step 1.** The three state pages become identical shells (only copy differs):

```html
<template>
  <div class="page-wrap">
    <div class="page-card">
      <h1 class="page-title">Something went wrong</h1>
      <p class="page-sub">{{ message }}</p>
    </div>
  </div>
</template>

<style scoped>
.page-card {
  text-align: center;
}
</style>
```

(ErrorPage keeps its `<script setup>` block.)
- [ ] **Step 2.** PasswordGate template: root `page-wrap`, form keeps `@submit.prevent` and gets `page-card`; h1 `page-title`; intro p `page-sub gate-intro`; input `gate-input`; error p `gate-error`; button `gate-submit`. Append:

```html
<style scoped>
.gate-intro {
  margin-bottom: 1rem;
}
.gate-input {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid var(--color-neutral-300);
  background-color: var(--color-white);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.gate-error {
  margin-top: 0.25rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-red-600);
}
.gate-submit {
  margin-top: 1rem;
  width: 100%;
  border-radius: 0.375rem;
  background-color: var(--color-neutral-900);
  padding-inline: 1rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  font-weight: 500;
  color: var(--color-white);
}
@media (hover: hover) {
  .gate-submit:hover {
    background-color: var(--color-neutral-700);
  }
}
@media (prefers-color-scheme: dark) {
  .gate-input {
    border-color: var(--color-neutral-700);
    background-color: var(--color-neutral-900);
  }
  .gate-error {
    color: var(--color-red-400);
  }
  .gate-submit {
    background-color: var(--color-neutral-100);
    color: var(--color-neutral-900);
  }
  @media (hover: hover) {
    .gate-submit:hover {
      background-color: var(--color-white);
    }
  }
}
</style>
```

- [ ] **Step 3:** test+build, commit `refactor(web): style password gate and state pages with scoped CSS`.

---

### Task 4: Message flow (UserMessage, AssistantMessage, SystemNotice, ReasoningBlock)

**Files:** the four `.vue` files above.

- [ ] **Step 1.** UserMessage template: root `user-messages`; text part `user-bubble`; system part wrapper `system-part`. Scoped:

```css
.user-messages {
  margin-block: 1rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
}
.user-bubble {
  max-width: 85%;
  white-space: pre-wrap;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
  padding-inline: 1rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.system-part {
  max-width: 85%;
  align-self: flex-end;
}
@media (prefers-color-scheme: dark) {
  .user-bubble {
    background-color: var(--color-neutral-800);
  }
}
```

- [ ] **Step 2.** AssistantMessage: root div gets `class="assistant-body"` (the `prose-quire` v-html div stays). Scoped:

```css
.assistant-body {
  margin-block: 1rem;
  font-size: 0.875rem;
  line-height: 1.625;
}
```

- [ ] **Step 3.** SystemNotice: root `sys-notice`; button `sys-toggle`; icon span `sys-icon`; label span `sys-label`; preview span `sys-preview`; body div `sys-body`. Scoped:

```css
.sys-notice {
  margin-block: 0.5rem;
}
.sys-toggle {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  text-align: left;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
@media (hover: hover) {
  .sys-toggle:hover {
    color: var(--color-neutral-700);
  }
}
.sys-icon {
  font-family: var(--font-mono);
}
.sys-label {
  display: block;
  font-weight: 500;
}
.sys-preview {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
}
.sys-body {
  margin-top: 0.375rem;
  white-space: pre-wrap;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  background-color: var(--color-neutral-50);
  padding: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.625;
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .sys-toggle {
    border-color: var(--color-neutral-800);
    color: var(--color-neutral-400);
  }
  @media (hover: hover) {
    .sys-toggle:hover {
      color: var(--color-neutral-200);
    }
  }
  .sys-body {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-400);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .sys-body {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
```

- [ ] **Step 4.** ReasoningBlock: root `reasoning`; button `reasoning-toggle`; span `reasoning-label`; body `reasoning-body`. Scoped:

```css
.reasoning {
  margin-block: 0.5rem;
}
.reasoning-toggle {
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-style: italic;
  color: var(--color-neutral-400);
}
.reasoning-label {
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-style: italic;
  color: var(--color-neutral-400);
}
@media (hover: hover) {
  .reasoning-toggle:hover {
    color: var(--color-neutral-500);
  }
}
.reasoning-body {
  margin-top: 0.25rem;
  white-space: pre-wrap;
  border-left: 2px solid var(--color-neutral-200);
  padding-left: 0.75rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .reasoning-toggle,
  .reasoning-label {
    color: var(--color-neutral-500);
  }
  .reasoning-body {
    border-color: var(--color-neutral-800);
    color: var(--color-neutral-400);
  }
}
```

(The `▾`/`▸` prefix stays inside the button/label text, unstyled.)
- [ ] **Step 5:** test+build, commit `refactor(web): style message flow with scoped CSS`.

---

### Task 5: LoadingSkeleton, CodeBlock, ImagePart

- [ ] **Step 1.** LoadingSkeleton: root `skeleton` (keep `aria-busy`); bars `sk-title`, `sk-sub`, `sk-msg-1`, `sk-msg-2`, `sk-msg-3`. Scoped:

```css
.skeleton {
  margin-inline: auto;
  width: 100%;
  max-width: 760px;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  padding-inline: 1rem;
  padding-top: 2.5rem;
}
.sk-title {
  height: 1.5rem;
  width: 66.6667%;
  border-radius: 0.25rem;
  background-color: var(--color-neutral-200);
}
.sk-sub {
  margin-top: 0.5rem;
  height: 1rem;
  width: 33.3333%;
  border-radius: 0.25rem;
  background-color: var(--color-neutral-200);
}
.sk-msg-1 {
  margin-top: 2.5rem;
  height: 4rem;
  width: 75%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
.sk-msg-2 {
  margin-top: 1rem;
  height: 6rem;
  width: 100%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
.sk-msg-3 {
  margin-top: 1rem;
  height: 4rem;
  width: 66.6667%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
@media (prefers-color-scheme: dark) {
  .sk-title,
  .sk-sub {
    background-color: var(--color-neutral-800);
  }
  .sk-msg-1,
  .sk-msg-2,
  .sk-msg-3 {
    background-color: var(--color-neutral-900);
  }
}
@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}
```

- [ ] **Step 2.** CodeBlock: root `code-block` (replaces `group relative`); `code-pre`; `copy-btn`. Scoped:

```css
.code-block {
  position: relative;
}
.code-pre {
  overflow-x: auto;
  border-radius: 0.375rem;
  background-color: var(--color-neutral-100);
  padding: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
}
.copy-btn {
  position: absolute;
  right: 0.5rem;
  top: 0.5rem;
  display: none;
  border-radius: 0.25rem;
  border: 1px solid var(--color-neutral-300);
  background-color: var(--color-white);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
}
@media (hover: hover) {
  .code-block:hover .copy-btn {
    display: block;
  }
}
@media (prefers-color-scheme: dark) {
  .code-pre {
    background-color: var(--color-neutral-900);
  }
  .copy-btn {
    border-color: var(--color-neutral-600);
    background-color: var(--color-neutral-800);
  }
}
```

- [ ] **Step 3.** ImagePart: root `image-block image-part` (keep the hook class); the `image-part-img` class stays; placeholder `image-placeholder`; note span `placeholder-note`. Scoped:

```css
.image-block {
  margin-block: 0.75rem;
}
.image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  background-color: var(--color-neutral-50);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-400);
}
.placeholder-note {
  font-style: italic;
}
@media (prefers-color-scheme: dark) {
  .image-placeholder {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-500);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .image-placeholder {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
```

- [ ] **Step 4:** test+build, commit `refactor(web): style skeleton, code blocks, and images with scoped CSS`.

---

### Task 6: ToolCard + ToolGroup

- [ ] **Step 1.** ToolCard template (lines 39–65) becomes:

```html
<template>
  <div class="tool-card" :class="{ failed }">
    <button class="tool-head" :aria-expanded="open" @click="open = !open">
      <span class="card-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="tool-summary">
        <span class="tool-name">{{ preview.title }}</span>
        <span class="tool-target">{{ part.tool ?? 'tool' }}<template v-if="preview.detail"> · {{ preview.detail }}</template></span>
        <span v-if="failed" class="tool-error">{{ toolErrorPreview(part) }}</span>
        <span v-if="part.images?.length" class="tool-image-count">{{ part.images.length }} image{{ part.images.length > 1 ? 's' : '' }}</span>
      </span>
      <span v-if="failed" class="failed-badge">Failed</span>
    </button>
    <div v-if="open" class="tool-body">
      <CodeBlock v-if="inputText(part)" :code="inputText(part)" />
      <CodeBlock v-if="part.output" :code="part.output" />
      <div v-if="part.images && part.images.length > 0" class="tool-images">
        <div v-for="(img, i) in part.images" :key="i" class="image-part">
          <img v-if="isSafeImageSrc(img.src)" :src="img.src" :alt="img.alt ?? 'image'" loading="lazy" class="image-part-img" />
          <div v-else class="image-placeholder">
            <span>📷</span>
            <span class="placeholder-note">image too large to embed{{ img.bytes ? ` (${fmtBytes(img.bytes)})` : '' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

Scoped styles:

```css
.tool-card {
  margin-block: 0.5rem;
  overflow: hidden;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.tool-card.failed {
  border-color: var(--color-red-300);
  background-color: #fef2f2b3;
}
@supports (color: color-mix(in lab, red, red)) {
  .tool-card.failed {
    background-color: color-mix(in oklab, var(--color-red-50) 70%, transparent);
  }
}
.tool-head {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  text-align: left;
}
.card-caret {
  padding-top: 0.125rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.tool-summary {
  min-width: 0;
  flex: 1;
}
.tool-name {
  display: block;
  overflow-wrap: break-word;
  font-weight: 500;
}
.tool-target {
  margin-top: 0.125rem;
  display: block;
  word-break: break-all;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.tool-error {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-red-800);
}
.tool-image-count {
  margin-top: 0.25rem;
  display: block;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.failed-badge {
  flex-shrink: 0;
  border-radius: 2147483647px;
  background-color: var(--color-red-100);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-weight: 500;
  color: var(--color-red-800);
}
.tool-body {
  border-top: 1px solid var(--color-neutral-200);
  padding: 0.75rem;
}
.tool-body > :not(:last-child) {
  margin-block-end: 0.5rem;
}
.tool-images {
  padding-top: 0.25rem;
}
.tool-images > :not(:last-child) {
  margin-block-end: 0.5rem;
}
.image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  background-color: var(--color-neutral-50);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.placeholder-note {
  font-style: italic;
}
@media (prefers-color-scheme: dark) {
  .tool-card {
    border-color: var(--color-neutral-800);
  }
  .tool-card.failed {
    border-color: var(--color-red-800);
    background-color: #4608094d;
  }
  @supports (color: color-mix(in lab, red, red)) {
    .tool-card.failed {
      background-color: color-mix(in oklab, var(--color-red-950) 30%, transparent);
    }
  }
  .card-caret,
  .tool-target,
  .tool-image-count {
    color: var(--color-neutral-400);
  }
  .tool-error {
    color: var(--color-red-200);
  }
  .failed-badge {
    background-color: #82181a99;
    color: var(--color-red-200);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .failed-badge {
      background-color: color-mix(in oklab, var(--color-red-900) 60%, transparent);
    }
  }
  .tool-body {
    border-color: var(--color-neutral-800);
  }
  .image-placeholder {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-400);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .image-placeholder {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
```

- [ ] **Step 2.** ToolGroup template: root keeps the `tool-group` class and becomes `<div v-else class="tool-group" :class="{ failed: failures.length }">`; button `group-toggle`; row span `group-row`; caret `group-caret`; summary span `group-summary`; title span `group-title`; targets span `group-targets`; failure strip `group-failures`; failure text span `failure-note`; body `group-body`. Scoped:

```css
.tool-group {
  margin-block: 0.75rem;
  overflow: hidden;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.tool-group.failed {
  border-color: var(--color-red-300);
}
.group-toggle {
  display: block;
  width: 100%;
  text-align: left;
}
.group-row {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 0.5rem;
  padding-inline: 0.75rem;
  padding-block: 0.625rem;
}
.group-caret {
  padding-top: 0.125rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.group-summary {
  min-width: 0;
  flex: 1;
}
.group-title {
  display: block;
  overflow-wrap: break-word;
  font-weight: 500;
}
.group-targets {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.group-failures {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border-top: 1px solid var(--color-red-200);
  background-color: var(--color-red-50);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-red-800);
}
.failure-note {
  min-width: 0;
  overflow-wrap: break-word;
}
.group-body {
  border-top: 1px solid var(--color-neutral-200);
  padding-inline: 0.75rem;
  padding-block: 0.25rem;
}
@media (prefers-color-scheme: dark) {
  .tool-group {
    border-color: var(--color-neutral-800);
  }
  .tool-group.failed {
    border-color: var(--color-red-900);
  }
  .group-targets {
    color: var(--color-neutral-400);
  }
  .group-failures {
    border-color: var(--color-red-900);
    background-color: #46080966;
    color: var(--color-red-200);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .group-failures {
      background-color: color-mix(in oklab, var(--color-red-950) 40%, transparent);
    }
  }
  .group-body {
    border-color: var(--color-neutral-800);
  }
}
```

(`.group-caret` intentionally has NO dark rule — the original utility set had no `dark:` variant on it; it stays `neutral-500` in dark mode.)
- [ ] **Step 3:** test+build, commit `refactor(web): style tool cards and groups with scoped CSS`.

---

### Task 7: Cutover — remove Tailwind

**Files:** `web/vite.config.ts`, `web/package.json`, `pnpm-lock.yaml`, docs mentioning Tailwind.

- [ ] **Step 0: residual-utility sweep.** `grep -oE 'class="[^"]*"' web/src/App.vue web/src/components/*.vue | grep -oE '(dark:|hover:|group-hover:|max-w-\[|min-h-|rounded-|text-(xs|sm|lg|xl)|bg-|border-|flex-|items-|gap-)' ` → must print nothing (semantic names contain none of these fragments).
- [ ] **Step 1.** `web/vite.config.ts`: delete the `tailwindcss` import and the plugin entry → `plugins: [vue()]`.
- [ ] **Step 2.** `web/package.json`: remove `"@tailwindcss/vite"` and `"tailwindcss"` from devDependencies. Run `pnpm install` at the repo root (updates the lockfile; expect only removals).
- [ ] **Step 3.** Docs sweep: `grep -rin tailwind README.md AGENTS.md docs/ web/` — update prose (e.g. AGENTS.md "Vue 3 + Vite + Tailwind v4 read-only viewer" → "Vue 3 + Vite + vanilla scoped CSS read-only viewer"). `docs/superpowers/` historical specs/plans: do not rewrite history.
- [ ] **Step 4:** `pnpm --filter @quire/web test && pnpm --filter @quire/web build`. Commit: `refactor(web)!: drop tailwindcss dependency and vite plugin`.

---

### Task 8: Visual verification — zero diff

- [ ] **Step 1.** Stack from Task 1 is up (bring it back if not; the migrated `web/dist` must be rebuilt and the stack's web image rebuilt with it: same compose build). Re-run the capture spec with `OUT=.superpowers/scratch/capture/after`.
- [ ] **Step 2.** Diff: PNG files must be pixel-identical (zero changed pixels); styles.json must diff to zero property changes (paths use tag+index only, so `data-v-*` changes never affect them). Known-acceptable exceptions MUST be individually explained (e.g. expired-share timestamp text). Investigate any diff by comparing before/after CSS rules, not by adjusting the harness.
- [ ] **Step 3.** Full green gate (AGENTS.md §2): `pnpm lint`, `pnpm typecheck`, the four package test suites (server needs `:54329` db: probe the port first; it usually persists), three builds, `pnpm --filter @quire/e2e test`.
- [ ] **Step 4.** Tear down the capture stack (`docker compose … down`); keep `.superpowers/` scratch untracked.

---

### Task 9: PR

- [ ] Push `refactor/web-pure-css` via the gh HTTPS credential flow (SSH agent is broken on this box), open PR against `main` with spec + plan links, body: before/after evidence (zero-diff table, gate output), then `gh pr edit --add-reviewer notmike101`.
