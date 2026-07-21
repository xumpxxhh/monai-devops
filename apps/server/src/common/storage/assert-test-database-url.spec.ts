import { assertTestDatabaseUrl, parseDatabaseName } from './assert-test-database-url.js';

describe('parseDatabaseName', () => {
  it('extracts database name from postgresql URL', () => {
    expect(parseDatabaseName('postgresql://monai:monai@localhost:5432/monai_devops_test')).toBe(
      'monai_devops_test',
    );
  });

  it('returns null for invalid URL', () => {
    expect(parseDatabaseName('not-a-url')).toBeNull();
  });
});

describe('assertTestDatabaseUrl', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('passes for *_test database', () => {
    expect(() =>
      assertTestDatabaseUrl('postgresql://monai:monai@localhost:5432/monai_devops_test'),
    ).not.toThrow();
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => assertTestDatabaseUrl('')).toThrow('DATABASE_URL is required for tests');
    delete process.env.DATABASE_URL;
    expect(() => assertTestDatabaseUrl()).toThrow('DATABASE_URL is required for tests');
  });

  it('fails when database name does not end with _test', () => {
    expect(() =>
      assertTestDatabaseUrl('postgresql://monai:monai@localhost:5432/monai_devops'),
    ).toThrow(/must use a database whose name ends with "_test"/);
  });
});
