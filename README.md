# Neil's Blog

Neil Chen's Astro + AstroPaper blog, configured for GitHub Pages.

## Stack

- Astro 5
- AstroPaper
- Tailwind CSS
- Pagefind search
- English and Chinese routes
- GitHub Pages deployment
- Default light mode with manual dark mode toggle

## Development

```bash
pnpm install
pnpm run dev
```

## Build

```bash
pnpm run build
pnpm run preview
```

## Content

Blog posts live in `src/data/blog`.

English posts live in `src/data/blog/en`.

Chinese posts live in `src/data/blog/zh`.

Site metadata is configured in `src/config.ts`.

## Deployment

Pushes to `main` run `.github/workflows/deploy.yml` and publish `dist` to GitHub Pages.

Expected URL:

```text
https://cznail.github.io/my-blog/
```
