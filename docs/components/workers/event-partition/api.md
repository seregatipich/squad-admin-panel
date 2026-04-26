# worker-event-partition — API surface

No HTTP surface and no Redis stream output.

## Heartbeat key: `worker:heartbeat:event-partition`

Published every 5 s (default interval), TTL 30 s.

`status` field: `"idle"`.

## Side effects on Postgres

The worker issues DDL against the `events` partitioned table. In Phase 1 this will be:

```sql
CREATE TABLE IF NOT EXISTS events_YYYY_MM
  PARTITION OF events
  FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01');
```

No data is returned to callers. The DDL is idempotent (`IF NOT EXISTS`).
