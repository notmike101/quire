# GitHub Pages implementation plan

**Goal:** Deliver a polished Quire product site and a repeatable Pages deployment.
**Architecture:** Buildless HTML/CSS, packaged by a dependency-free Node script.
**Spec:** `docs/superpowers/specs/2026-10-24-github-pages-design.md`.

## Tasks

- [x] Create `site/index.html`, `site/styles.css`, and `site/favicon.svg` with
  semantic navigation, product examples, integration links, setup, and FAQ.
- [x] Add `scripts/build-site.mjs` and `build:site` in the root package, copying
  only named public assets to the ignored `site/dist` directory.
- [x] Add `.github/workflows/pages.yml` with main-only deployment, scoped
  permissions, concurrency, and the GitHub Pages environment.
- [x] Document local preview and activation in `docs/technical/website.md`;
  link it from the technical index and record the new workflow in AGENTS.md.
- [x] Package and inspect in a browser at desktop and mobile sizes, checking
  asset loading, anchor destinations, disclosure behavior, and overflow.
- [x] Enable Pages if the repository App permits it. Report source readiness
  separately from a live deployment; preserve repository review requirements.

## Verification and handoff

Packaging and focused ESLint passed. A synthetic unexpected output file was
rejected by the packaging guard and removed. Browser checks at 1440 and 375
pixels found no page overflow; both screenshots loaded, internal anchors
resolved, and native conversation/FAQ disclosures worked, including Enter on
the FAQ summary. Independent source review had no remaining actionable findings.
Application tests were skipped as requested for this website-only change.

The owner enabled GitHub Actions as the Pages source after the contribution
App could not enable it. A fresh fetch confirmed that the preceding work is
already in `main`. Delivery uses `codex/github-pages-site` and a website-only
pull request. The repository requires an approving review of the latest push
before merging; the Pages workflow deploys after merge. The unrelated
untracked `.omp/` directory was untouched.

## Review focus

Project-subpath assets; readable narrow screens; keyboard focus; accurate
security and installation claims; artifact excludes repository/session data.
