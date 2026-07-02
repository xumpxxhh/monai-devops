import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const testFile = join(packageRoot, '__tests__/plugin-config-schema.test.ts');

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', testFile], {
  cwd: packageRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
