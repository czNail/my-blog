import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repository = 'czNail/cznail.github.io';
const sourcePath = 'packages/site-ui';
const root = process.cwd();
const canonical = existsSync(join(root, sourcePath));
const directory = join(root, canonical ? sourcePath : 'vendor/site-ui');
const hash = content => createHash('sha256').update(content).digest('hex');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const writeJSON = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
const safe = name => /^[a-zA-Z0-9][\w.-]*$/.test(name) && name !== 'manifest.json';

async function verifyAdapters(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await verifyAdapters(file);
    else if (/\.(css|astro|tsx?|html)$/.test(entry.name)) {
      const content = await readFile(file, 'utf8');
      if (/--site-[\w-]+\s*:/.test(content)) throw Error(`Shared token redefined outside its package: ${file}`);
      for (const match of content.matchAll(/--(bg|background|foreground|text|muted|line|border|card|surface|soft|accent|accent-soft|accent-bg|accent-text|button-text|warm|sans|mono|shadow)\s*:\s*([^;]+);/g)) {
        if (!match[2].trim().startsWith('var(--site-')) throw Error(`Local brand token --${match[1]} must reference a shared token: ${file}`);
      }
    }
  }
}

async function manifestFor(dir) {
  const pkg = await json(join(dir, 'package.json'));
  const files = {};
  for (const name of (await readdir(dir)).sort()) {
    if (safe(name)) files[name] = hash(await readFile(join(dir, name)));
  }
  return { version: pkg.version, files };
}
async function fetchJSON(url) {
  const response = await fetch(url, { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Cannot read shared UI (${response.status}): ${url}`);
  return response.json();
}

if (process.argv.includes('--manifest')) {
  if (!canonical) throw Error('Generate the manifest in the canonical homepage repository.');
  await writeFile(join(directory, 'logo.mjs'), '// Generated from logo.svg by sync-site-ui.mjs --manifest.\nexport default ' + JSON.stringify(await readFile(join(directory, 'logo.svg'), 'utf8')) + ';\n');
  await writeJSON(join(directory, 'manifest.json'), await manifestFor(directory));
} else if (process.argv.includes('--update') || process.argv.includes('--from')) {
  if (canonical) throw Error('The homepage already uses the canonical source; edit packages/site-ui.');
  const fromIndex = process.argv.indexOf('--from');
  const localRoot = fromIndex >= 0 ? resolve(process.argv[fromIndex + 1]) : null;
  const revision = localRoot
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: localRoot, encoding: 'utf8' }).trim()
    : (await fetchJSON(`https://api.github.com/repos/${repository}/commits?path=${sourcePath}&per_page=1`))[0].sha;
  if (!/^[0-9a-f]{40}$/.test(revision)) throw Error('Invalid upstream revision.');
  const base = `https://raw.githubusercontent.com/${repository}/${revision}/${sourcePath}/`;
  const manifest = localRoot ? await json(join(localRoot, sourcePath, 'manifest.json')) : await fetchJSON(base + 'manifest.json');
  const contents = await Promise.all(Object.entries(manifest.files).map(async ([name, expected]) => {
    if (!safe(name)) throw Error('Unsafe manifest entry.');
    let content;
    if (localRoot) content = await readFile(join(localRoot, sourcePath, name));
    else {
      const response = await fetch(base + name, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Cannot download ${name}: ${response.status}`);
      content = Buffer.from(await response.arrayBuffer());
    }
    if (hash(content) !== expected) throw Error(`Shared UI checksum mismatch: ${name}`);
    return [name, content];
  }));
  // Validate everything before replacing the current snapshot.
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) if (!(name in manifest.files) && name !== 'manifest.json') await rm(join(directory, name));
  for (const [name, content] of contents) await writeFile(join(directory, name), content);
  await writeJSON(join(directory, 'manifest.json'), manifest);
  await writeJSON(join(root, 'site-ui.lock.json'), { repository, path: sourcePath, revision, ...manifest });
  process.stdout.write(`Shared UI ${manifest.version} pinned to ${revision}\n`);
} else {
  const manifest = await json(join(directory, 'manifest.json'));
  const actual = await manifestFor(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw Error('Shared UI was edited without updating its manifest. Edit the canonical package, or run sync-site-ui.mjs --update in a consumer.');
  if (!canonical) {
    const lock = await json(join(root, 'site-ui.lock.json'));
    if (lock.repository !== repository || lock.path !== sourcePath || !/^[0-9a-f]{40}$/.test(lock.revision) || lock.version !== manifest.version || JSON.stringify(lock.files) !== JSON.stringify(manifest.files)) throw Error('Shared UI snapshot does not match site-ui.lock.json.');
  }
  await verifyAdapters(join(root, 'src'));
  process.stdout.write(`Shared UI ${manifest.version}: checksums verified\n`);
}
