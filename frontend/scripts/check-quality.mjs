import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const onboardingPath = join(root, 'modules', 'onboarding.js');
const onboarding = await readFile(onboardingPath, 'utf8');
const version = onboarding.match(/const APP_VERSION = '([^']+)'/)?.[1];
const failures = [];

if (version !== packageJson.version) {
  failures.push(`onboarding APP_VERSION is ${version || 'missing'}; expected ${packageJson.version}`);
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (extname(entry.name) === '.js') files.push(path);
  }
  return files;
}

for (const file of await sourceFiles(root)) {
  const source = await readFile(file, 'utf8');
  if (/\b(?:prompt|confirm|alert)\s*\(/.test(source)) {
    failures.push(`${file.slice(root.length + 1)} uses a browser-native dialog`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('frontend quality checks passed');
