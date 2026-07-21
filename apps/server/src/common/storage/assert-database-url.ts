/** 非 test 环境缺少 DATABASE_URL 时启动失败（禁止静默降级）。 */
export function assertDatabaseUrl(): void {
  if (process.env.NODE_ENV === 'test') return;

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required');
  }
}
