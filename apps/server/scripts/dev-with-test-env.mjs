#!/usr/bin/env node
/** Set MONAI_ENV_FILE=.env.test then spawn nest with remaining args. */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

process.env.MONAI_ENV_FILE = '.env.test';

const require = createRequire(import.meta.url);
const nestCli = require.resolve('@nestjs/cli/bin/nest.js');
const nestArgs = process.argv.slice(2);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(process.execPath, [nestCli, ...nestArgs], {
  stdio: 'inherit',
  env: process.env,
  cwd: serverRoot,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
