# worker-event-partition — Configuration

## Environment variables

| Name | Required | Default | Description | Sensitive |
|---|---:|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string | yes |
| `REDIS_URL` | no | — | ioredis connection string. If unset heartbeat is not published. | yes |
| `LOG_LEVEL` | no | `info` | Pino log level | no |

## Hard-coded constants

| Constant | Value | Location |
|---|---|---|
| Partition maintenance interval | 3 600 000 ms (1 h) | `apps/workers/event-partition/src/index.ts` |
| Postgres pool size | 1 connection | `index.ts` |
| Heartbeat interval | 5 000 ms | `startHeartbeat` default |
| Heartbeat TTL | 30 s | `HEARTBEAT_TTL_SECONDS` |
| `diagnostic_events` retention | 24h (any partition older than yesterday is dropped) | `ensureDiagPartitions` in `index.ts` |
| `diagnostic_events` create-buffer | `[-1, 0, +1, +2]` days from today | `ensureDiagPartitions` in `index.ts` |
| `events` retention | 24 months (`EVENTS_RETENTION_MONTHS`) | `ensureMonthlyPartitions` in `index.ts` |
| `events` create-buffer | current + next month | `ensureMonthlyPartitions` in `index.ts` |

| `processed_events` retention | 24 months (`PROCESSED_EVENTS_RETENTION_MONTHS`, equal to the `events` window) | `pruneProcessedEvents` in `index.ts` |
| `scheduled_task_runs` retention | 90 days (`SCHEDULED_TASK_RUNS_RETENTION_DAYS`) and at most 1 000 newest rows per task (`SCHEDULED_TASK_RUNS_MAX_PER_TASK`) | `pruneScheduledTaskRuns` in `index.ts` |

The retention and buffer values are not exposed as env vars; change them in code if a tuning need arises.

### Journal-table retention windows

`JOURNAL_RETENTION` in [`src/retention.ts`](../../../../apps/workers/event-partition/src/retention.ts) holds the windows of the unpartitioned journal tables (issue #77). Each is a Postgres interval literal applied by `pruneJournalTables` once per hourly tick, in batches of 5 000 rows (`RETENTION_BATCH_SIZE`; a statement that affects fewer rows than a full batch ends the loop).

| Key | Value | Table and rule |
|---|---|---|
| `alertEventsDelivered` | `90 days` | `alert_events` with `delivered = true`, measured from `triggered_at` |
| `alertEventsAny` | `365 days` | `alert_events` regardless of delivery, measured from `triggered_at` |
| `adminsCfgSyncOutboxRelayed` | `30 days` | `admins_cfg_sync_outbox` rows, measured from `relayed_at` (rows never relayed have no `relayed_at` and are never removed) |
| `scheduledTaskRuns` | `90 days` | `scheduled_task_runs`, measured from `executed_at` |
| `chatCommandInvocations` | `90 days` | `chat_command_invocations`, measured from `created_at` |
| `automationRuns` | `90 days` | `automation_runs`, measured from `fired_at` |
| `mediaUploadTokens` | `7 days` | `media_upload_tokens` whose `expires_at` or `used_at` is older than the window |
| `banAppealIpAfterDecision` | `30 days` | `ban_appeals.submitter_ip` set to `NULL` once `decided_at` is older than the window |
| `banAppealIpAfterSubmission` | `90 days` | `ban_appeals.submitter_ip` set to `NULL` once `created_at` is older than the window, decided or not |

Rows that are still referenced are kept: an `alert_events` row an `expiry_notifications` row points at, and a `media_upload_tokens` row a `media_files` row points at (both foreign keys are NO ACTION). Every statement is idempotent, so an interrupted run resumes on the next tick.
