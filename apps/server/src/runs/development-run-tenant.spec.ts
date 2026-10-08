import {
  DEVELOPMENT_RUN_TENANT_ID,
  developmentRunTenantCanDispatch,
} from './development-run-tenant.js';
import type { RunRecord } from './runs.repository.js';

describe('development Run tenant', () => {
  it('allows the single default tenant and legacy untagged Runs', () => {
    expect(
      developmentRunTenantCanDispatch({
        metadata: { tenantId: DEVELOPMENT_RUN_TENANT_ID },
      } as unknown as RunRecord),
    ).toBe(true);
    expect(developmentRunTenantCanDispatch({ metadata: {} } as unknown as RunRecord)).toBe(true);
  });

  it('does not silently grant another tenant the development permission', () => {
    expect(
      developmentRunTenantCanDispatch({ metadata: { tenantId: 'other' } } as unknown as RunRecord),
    ).toBe(false);
  });
});
