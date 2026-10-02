# Configuration

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `DATABASE_URL` | yes | none | PostgreSQL connection string. A missing value is fatal (`DATABASE_URL is required`, exit code 1). |
| `REDIS_URL` | yes | none | Redis connection for the heartbeat and diagnostics. A missing value is fatal. |
| `MEDIA_STORAGE_DIR` | no | `./media` | Base directory of stored media. Must be the directory the API writes to; both compose files set it to `/var/lib/squad-panel/media` on the shared `media_data` volume. |
| `MEDIA_PUBLISHER_INTERVAL_MS` | no | `60000` | Tick interval in milliseconds. Integer from 1000 through 3600000. |
| `MEDIA_PUBLISHER_BATCH_SIZE` | no | `3` | Publications claimed per tick. Integer from 1 through 50. |
| `YOUTUBE_CLIENT_ID` | no | unset | OAuth client id. |
| `YOUTUBE_CLIENT_SECRET` | no | unset | OAuth client secret. Sensitive. |
| `YOUTUBE_REFRESH_TOKEN` | no | unset | OAuth refresh token (`youtube.upload` scope). Sensitive. |
| `TELEGRAM_BOT_TOKEN` | no | unset | Bot token from BotFather. Sensitive. |
| `TELEGRAM_CHAT_ID` | no | unset | `@channelusername` or a numeric chat id. |
| `LOG_LEVEL` | no | `info` | Pino log level. |

The YouTube destination is enabled only when all three `YOUTUBE_*` credentials
are non-empty, and Telegram only when both `TELEGRAM_*` values are non-empty.
Compose passes empty strings for unset values, which count as absent. The
`started` diagnostic event reports `youtube_configured` and
`telegram_configured` as booleans; credential values never reach a log or
diagnostic event.

## Validation

`MEDIA_PUBLISHER_INTERVAL_MS` and `MEDIA_PUBLISHER_BATCH_SIZE` are parsed by
`integerEnv` in [`src/index.ts`](../../../../apps/workers/media-publisher/src/index.ts)
when the module loads. An unset or empty value uses the default; any other value
that is not an integer inside the range logs `<NAME> must be an integer between
<min> and <max>, got "<value>"` at `fatal` level and exits with code 1.

## Optional timeout overrides

[`src/publishers/youtube.ts`](../../../../apps/workers/media-publisher/src/publishers/youtube.ts)
reads two further variables with `Number(...)` and no validation. They are not
set by either compose file or `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `YOUTUBE_METADATA_TIMEOUT_MS` | `30000` | Deadline for the token, session-status and session-initiation requests. |
| `YOUTUBE_UPLOAD_TIMEOUT_MS` | `1800000` | Deadline for the byte upload request. |

## Hard-coded constants

| Constant | Value | Source |
|---|---|---|
| Retry backoff base | 60 000 ms, doubling per attempt | `MEDIA_PUBLISH_BACKOFF_BASE_MS` in `src/tick.ts` |
| Retry backoff ceiling | 6 hours | `MEDIA_PUBLISH_BACKOFF_MAX_MS` |
| Retry budget | 8 attempts | `MEDIA_PUBLISH_MAX_ATTEMPTS` |
| Upload lease | 6 hours | `MEDIA_PUBLISH_LEASE_MS` |
| Unconfigured-destination delay | 1 hour | `MEDIA_PUBLISH_UNCONFIGURED_DELAY_MS` |
| Batch size when the caller passes none | 5 | `DEFAULT_BATCH_SIZE` in `src/tick.ts` (the process always passes `MEDIA_PUBLISHER_BATCH_SIZE`) |
| Telegram upload ceiling | 50 MiB | `TELEGRAM_MAX_UPLOAD_BYTES` |
| Telegram photo ceiling | 10 MiB (larger images go out as documents) | `TELEGRAM_MAX_PHOTO_BYTES` |
| Telegram request deadline | 10 minutes | `TELEGRAM_REQUEST_TIMEOUT_MS` |
| YouTube quota reset zone | `America/Los_Angeles` | `YOUTUBE_QUOTA_RESET_TIMEZONE` |
| YouTube privacy status | `unlisted` | request body of the session initiation |
| YouTube title limit | 100 code points, `<` and `>` removed | `truncateCodePoints`, `stripAngleBrackets` |
| Heartbeat interval and TTL | 5 s and 30 s | `startHeartbeat` |

## Compose requirements

Both [`docker/compose.yml`](../../../../docker/compose.yml) and
[`docker/compose.stand.yml`](../../../../docker/compose.stand.yml) run the
service as `user: '0:0'` with the `media_data` volume mounted at
`/var/lib/squad-panel/media`, because releasing a local file deletes files the
API (root) wrote. The service uses the shared hardened profile (all capabilities
dropped, read-only root filesystem, 512 MiB memory limit, 1 CPU).

The `release_local_file` switch is not an environment variable: it lives in the
`media_publish_settings` table and is changed through
`PATCH /api/v1/integrations/media-publishing`.
