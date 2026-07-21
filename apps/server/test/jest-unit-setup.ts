import { loadEnvTest } from './load-env-test.js';
import { assertTestDatabaseUrl } from '../src/common/storage/assert-test-database-url.js';

loadEnvTest();
process.env.NODE_ENV = 'test';

if (process.env.DATABASE_URL?.trim()) {
  assertTestDatabaseUrl();
}
