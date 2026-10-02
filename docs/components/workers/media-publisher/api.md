# API

The worker has no HTTP API of its own and opens no port. Work reaches it through
the `media_publications` table, which the API fills.

## HTTP routes that feed the worker

Served by [`apps/api/src/routes/media-publications.ts`](../../../../apps/api/src/routes/media-publications.ts).

| Route | Effect on the worker |
|---|---|
| `POST /api/v1/media/:id/publications` | Inserts one `queued` row per requested destination with `attempts = 0` and `next_attempt_at = now`. Answers 409 `already_queued` when a destination already has a row, 400 `not_a_stored_file` for a media row without `storage_path`. |
| `GET /api/v1/media/:id/publications` | Lists the rows the worker updates. |
| `DELETE /api/v1/media/:id/publications/:destination` | Deletes a row that is not `uploading`; a claimed row answers 409 `publication_in_progress`. |
| `GET /api/v1/integrations/media-publishing` | Reports `youtube_configured`, `telegram_configured` and `release_local_file`. |
| `PATCH /api/v1/integrations/media-publishing` | Writes `media_publish_settings.release_local_file`. |

## Exported functions

| Module | Function or constant | Purpose |
|---|---|---|
| [`src/tick.ts`](../../../../apps/workers/media-publisher/src/tick.ts) | `runMediaPublisherTick(deps)` | One pass. Returns `{ claimed, published, retried, failed, skipped, released }`. |
| `src/tick.ts` | `computeBackoffMs(attempts)` | `min(60 s * 2^(attempts - 1), 6 h)`. |
| `src/tick.ts` | `MEDIA_PUBLISH_*` constants | Backoff base and ceiling, retry budget, lease, interrupted-upload error, unconfigured delay. |
| [`src/deps.ts`](../../../../apps/workers/media-publisher/src/deps.ts) | `createMediaPublisherDeps(db, options)` | Builds `publishers`, `claimDue`, `markPublished`, `markRetry`, `markFailed`, `deferUnconfigured` and `releaseIfEnabled`. |
| [`src/publishers/telegram.ts`](../../../../apps/workers/media-publisher/src/publishers/telegram.ts) | `createTelegramPublisher(config)`, `telegramMessageUrl(chatId, messageId)` | Publisher or `null`; public message URL or `null`. |
| [`src/publishers/youtube.ts`](../../../../apps/workers/media-publisher/src/publishers/youtube.ts) | `createYouTubePublisher(config)`, `msUntilQuotaReset(now)`, `isQuotaError(body)` | Publisher or `null`; milliseconds to the next local midnight in `America/Los_Angeles`; quota-reason check. |
| [`src/redact.ts`](../../../../apps/workers/media-publisher/src/redact.ts) | `redactSecrets(message, secrets)` | Replaces each secret of 8 or more characters with `[redacted]`. |

A publisher is a function `(job) => Promise<PublishOutcome>`. `PublishOutcome` is
either `{ ok: true, externalId, externalUrl }` (`externalUrl` may be `null`) or
`{ ok: false, retryable, error, quota?, retryAfterMs?, uploadSessionUrl? }`.

## Outbound HTTP

| Destination | Request | Used for |
|---|---|---|
| Telegram | `POST https://api.telegram.org/bot<token>/sendVideo`, `sendPhoto` or `sendDocument` (multipart) | Upload and post. 10-minute deadline. |
| Google OAuth | `POST https://oauth2.googleapis.com/token` | Refresh token to access token. |
| YouTube | `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus` | Open a resumable session. |
| YouTube | `PUT <session URL>` with `Content-Range: bytes */<size>` | Query the status of a persisted session. |
| YouTube | `PUT <session URL>` with the bytes | Upload the file or its remainder. |

## Redis surfaces

There is no stream or queue. The worker uses Redis only for:

| Key | Direction | Details |
|---|---|---|
| `worker:heartbeat:media-publisher` | write | Every 5 s, TTL 30 s, status `running`. Visible at `GET /api/v1/health/workers`. |
| `diag:queue` stream | write | Diagnostic events (below). |

## Diagnostic events

All events use `component: 'worker-media-publisher'`.

| Kind | Severity | Emitted when | Payload |
|---|---|---|---|
| `media_publisher.started` | `info` | Startup | `{ pid, youtube_configured, telegram_configured }` |
| `media_publisher.stopped` | `info` | SIGINT or SIGTERM | `{ sig }` |
| `media_publish.published` | `info` | A publication succeeded | `{ publication_id, media_id, destination, external_id }` |
| `media_publish.retry` | `warn` | A retry or quota deferral was scheduled | `{ publication_id, destination, error, attempts, next_attempt_at }`; the quota variant carries `quota: true` and no `attempts` |
| `media_publish.failed` | `error` | A publication reached `failed` | `{ publication_id, destination, error, attempts }` |
| `media_publish.skipped` | `info` | The destination is not configured; the job was deferred | `{ publication_id, destination }` |
| `media_publish.job_error` | `error` | A bookkeeping call threw for one job | `{ publication_id, destination }` |

The worker emits no per-tick event. The tick result is logged at `info` level
only when at least one publication was claimed.
