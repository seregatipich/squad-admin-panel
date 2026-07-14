# worker-scheduler — Data model

The worker reads enabled rows from `seed_schedule` and `rotation_schedule`.
`rotation_schedule.last_executed_at` prevents a one-off row from being queued
more than once. Weekly rows in `rotation_profiles` store one default profile
(`weekday IS NULL`) and optional server-local weekday overrides; the selected
row's `last_applied_at` prevents repeated application on the same local day.

Execution and profile application are recorded in `audit_log` with system actor
label `rotation-scheduler`. The 0078 migration creates the two ROT-4 tables;
the migration journal is finalized by the integration branch owner.
