# Project website (GitHub Pages)

The product landing page lives in `site/`. It is separate from the Vue share
viewer and the application server. GitHub Pages cannot run Quire's API or
Postgres database.

## Edit and preview

Edit `site/index.html` and `site/styles.css`. The page uses system fonts, native
HTML disclosures, and a small theme script, with no external runtime dependencies. The theme follows
the system color scheme by default. The header's sun/moon switch toggles light
and dark; explicit choices persist in local storage between visits.

From the repository root:

```sh
node scripts/build-site.mjs
```

Or use `pnpm build:site` with the repository's pinned pnpm. The packager copies
the four site files and the two synthetic screenshots in `docs/images/` into
`site/dist/`. Unexpected leftover files cause packaging to fail; inspect and
remove those files before trying again. Do not add private session data there.

Serve `site/dist/` using a static HTTP server, for example:

```sh
python -m http.server 8793 --bind 127.0.0.1 --directory site/dist
```

On Windows, use `py -3` instead of `python` if needed. Open
`http://127.0.0.1:8793`. Re-run packaging after editing. Relative asset paths work
at both the domain root and a GitHub Pages project path such as `/quire/`.

## Enable and deploy

1. In the repository's **Settings → Pages → Build and deployment**, set
   **Source** to **GitHub Actions**. An account with repository administration
   access may be needed.
2. Merge the website change into `main` through the repository's normal process.
3. The **Deploy project website** workflow publishes `site/dist/` on changes to
   the site, packager, screenshots, or workflow. It can also be run manually
   from `main`. Other branches cannot deploy through this workflow.
4. Check the workflow's deployment URL. Without a custom domain, the expected
   URL for this repository is `https://notmike101.github.io/quire/`.

The workflow uses the `github-pages` environment with `contents: read`,
`pages: write`, and `id-token: write`. It installs no project dependencies and
does not run the application test stack. Only the six public website files
are uploaded. See [GitHub's custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

No custom domain is configured. Documentation links point to the canonical
files on GitHub, so edits to those guides do not require copying their content
into the website.
