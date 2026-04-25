# `shared-types` — Zod schemas and types

Single source of truth for cross-component contracts. Importable from anywhere in the workspace as `@squad/shared-types`.

## Responsibilities

- The canonical `EventEnvelope` and per-`type` payload schemas (Redis Streams contract).
- Auth-related DTOs (login request, session detail).
- Server / install / config / RCON-status DTOs used by both API and web.

## Files

- [`packages/shared-types/src/events.ts`](../../../packages/shared-types/src/events.ts) — `EventEnvelope`, `EVENT_TYPES`, per-type payload schemas.
- `packages/shared-types/src/auth.ts` — Steam OpenID session and player DTOs.
- `packages/shared-types/src/servers.ts` — server DTOs, install WS frame schemas.
- `packages/shared-types/src/configs.ts` — cfg list + version + diff response shapes.

## Usage

```ts
import { eventEnvelope, type EventEnvelope } from '@squad/shared-types';

const parsed = eventEnvelope.parse(redisFrame);
```

## See also

- [Data model](data-model.md) — the full event envelope and currently-defined types.
