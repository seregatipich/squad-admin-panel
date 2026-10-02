# Flows

## Startup and scheduling

1. `integerEnv` validates `MEDIA_PUBLISHER_INTERVAL_MS` and
   `MEDIA_PUBLISHER_BATCH_SIZE` when the module loads; a bad value exits with
   code 1.
2. `runWorker` connects Postgres (`DATABASE_URL`) and Redis (`REDIS_URL`),
   starts the `worker:heartbeat:media-publisher` heartbeat and builds the diag
   emitter.
3. `createMediaPublisherDeps` builds a Telegram and a YouTube publisher. A
   publisher is `null` (absent) unless its credentials are complete.
4. Signal handlers are installed, `media_publisher.started` is emitted with
   `{ pid, youtube_configured, telegram_configured }`, and one tick runs. A
   failure of that first tick is logged and does not stop the worker.
5. The tick then repeats every `MEDIA_PUBLISHER_INTERVAL_MS`. An interval that
   fires while the previous tick is still running is skipped with the warning
   `media-publisher tick skipped: previous tick still in flight`, so uploads
   never overlap inside one process.

## Tick

`runMediaPublisherTick` claims up to `MEDIA_PUBLISHER_BATCH_SIZE` due
publications with one statement (see the README for the SQL), then handles the
claimed jobs one after another:

1. A job reclaimed after an interrupted upload (`interrupted` is true) whose
   `attempts` already reached 8 is marked `failed` with error
   `upload_interrupted` and `media_publish.failed` is emitted. No upload is
   attempted.
2. A job whose destination has no publisher is returned to `queued` with error
   `destination_not_configured` and `next_attempt_at = now + 1 hour`;
   `attempts` is unchanged and `media_publish.skipped` is emitted.
3. Otherwise the destination publisher runs. A thrown error becomes a retryable
   outcome `publisher_threw: <message>`.
4. The outcome is recorded:

| Outcome | Row update | Event |
|---|---|---|
| Success | `published`, `external_id`, `external_url`, `error` cleared, `next_attempt_at` and `upload_session_url` cleared; then the release check runs | `media_publish.published` |
| Quota (`quota: true`) | `queued`, `attempts` unchanged, `next_attempt_at = now + retryAfterMs` | `media_publish.retry` with `quota: true` |
| Retryable error, budget left | `queued`, `attempts + 1`, `next_attempt_at = now + retryAfterMs` or `min(60 s * 2^(attempts - 1), 6 h)` | `media_publish.retry` |
| Permanent error, or `attempts + 1` reaching 8 | `failed`, `attempts + 1`, `next_attempt_at` and `upload_session_url` cleared | `media_publish.failed` |

A bookkeeping call that throws for one job (for example the pool closing during
a deploy) is reported as `media_publish.job_error` for that job only; the rest of
the batch continues. That row stays `uploading` until its lease expires.

A tick that throws before any job is handled (for example the claim query
failing) emits no diagnostic event; the runner logs `media-publisher tick failed`.

## Telegram publisher

1. Reject with `no_local_file` when `storage_path` is NULL, and with
   `telegram_file_too_large` (permanent) above 50 MiB.
2. Choose the method: `sendVideo` for `video/*`, `sendDocument` for an image
   above 10 MiB, `sendPhoto` otherwise.
3. Read the whole file, build a multipart form (`chat_id`, `caption` = title or
   original filename, the file) and `POST` it to
   `https://api.telegram.org/bot<token>/<method>` with a 10-minute deadline.
4. Classify the response: HTTP 429 is retryable with `retry_after` converted to
   milliseconds; HTTP 5xx is retryable; any other non-OK response is a permanent
   `telegram_rejected`; a transport error or timeout is retryable; a successful
   response without `message_id` is permanent (`telegram_missing_message_id`),
   because retrying would post the media twice.
5. On success the external id is the message id and the URL comes from
   `telegramMessageUrl` (`@name` gives `https://t.me/<name>/<id>`, `-100<n>`
   gives `https://t.me/c/<n>/<id>`, anything else gives NULL).

## YouTube publisher

1. Reject with `no_local_file` when `storage_path` is NULL and with
   `youtube_unsupported_kind` (permanent) when the MIME type is not `video/*`.
2. Exchange the refresh token at `https://oauth2.googleapis.com/token`. HTTP 5xx,
   408 and 429 are retryable; any other failure is the permanent
   `youtube_auth_failed`.
3. When the row carries `upload_session_url`, send a status `PUT` to it:
   404 or 410 discards the session; 308 resumes from the byte after the
   reported `Range` end; a 200 with a video id completes the publication without
   uploading; any other failure is classified as in step 6, and a quota or
   retryable failure keeps the persisted session.
4. Without a usable session, open a resumable session with `POST
   https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus`
   (title from `title` or `original_filename`, description, `privacyStatus:
   unlisted`). A missing `Location` header is retryable (`youtube_no_upload_session`).
5. `PUT` the bytes (streamed from disk, from the resume offset) to the session
   URL with a 30-minute deadline. Retryable failures after this point carry the
   session URL so the next attempt resumes instead of re-uploading.
6. Classification of a non-OK Google response: a quota reason
   (`quotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`) is a quota
   deferral to the next local midnight in `America/Los_Angeles`; 5xx, 408 and 429
   are retryable; other 4xx are permanent (`<stage>_rejected_<status>`).
7. On success the external id is the video id and the URL is
   `https://www.youtube.com/watch?v=<id>`.

Every error string passes through `redactSecrets`, which removes the bot token,
the OAuth client id, secret, refresh token and the access token.

## Release of the local file

After a successful publish, `releaseIfEnabled` runs. It does nothing unless the
destination returned an `external_url`, the media still has a `storage_path`,
and `media_publish_settings.release_local_file` (row `id = 1`) is true. It then
refuses while another publication of the same media is not `published`. The
final check and the swap run inside `withMediaStoragePathLock`: no other
non-deleted `media_files` row may share the `storage_path`, and one `UPDATE`
sets `storage_path` to NULL and `external_url` to the destination URL. After
the commit the file is removed from `MEDIA_STORAGE_DIR` on a best-effort basis;
a failed removal does not fail the publication.

## Graceful shutdown

On SIGINT or SIGTERM the worker clears the interval, emits
`media_publisher.stopped`, stops the heartbeat, closes the Postgres pool
(waiting up to 5 seconds for running queries) and quits Redis, then exits with
code 0. It does not wait for an upload that is running. Such a row remains
`uploading` and is reclaimed after its 6-hour lease expires, with one attempt
counted and error `upload_interrupted`.
