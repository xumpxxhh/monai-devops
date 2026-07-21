import { config } from 'dotenv';

/**
 * 加载环境变量。
 * - 若设置了 MONAI_ENV_FILE（如 `.env.test`）：优先加载该文件并强制覆盖其中的键。
 * - 否则：`.env.local` → `.env`（已存在的 process.env 不覆盖）。
 */
const monaiEnvFile = process.env.MONAI_ENV_FILE?.trim();
if (monaiEnvFile) {
  config({ path: monaiEnvFile, override: true, quiet: true });
} else {
  config({ path: '.env.local', quiet: true });
  config({ path: '.env', quiet: true });
}
