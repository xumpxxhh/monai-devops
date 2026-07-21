import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 加载 .env.test；对所有键强制写入（覆盖 shell/IDE 残留的开发库 URL）。 */
export function loadEnvTest(cwd = process.cwd()): void {
  const filePath = resolve(cwd, '.env.test');
  if (!existsSync(filePath)) return;

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
