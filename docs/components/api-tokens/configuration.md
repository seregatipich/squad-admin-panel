# `api-tokens` — configuration

This component does not introduce any new environment variables. It reuses everything already needed by `apps/api`.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | api | Used to read/write `player_api_tokens`. | yes |
| `REDIS_URL` | yes | — | api | Used for the `api-token-touch:{id}` SETNX throttle and for the existing rate limiter. | no |
| `SESSION_TTL_SECONDS` | yes | 21600 | api | Reused — no token-specific TTL. | no |

## Compile-time constants

Defined in [`apps/api/src/lib/api-tokens.ts`](../../../apps/api/src/lib/api-tokens.ts):

| Constant | Value | Purpose |
|---|---|---|
| `API_TOKEN_PREFIX` | `'sqp_'` | Lets secret scanners recognise leaked tokens. |
| `API_TOKEN_TOUCH_THROTTLE_SECONDS` | `60` | Per-token `last_used_at` write throttle. |

Defined in [`apps/api/src/routes/me-tokens.ts`](../../../apps/api/src/routes/me-tokens.ts):

| Constant | Value | Purpose |
|---|---|---|
| `NAME_MIN` / `NAME_MAX` | `1` / `100` | Bounds on `name`. |
| `MAX_ACTIVE_TOKENS_PER_USER` | `25` | Hard cap on non-revoked tokens per user. |

## Rate limiting

The component does not declare a per-route limit; the global `@fastify/rate-limit` (`server.ts`, 1200/min, keyed on `ip + steam_id64`) covers Bearer requests because `req.user.steamId64` is set the same way as for cookie sessions.
