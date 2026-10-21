import { execFileSync } from 'node:child_process';

// Keep pre-existing article formatting out of unrelated maintenance PRs.
const base = process.env.GITHUB_BASE_SHA || 'origin/main';
const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', base], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (files.length) execFileSync('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...files], { stdio: 'inherit' });
