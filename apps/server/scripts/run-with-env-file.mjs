#!/usr/bin/env node
/**
 * Load an env file (override), then spawn the remaining argv as a command.
 * Usage: node scripts/run-with-env-file.mjs .env.test -- prisma migrate deploy
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep <= 0 || sep === args.length - 1) {
  console.error(
    'Usage: node scripts/run-with-env-file.mjs <env-file> -- <command> [args...]',
  );
  process.exit(1);
}

const envFile = args[0];
const command = args[sep + 1];
const commandArgs = args.slice(sep + 2);

config({ path: resolve(process.cwd(), envFile), override: true, quiet: true });

const child = spawn(command, commandArgs, {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
