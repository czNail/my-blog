# Shared site appearance

- Canonical source: `czNail/cznail.github.io`, `packages/site-ui`. `vendor/site-ui` is generated and checksum verified; never edit it directly.
- Update with `node scripts/sync-site-ui.mjs --update`. The pinned revision and hashes live in `site-ui.lock.json`; scheduled update workflows submit an upgrade PR.
- Use shared tokens, header, footer, logo and theme runtime. Do not redefine `--site-*` or add a second global theme preference. Map legacy variables to the shared tokens. Keep business layout local.
- Run the existing build/tests and shared snapshot verification. For shared changes, run the homepage cross-site visual checks and review desktop/mobile, light/dark screenshots.
- Preserve URLs, search, keyboard behavior, CSP and all local business-data storage formats.

- Blog lists use the shared ArticleTimeline component. Keep entries equal; derive dates/month groups from pubDatetime in the post/site timezone. Do not require new tags or images, or promote posts based on modDatetime.
- Reading enhancements must preserve Markdown content, section anchors, deep links and native browser history. New per-page scripts must clean up observers/listeners before Astro swaps and honor reduced motion. Content stays visible without JavaScript.
