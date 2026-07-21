/** 从 DATABASE_URL 解析数据库名（pathname，去掉 leading `/`）。 */
export function parseDatabaseName(databaseUrl: string): string | null {
  try {
    const pathname = new URL(databaseUrl).pathname.replace(/^\//, '');
    return pathname || null;
  } catch {
    return null;
  }
}

/**
 * Jest（NODE_ENV=test）强制 DATABASE_URL 指向以 `_test` 结尾的库，
 * 防止集成测 / e2e 的 deleteMany 清掉开发库。
 * 开发进程（dev / dev:test）不调用本函数。
 */
export function assertTestDatabaseUrl(databaseUrl = process.env.DATABASE_URL): void {
  const url = databaseUrl?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for tests. Use apps/server/.env.test (e.g. monai_devops_test).',
    );
  }

  const name = parseDatabaseName(url);
  if (!name || !name.endsWith('_test')) {
    throw new Error(
      `Test processes must use a database whose name ends with "_test" (got ${
        name ?? 'invalid URL'
      }). Set DATABASE_URL in .env.test to postgresql://.../monai_devops_test.`,
    );
  }
}
