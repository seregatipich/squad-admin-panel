/**
 * AUTO-1 (#72) rule evaluation engine.
 *
 * The pure `evaluate` implementation lives in `@squad/shared-types`
 * (`automation-engine.ts`, alongside `cron5.ts`) so the evaluating worker here
 * and the dry-run API route (`apps/api/src/routes/automation-rules.ts`) share
 * exactly one implementation. This module re-exports it as the worker's local
 * `rules/engine.js` entry point.
 */
export {
  type AutomationMatch,
  type AutomationPlayerRef,
  type AutomationRuleInput,
  type AutomationTriggerInput,
  evaluate,
} from '@squad/shared-types';
