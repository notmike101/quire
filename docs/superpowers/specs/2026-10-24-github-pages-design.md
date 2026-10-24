# Quire project website

The requested deliverable is a public-facing product website deployable to GitHub
Pages. It should help developers understand Quire, see the reading experience,
and reach the existing setup and integration guides.

## Approach

Use a standalone static site in `site/`, with HTML, CSS, native disclosures, and
existing synthetic product screenshots. This is the implementation choice for
the user's open-ended brief. Reusing the Vue viewer would couple marketing to
share routing and server assumptions. A documentation framework would add a
dependency and content migration without helping this small landing page.

References: omp.sh for a concise headline and command-led entry, opencode.ai for
feature-to-FAQ progression, and zed.dev for showing the product in context.
Use original copy and a warm paper, dark ink, and rust accent visual direction.

## Content and behavior

Lead with sharing the context behind code. Show a clearly labeled illustrative
conversation, supported harnesses, actual viewer screenshots, controls, a
three-step setup path, and FAQ. Link to the canonical repository documentation.
Explain self-hosting, redaction limits, and ingestion trust accurately. Do not
invent adoption numbers, testimonials, public package availability, or a hosted
service. Native details elements provide progressive disclosure without JS.

## Delivery and boundaries

Package only the site files and the two synthetic screenshots into `site/dist`.
Use relative asset paths so the `/quire/` project path works. GitHub Actions
deploys this directory on relevant main pushes or manual dispatch from main.
GitHub Pages hosts the project website, not the Quire server or shared sessions.
No application code, dependencies, or lockfile changes are needed.

Check packaging, links/assets, keyboard interaction, and desktop/mobile layout.
The user asked not to focus on tests; do not run the unrelated full-stack suite.
