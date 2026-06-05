import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function collectTestFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      collectTestFiles(path, files);
      continue;
    }
    if (name.endsWith('.test.ts')) {
      files.push(relative(packageRoot, path).replaceAll('\\', '/'));
    }
  }
  return files;
}

const testsDir = join(packageRoot, '__tests__');
const testFiles = collectTestFiles(testsDir).sort();

if (testFiles.length === 0) {
  console.error('No test files found under __tests__');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  cwd: packageRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
