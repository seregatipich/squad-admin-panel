# `shared-types` — troubleshooting

## Zod validation fails on a request body field

**Symptom**: API returns 400 with a Zod issue like `"Expected string, received undefined"` or `"Invalid uuid"` on a field you believe is correct.

**Diagnostic**: Find the relevant schema in `packages/shared-types/src/api.ts` and compare the expected constraints with what the client is sending.

```bash
# Check the schema for the failing field:
grep -n 'fieldName' packages/shared-types/src/api.ts
```

Common causes:
- `id` fields must be valid UUIDs (use `uuidString = z.string().uuid()`). Sending an integer or an empty string fails.
- `auditEntry.id` is `z.string()` not `z.number()` — `bigserial` IDs must be serialized as strings.
- `.strict()` on all schemas: any extra key in the request body triggers a `ZodError`. Remove unknown fields before parsing.

## `EventEnvelope.type` causes a `ZodError` with "Invalid enum value"

**Symptom**: A producer sends an event type string that is not in `EVENT_TYPES`, and the consumer's `eventEnvelope.parse()` throws.

**Cause**: The producer is using a newer event type not yet in `EVENT_TYPES`. This is a forward-compat failure — consumers must be deployed before producers add new event types, or the consumer must use `.safeParse()` and tolerate unknown types.

**Fix**:
1. Add the new type to `EVENT_TYPES` in `packages/shared-types/src/events.ts`.
2. If you need to tolerate unknown types transiently (rolling deploy), use `eventEnvelope.passthrough()` or catch the error and move the message to DLQ.

## `validatePayload` returns `ok: false` with unexpected errors

**Symptom**: `validatePayload('player.connected', payload)` returns errors even though the payload looks correct.

**Cause**: A mis-serialized field. Common issues:
- `steam_id64` is a number (e.g. `76561198012345678`) not a string — Zod requires a string matching `/^\d{17}$/`.
- `eos_id` is an empty string rather than `null` for Steam-only joins.
- `name` is longer than 128 characters.

**Fix**: Ensure the producer serializes `steam_id64` as a string with `String(bigIntSteamId)` before embedding in the envelope payload.

## `paginated` schema rejects response from the API

**Symptom**: Client-side TypeScript or a consumer's `z.parse` fails on a paginated response.

**Cause**: The API is returning a non-paginated response shape, or `total`/`page`/`page_size` fields are missing.

**Diagnostic**:
```bash
curl -s https://squad-panel.lan/api/v1/servers | jq keys
```

Expected: `["items","page","page_size","total"]`.

**Fix**: Ensure the API route uses `reply.send({ items, total, page, page_size })`. If a route was added without the paginated wrapper, update it to match.

## Type errors after adding a new `EventType`

**Symptom**: TypeScript errors in code that exhaustively switches on `EventType`.

**Cause**: Adding a new string to `EVENT_TYPES` expands the union, breaking exhaustive `switch`/`if-else` chains.

**Fix**: Add a case for the new event type wherever `EventType` is exhaustively handled. Search the codebase:

```bash
grep -rn "EventType\|event_type" apps/ packages/ --include='*.ts' | grep -v '.d.ts'
```
