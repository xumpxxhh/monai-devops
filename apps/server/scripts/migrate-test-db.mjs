#!/usr/bin/env node
/**
 * Sync schema to the test database without relying on migration folder order
 * (schema_sync is timestamped before init, which breaks migrate deploy on empty DBs).
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(serverRoot, '.env.test'), override: true, quiet: true });

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      cwd: serverRoot,
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`killed by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

await run('prisma', ['db', 'push', '--skip-generate']);
await run('prisma', [
  'db',
  'execute',
  '--schema',
  'prisma/schema.prisma',
  '--file',
  'prisma/migrations/20260720120000_restore_gin_indexes/migration.sql',
]);
