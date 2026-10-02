# Data Model

The worker owns no tables. It reads and writes three tables from
[`packages/db/src/schema/`](../../../../packages/db/src/schema/): `media_publications`
(the queue), `media_files` and `media_publish_settings`.

## `media_publications`

| Column | Notes |
|---|---|
| `id` | UUID primary key. |
| `media_id` | Foreign key to `media_files.id`, `ON DELETE CASCADE`. |
| `destination` | `youtube` or `telegram` (CHECK `media_publications_destination_check`). |
| `status` | `queued`, `uploading`, `published` or `failed` (CHECK `media_publications_status_check`); default `queued`. |
| `external_id` | Video id or message id, set on success. |
| `external_url` | Watch or message URL; NULL when none can be built. |
| `error` | Last error code or message, redacted. |
| `upload_session_url` | Open YouTube resumable session, cleared on `published` and `failed`. |
| `attempts` | Non-negative integer (CHECK `media_publications_attempts_nonneg`). |
| `next_attempt_at` | When the row is due; while `uploading` it is the lease expiry; NULL once terminal. |
| `requested_by_player_id` | Set by the API; the worker never touches it. |
| `created_at`, `updated_at` | The worker sets `updated_at` on every transition. |

Indexes: unique `media_publications_media_destination_key` on
`(media_id, destination)` and `media_publications_due_idx` on
`(status, next_attempt_at)`.

### Writes by the worker

| Operation | Columns set |
|---|---|
| Claim | `status = 'uploading'`, `attempts` plus 1 only when the row was already `uploading`, `error = 'upload_interrupted'` in that same case, `next_attempt_at = now + 6 h`, `updated_at = now()`. |
| `markPublished` | `status = 'published'`, `external_id`, `external_url`, `error = NULL`, `next_attempt_at = NULL`, `upload_session_url = NULL`, `updated_at`. |
| `markRetry` | `status = 'queued'`, `attempts`, `error`, `next_attempt_at`, `updated_at`, and `upload_session_url` only when the outcome carries one (a value stores it, `null` clears it). |
| `markFailed` | `status = 'failed'`, `attempts`, `error`, `next_attempt_at = NULL`, `upload_session_url = NULL`, `updated_at`. |
| `deferUnconfigured` | `status = 'queued'`, `error = 'destination_not_configured'`, `next_attempt_at`, `updated_at`; `attempts` is unchanged. |

### Claim query

Reads `media_publications` joined with `media_files` for rows where `status` is
`queued` or `uploading`, `next_attempt_at` is not NULL and not later than now,
and `media_files.deleted_at IS NULL`. Rows are ordered by `next_attempt_at ASC
NULLS LAST, updated_at ASC`, limited to the batch size and locked with
`FOR UPDATE OF p SKIP LOCKED`. From `media_files` the claim returns
`storage_path`, `mime_type`, `size_bytes`, `title`, `description` and
`original_filename`.

## `media_files`

Read by the claim (columns above). Written only by the release of a local file:
one `UPDATE` sets `storage_path = NULL` and `external_url = <destination URL>`
for the row whose `storage_path` still matches. The CHECK constraint
`media_files_exactly_one_location_check` requires exactly one of the two columns
to be set, which is why the swap is a single statement. The release also reads
other non-deleted `media_files` rows with the same `storage_path` to detect
deduplicated sharing.

## `media_publish_settings`

Singleton row (`id = 1`, CHECK `media_publish_settings_singleton`). The worker
reads `release_local_file` (default `false`) for each successful publication.
The API writes it.

## Locks

`releaseIfEnabled` runs its sharing check and swap inside
`pg_advisory_xact_lock(hashtext(<storage_path>))` through
`withMediaStoragePathLock` (`packages/db/src/media-storage-lock.ts`). The API's
upload dedup and soft delete take the same lock.

## Files

The worker reads files below `MEDIA_STORAGE_DIR` using the stored relative
`storage_path`, and removes the file after a successful release.

## Redis

Only the heartbeat and `diag:queue`; see [api.md](api.md). No Redis data is
durable.
