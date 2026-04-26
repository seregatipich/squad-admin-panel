# worker-stats — Data model

P2 stub. No data is read or written.

When implemented, will consume `events:server:{id}` via the `stats:v1` consumer group and write aggregated stats to a Postgres table (schema TBD). The `processed_events` table in `packages/db/src/schema/events.ts` is the idempotency store for consumer-group processing.
