import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = existsSync('packages/site-ui') ? 'packages/site-ui' : 'vendor/site-ui';
await mkdir('public/site-ui', { recursive: true });
await copyFile(join(source, 'runtime.js'), 'public/site-ui/runtime.js');
const logo = await readFile(join(source, 'logo.svg'), 'utf8');
await writeFile('public/favicon.svg', logo.replace('<svg ', '<svg color="#287c82" '));
