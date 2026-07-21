import { assertDatabaseUrl } from './assert-database-url.js';

describe('assertDatabaseUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows missing DATABASE_URL in test', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_URL;
    expect(() => assertDatabaseUrl()).not.toThrow();
  });

  it('fails fast when DATABASE_URL is missing outside test', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
    expect(() => assertDatabaseUrl()).toThrow('DATABASE_URL is required');
  });

  it('passes when DATABASE_URL is set outside test', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    expect(() => assertDatabaseUrl()).not.toThrow();
  });
});
