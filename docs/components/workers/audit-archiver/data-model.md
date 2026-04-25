# worker-audit-archiver — Data model

## Current state (P0 stub)

No data is read or written beyond the heartbeat key.

## Planned Phase 1 data access

### Postgres — `audit_log` table (read)

Rows with `created_at < NOW() - INTERVAL '90 days'` will be selected, serialised to JSONL, and then deleted via `audit_log_archive_view`.

The `audit_log` table is append-only enforced by a BEFORE UPDATE/DELETE trigger. Deletion only succeeds through the `SECURITY DEFINER` view that bypasses the trigger.

### `audit_log` row schema (read path)

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` | Serialised as string (BigInt) |
| `row_hash` | `text` | SHA-256 chain: `sha256(prev_hash \|\| canonical_json(row))` |
| `action` | `text` | Audit action key |
| `resource` | `text` | Resource type |
| `resource_id` | `text` | |
| `actor_id` | `uuid` | |
| `actor_email` | `text` | |
| `ip` | `inet` | |
| `created_at` | `timestamptz` | |
| `payload` | `jsonb` | Route-specific details |

### Redis keys (planned)

| Key | TTL | Description |
|---|---|---|
| `worker:heartbeat:audit-archiver` | 30 s | Liveness heartbeat |
| `audit-archiver:last-run` | — | Timestamp + stats of the last archive run |
