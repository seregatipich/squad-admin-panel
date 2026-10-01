import { createWorkerLog, guardAgainstOverlap, runWorker } from '@squad/worker-kit';
import { requiredTickIntervalMs } from './env.js';
import { createRoleExpiryReminderDeps, runRoleExpiryReminderTick } from './reminders.js';
import { createSubscriptionRenewalDeps, runSubscriptionRenewalTick } from './renewal.js';
import { createRoleExpiryDeps, runRoleExpiryTick } from './tick.js';

export { guardAgainstOverlap };

const log = createWorkerLog('role-expirer');

const TICK_INTERVAL_MS = requiredTickIntervalMs(
  'ROLE_EXPIRER_INTERVAL_MS',
  process.env.ROLE_EXPIRER_INTERVAL_MS,
  60_000,
);
/** Daily VIPSUB-4 reminder pass — window crossings fire at most once, so once a day is enough. */
const REMINDER_INTERVAL_MS = requiredTickIntervalMs(
  'ROLE_EXPIRY_REMINDER_INTERVAL_MS',
  process.env.ROLE_EXPIRY_REMINDER_INTERVAL_MS,
  86_400_000,
);
/**
 * VIPSUB-5 subscription renewal pass. Hourly: a renewal is due on a date, not
 * at a second, and each pass charges real bonus points — an hour keeps the
 * billing punctual without hammering the ledger.
 */
const RENEWAL_INTERVAL_MS = requiredTickIntervalMs(
  'VIP_RENEWAL_INTERVAL_MS',
  process.env.VIP_RENEWAL_INTERVAL_MS,
  3_600_000,
);

runWorker({
  name: 'role-expirer',
  log,
  entrypoint: import.meta.url,
  postgres: { drizzle: true },
  setup: ({ db, redis, diag }) => {
    const runtimeDeps = createRoleExpiryDeps(db, redis);
    const reminderDeps = createRoleExpiryReminderDeps(db, redis);
    const renewalDeps = createSubscriptionRenewalDeps(db, redis);
    return {
      ticks: [
        {
          intervalMs: TICK_INTERVAL_MS,
          failureMessage: 'role-expirer tick failed',
          run: async () => {
            const result = await runRoleExpiryTick({ ...runtimeDeps, diag });
            log.info(result, 'role-expirer tick');
          },
        },
        {
          intervalMs: REMINDER_INTERVAL_MS,
          failureMessage: 'role-expirer reminder tick failed',
          firstRunFailure: 'log',
          run: async () => {
            const result = await runRoleExpiryReminderTick({ ...reminderDeps, diag });
            log.info(result, 'role-expirer reminder tick');
          },
        },
        {
          intervalMs: RENEWAL_INTERVAL_MS,
          failureMessage: 'role-expirer renewal tick failed',
          firstRunFailure: 'log',
          // Two overlapping renewal passes reading the same due subscription before
          // either commits is the double-charge scenario `chargeRenewalTx`'s `dueAt`
          // check also guards against at the database level (#984, #990); skipping
          // the overlap stops it from happening as routinely in the first place.
          run: async () => {
            const result = await runSubscriptionRenewalTick({ ...renewalDeps, diag });
            log.info(result, 'role-expirer subscription renewal tick');
          },
        },
      ],
    };
  },
});
