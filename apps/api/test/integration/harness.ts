/**
 * Stable entry point of the integration harness. The implementation lives in
 * `./harness/`; test files import everything from here.
 */

export { assertAuditRow } from './harness/audit.js';
export { buildIntegrationApp } from './harness/build-app.js';
export {
  type FakeBridge,
  type FakeBridgeOverrides,
  makeFakeBridge,
} from './harness/fake-bridge.js';
export { loginAsOwner } from './harness/session.js';
export type { BuildAppOptions, IntegrationHarness } from './harness/types.js';
export { createIsolatedSchema, runMigrations, testDbUrl } from './isolated-db.js';
