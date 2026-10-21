# @cznail/site-ui

Canonical visual foundation for `cznail.github.io`, `my-blog`, `totp` and `portfolio-pilot`.

- `tokens.css`: semantic colors, fonts, radii and light/dark themes.
- `shell.mjs` / `shell.css` / `logo.svg`: server/build-rendered navigation, brand and footer.
- `runtime.js`: same-origin early theme initialization, migration and accessible menu behavior. No network requests or tool-data access.

The homepage imports this directory. Other repositories commit an immutable, SHA-256-verified snapshot under `vendor/site-ui`; `site-ui.lock.json` records the upstream commit. Builds verify snapshots without network access. `scripts/sync-site-ui.mjs --update` updates them from the latest commit affecting this directory; scheduled workflows submit an upgrade PR. Update the version when changing public behavior.

Edit shared appearance here, not in a generated snapshot. Keep application layout local. Scope shell selectors; do not add global resets. Do not redefine `--site-*` outside this package. A local adapter may map existing names (e.g. `--background`) to these tokens. Keep reading text in the sans font and code/numeric codes in the mono font.

Before publishing: build all four apps, run shared integrity/theme tests, and run the cross-site visual check in desktop/mobile and light/dark modes. Review uploaded screenshots for intentional visual changes. The shared header must remain usable without client JS; tools must retain their CSP and local-data behavior.
