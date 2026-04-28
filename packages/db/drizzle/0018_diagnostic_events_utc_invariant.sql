-- Documentation-only migration. No DDL.
--
-- Establishes the UTC invariant for diagnostic_events partitions:
-- from this point forward, every diagnostic_events_<YYYYMMDD> partition
-- created by worker-event-partition (apps/workers/event-partition) MUST
-- have bounds derived from UTC, not the Postgres session TimeZone.
--
-- Production Postgres MUST run with TimeZone = 'UTC' (or behave equivalently
-- for date arithmetic) so the worker's UTC-derived partition names and bounds
-- align with any partitions created by the original 0017 bootstrap.
--
-- Migration 0017's bootstrap loop used `current_date` which is session-TZ
-- dependent. Any partitions it created with non-UTC bounds will naturally age
-- out within 24h via the worker's drop-stale logic; after that the system
-- converges to UTC alignment with no operator action required.
--
-- This file intentionally contains only a no-op so Drizzle records the
-- migration in the journal without modifying schema.

SELECT 1;
