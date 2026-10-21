# Shared site appearance

- Canonical source: `czNail/cznail.github.io`, `packages/site-ui`. `vendor/site-ui` is generated and checksum verified; never edit it directly.
- Update with `node scripts/sync-site-ui.mjs --update`. The pinned revision and hashes live in `site-ui.lock.json`; scheduled update workflows submit an upgrade PR.
- Use shared tokens, header, footer, logo and theme runtime. Do not redefine `--site-*` or add a second global theme preference. Map legacy variables to the shared tokens. Keep business layout local.
- Run the existing build/tests and shared snapshot verification. For shared changes, run the homepage cross-site visual checks and review desktop/mobile, light/dark screenshots.
- Preserve URLs, search, keyboard behavior, CSP and all local business-data storage formats.
