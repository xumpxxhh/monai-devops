export const APP_ENV_VALUES = [
  'local-dev',
  'online-dev',
  'local-test',
  'online-test',
  'production',
] as const;

export type AppEnv = (typeof APP_ENV_VALUES)[number];

export const APP_ENV_LABELS: Record<AppEnv, string> = {
  'local-dev': '本地开发',
  'online-dev': '线上开发',
  'local-test': '本地测试',
  'online-test': '线上测试',
  production: '生产',
};

const DEFAULT_APP_ENV: AppEnv = 'local-dev';

const APP_ENV_SET = new Set<string>(APP_ENV_VALUES);

export function resolveAppEnv(raw: string | undefined): AppEnv {
  const value = raw?.trim();
  if (!value) return DEFAULT_APP_ENV;
  if (!APP_ENV_SET.has(value)) {
    throw new Error(`APP_ENV must be one of: ${APP_ENV_VALUES.join(', ')} (got: ${value})`);
  }
  return value as AppEnv;
}
