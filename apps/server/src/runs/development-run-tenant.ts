import type { RunRecord } from './runs.repository.js';

/** Development-only principal. Production tenant resolution must replace this boundary. */
export const DEVELOPMENT_RUN_TENANT_ID = 'development-default';

export function isDevelopmentAppEnvironment(value: string | undefined): boolean {
  return ['local-dev', 'online-dev', 'local-test', 'online-test', 'development'].includes(
    value ?? '',
  );
}

export function developmentRunTenantCanDispatch(run: RunRecord): boolean {
  const tenantId = run.metadata?.tenantId;
  return tenantId === undefined || tenantId === DEVELOPMENT_RUN_TENANT_ID;
}
