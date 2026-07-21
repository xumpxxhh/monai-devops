import { loadEnvTest } from './load-env-test.js';
import { assertTestDatabaseUrl } from '../src/common/storage/assert-test-database-url.js';

loadEnvTest();
process.env.NODE_ENV = 'test';
process.env.GLOBAL_API_PREFIX ??= 'api/v1/devops';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('e2e requires DATABASE_URL from .env.test (postgresql://.../monai_devops_test).');
}

assertTestDatabaseUrl();
