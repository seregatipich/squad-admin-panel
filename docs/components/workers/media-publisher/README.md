# `media-publisher`

Publishes stored media files to community channels — YouTube and Telegram (VIDEO-4, [#160](https://github.com/breaking-squad/squad-admin-panel/issues/160)).

This is a **showcase side-channel, not part of the moderation core**. Primary storage stays ours ([VIDEO-1](../../../../apps/api/src/lib/media-storage.ts)); publication is opt-in and the whole worker is inert on a deployment that never sets credentials.

- Source: [`apps/workers/media-publisher/`](../../../../apps/workers/media-publisher/)
- Heartbeat key: `worker:heartbeat:media-publisher` (visible at `GET /api/v1/health/workers`)
- Diag component: `worker-media-publisher`

## The queue

There is no Redis stream. The `media_publications` table *is* the queue, because retry and backoff fall out of it for free — a row carries its own `attempts` and `next_attempt_at`.

Each tick (`MEDIA_PUBLISHER_INTERVAL_MS`, default 60 s) claims up to `MEDIA_PUBLISHER_BATCH_SIZE` rows in one statement:

```sql
WITH due AS (
  SELECT p.id FROM media_publications p
  JOIN media_files m ON m.id = p.media_id
  WHERE p.status = 'queued' AND p.next_attempt_at <= now() AND m.deleted_at IS NULL
  ORDER BY p.next_attempt_at ASC LIMIT $n
  FOR UPDATE OF p SKIP LOCKED
)
UPDATE media_publications p SET status = 'uploading' ... RETURNING ...
```

`FOR UPDATE ... SKIP LOCKED` plus the `status = 'queued'` re-check on the `UPDATE` is what makes a second replica — or a second tick overlapping a slow one — unable to take the same row.

## Three failure outcomes, deliberately distinct

Conflating these is how an upload queue quietly loses work:

| Outcome | `status` | `attempts` | `next_attempt_at` |
|---|---|---|---|
| Transient error (5xx, socket, 429) | back to `queued` | `+1` | exponential: 60 s doubling, capped at 6 h |
| **YouTube daily quota** | back to `queued` | **unchanged** | next quota reset (local midnight, `America/Los_Angeles`) |
| Destination not configured | back to `queued` | **unchanged** | `now + 1 h` |
| Permanent rejection, or `attempts` reaching 8 | `failed` | `+1` | `NULL` |

The quota row is the important one. A daily allowance being spent is not the job's fault, so advancing `attempts` would let a long outage burn the retry budget and tip a perfectly good clip into `failed`. Same reasoning for an unconfigured destination: that is an operator's omission, and the backlog must survive it so that adding credentials later drains the queue instead of finding it dead.

## Destinations

Both publishers are built by a factory that returns `null` when its credentials are absent, mirroring `fetchSteamProfile`'s `if (!deps.apiKey) return null`. A destination with no publisher is deferred, never failed.

**Telegram** — `sendVideo`/`sendPhoto` over raw `fetch`. The Bot API caps an upload at **50 MiB** against the panel's own 2 GiB media limit, and bots have no chunked path, so a larger file is a *permanent* `telegram_file_too_large` rather than an endless retry; YouTube is the fallback for those. A public message URL only exists for an `@username` channel or a `-100…` supergroup — for any other chat the publication still succeeds with `external_id` set and `external_url` **NULL**, because a fabricated link would later be used to justify deleting the local file.

**YouTube** — Data API v3 over raw `fetch`: OAuth refresh → resumable session → byte upload. No `googleapis` dependency, matching how this repo already talks to Discord and Steam. Videos are uploaded **`unlisted`**: this is moderation evidence, and the panel must not silently make every clip searchable on the open web.

### Secret hygiene

Every error string leaving a publisher passes through [`src/redact.ts`](../../../../apps/workers/media-publisher/src/redact.ts). This is not decoration: the Telegram request URL *is* the bot token (`/bot<token>/sendVideo`), and `fetch` puts the full URL into its thrown error message — so an unscrubbed transport failure would write the bot token into `media_publications.error`, into worker logs, and into diag events. Google error bodies can likewise echo a rejected credential back.

## Releasing the local file

When `media_publish_settings.release_local_file` is on (**off by default**), a successful publish swaps `media_files.storage_path` for the destination's `external_url` and deletes the file from disk.

Three guards must all hold first, each protecting against losing evidence outright:

1. the destination produced a real `external_url` to fall back on;
2. every other publication of that media has already finished — otherwise a still-queued destination loses the file it was about to upload;
3. no second `media_files` row shares the `storage_path` — uploads are deduplicated by sha256, so one file on disk can back several rows.

The swap itself is a single `UPDATE`: `media_files_exactly_one_location_check` forbids a row holding both or neither location, so it cannot be split into two statements.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | required |
| `REDIS_URL` | — | required (heartbeat + diag) |
| `MEDIA_STORAGE_DIR` | `./media` | **Must be the same directory the API writes to.** Both compose files pin `api` and this worker to the shared `media_data` volume at `/var/lib/squad-panel/media`; their WORKDIRs differ, so the relative default would give them two separate directories. |
| `MEDIA_PUBLISHER_INTERVAL_MS` | `60000` | tick interval |
| `MEDIA_PUBLISHER_BATCH_SIZE` | `3` | publications per tick |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | unset | all three required, or YouTube stays off |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | both required, or Telegram stays off |

See [`.env.example`](../../../../.env.example) for the annotated originals.

## Testing

```bash
pnpm --filter @squad/worker-media-publisher exec vitest run
```

`test/tick.test.ts` drives the state machine with injected publishers; `test/telegram.test.ts` and `test/youtube.test.ts` drive the real publisher code against an injected `fetch` double (including the secret-leak assertions); `test/deps.integration.test.ts` exercises the actual SQL against Postgres, including the concurrent-claim guarantee and the `storage_path` → `external_url` swap; `test/contract.test.ts` is the shared heartbeat/SIGTERM contract.

**Not covered by automated tests:** a real upload to YouTube or Telegram. That requires third-party credentials which cannot be synthesised, and no test fakes a pass for it — the live publish is verified by hand against a test channel when credentials are available.
