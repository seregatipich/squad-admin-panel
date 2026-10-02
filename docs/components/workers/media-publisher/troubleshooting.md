# Troubleshooting

## Publications stay `queued`

Check `worker:heartbeat:media-publisher` (also visible at
`GET /api/v1/health/workers`), then the `media_publisher.started` diagnostic
event: `youtube_configured` and `telegram_configured` show which destinations
have credentials. A row whose destination is not configured is returned to
`queued` with `error = 'destination_not_configured'` and
`next_attempt_at` one hour ahead (`media_publish.skipped`); attempts are not
consumed. Set the credentials and restart the service; the backlog drains on the
next due tick. Also confirm the media is not soft-deleted: a row whose
`media_files.deleted_at` is set is never claimed.

## Worker exits at startup

`MEDIA_PUBLISHER_INTERVAL_MS` or `MEDIA_PUBLISHER_BATCH_SIZE` is outside its
range (1000 to 3600000 and 1 to 50) or not an integer. The log line reads
`<NAME> must be an integer between <min> and <max>`. A missing `DATABASE_URL` or
`REDIS_URL` also exits with code 1.

## A row sits in `uploading`

A claim is a 6-hour lease stored in `next_attempt_at`. A worker killed or
restarted mid-upload leaves the row `uploading`; it is claimed again after the
lease with one attempt counted and `error = 'upload_interrupted'`. When such a
row has already used 8 attempts it goes to `failed` without another upload. The
API refuses to delete an `uploading` row (409 `publication_in_progress`).

## Publication is `failed`

Read `media_publications.error`:

| Error | Meaning |
|---|---|
| `telegram_file_too_large` | The file is above 50 MiB; publish it to YouTube instead. |
| `no_local_file` | The media no longer has a `storage_path` (it was released or is an external link). |
| `youtube_unsupported_kind` | YouTube only accepts `video/*` media. |
| `youtube_auth_failed` | Google rejected the refresh token or client credentials; replace them. |
| `telegram_rejected: ...` | Telegram refused the request, for example the bot is not an admin of the chat. |
| `telegram_missing_message_id` | Telegram accepted the upload but returned no message id; check the chat before queueing it again to avoid a duplicate post. |
| `youtube_initiate_rejected_<status>: ...`, `youtube_upload_rejected_<status>: ...` | Google rejected the request permanently. |
| `upload_interrupted` | The upload kept dying with the worker (see above). |

A row also reaches `failed` when its eighth ordinary retryable failure is
recorded. Delete the row through `DELETE /api/v1/media/:id/publications/:destination`
and queue it again once the cause is fixed; the `(media_id, destination)` pair is
unique, so a failed row blocks a new publication until it is deleted.

## YouTube keeps deferring

`error = 'quota_exceeded'` with `attempts` unchanged is the daily quota. The row
is scheduled for the next local midnight in `America/Los_Angeles` and does not
consume its retry budget. It is not a fault of the job.

## Telegram message has no link

`external_url` is NULL when `TELEGRAM_CHAT_ID` is neither an `@username` nor a
`-100...` id. The publication still succeeded (`external_id` is the message id).
Because there is no URL, the local file is never released for that publication.

## Local file was not released

Release needs all of: `release_local_file` on, a destination `external_url`,
every other publication of the media already `published`, and no other
non-deleted `media_files` row sharing the `storage_path`. If any condition fails
the file stays and the publication is still `published`.

## Uploads fail with a missing file

The worker and the API must see the same directory. Both compose files pin
`MEDIA_STORAGE_DIR` to `/var/lib/squad-panel/media` on the `media_data` volume;
the relative default `./media` resolves differently in the two containers.

## Errors mention `[redacted]`

Expected: secrets (bot token, OAuth values, access token) are removed from every
error string before it is stored or logged. The surrounding text is the original
failure message.

## Tick skipped warnings

`media-publisher tick skipped: previous tick still in flight` means an upload
outlasted the interval. This is normal for large files; ticks never overlap.
Raise `MEDIA_PUBLISHER_INTERVAL_MS` to reduce the noise.
