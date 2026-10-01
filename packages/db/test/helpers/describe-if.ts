/**
 * Suite gates for tests that need Postgres or Redis.
 *
 * Every infrastructure-backed suite used to open with its own copy of
 * `process.env.DATABASE_URL ? describe : describe.skip`. A runner that lost its
 * database then reported a green run in which those suites had silently not
 * run. These gates keep the local convenience (no database, suite skipped) and
 * remove the silence: the skip is announced, and under `CI` it is an error.
 *
 * The helper lives beside the other cross-package test helpers because worker
 * and API suites import them by relative path as well.
 */
import { describe } from 'vitest';

/** Declares a suite the way `describe(name, factory)` does. */
export type SuiteDeclarer = (name: string, factory: () => void | Promise<void>) => void;

/** The Vitest entry points and environment a gate reads, injectable for tests. */
export interface SuiteGateRuntime {
  /** Environment consulted when a suite is declared, not when the gate is built. */
  env: NodeJS.ProcessEnv;
  /** Declares a suite that runs. */
  run: SuiteDeclarer;
  /** Declares a suite that is reported as skipped. */
  skip: SuiteDeclarer;
  /** Receives the notice that a suite was skipped. */
  warn: (message: string) => void;
}

const vitestRuntime: SuiteGateRuntime = {
  env: process.env,
  run: describe,
  skip: describe.skip,
  warn: (message) => console.warn(message),
};

/**
 * Builds a suite declarer that runs only when every named variable is set.
 *
 * With a variable missing, the declarer throws while the file is being
 * collected when `CI` is set, so a runner without its services cannot go green
 * by skipping; otherwise it declares the suite skipped and warns with the
 * suite's name.
 *
 * @param requiredVariables - Environment variables that must all be non-empty.
 * @param runtime - Vitest entry points and environment; defaults to the real ones.
 * @returns A declarer with the signature of `describe(name, factory)`.
 * @throws From the returned declarer: when a variable is missing and `CI` is set.
 */
export function createSuiteGate(
  requiredVariables: readonly string[],
  runtime: SuiteGateRuntime = vitestRuntime,
): SuiteDeclarer {
  return (name, factory) => {
    const missing = requiredVariables.filter((variable) => !runtime.env[variable]);
    if (missing.length === 0) {
      runtime.run(name, factory);
      return;
    }
    const list = missing.join(', ');
    if (runtime.env.CI) {
      throw new Error(
        `Suite "${name}" needs ${list}, which is not set, and CI is set: refusing to skip it silently. Provision the service for this job.`,
      );
    }
    runtime.warn(`[skipped] Suite "${name}": ${list} is not set.`);
    runtime.skip(name, factory);
  };
}

/** Declares a suite that needs Postgres (`DATABASE_URL`). */
export const describeIfDb: SuiteDeclarer = createSuiteGate(['DATABASE_URL']);

/** Declares a suite that needs Redis (`REDIS_URL`). */
export const describeIfRedis: SuiteDeclarer = createSuiteGate(['REDIS_URL']);

/** Declares a suite that needs both Postgres and Redis. */
export const describeIfDbAndRedis: SuiteDeclarer = createSuiteGate(['DATABASE_URL', 'REDIS_URL']);
