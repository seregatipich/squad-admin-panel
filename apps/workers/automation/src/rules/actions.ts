/**
 * AUTO-1 (#72) action execution.
 *
 * The pure `runMatch` implementation (with the dry-run guard) lives in
 * `@squad/shared-types` (`automation-actions.ts`) so the worker and the dry-run
 * API route share exactly one implementation. This module re-exports it as the
 * worker's local `rules/actions.js` entry point.
 */
export {
  type AutomationAuditDraft,
  type AutomationRunDraft,
  type NotifyDispatch,
  type RconDispatch,
  type RunMatchDeps,
  runMatch,
} from '@squad/shared-types';
