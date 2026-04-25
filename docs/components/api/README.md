# `api` — Fastify HTTP/WebSocket service

Fastify 5 + Zod type-provider. REST under `/api/v1/*`, WebSocket for install streaming and live logs. Owns auth, RBAC, audit, install orchestration, status reconciliation.

## Responsibilities

- Auth: Steam OpenID 2.0 (only login method). Cookie sessions keyed on `players.steam_id64`. Sliding TTL with throttled DB touch.
- RBAC: every authed route declares its permissions in `config.permissions`. The `preHandler` hook returns 401/403 accordingly.
- Audit: every mutation route declares `config.audit`; audit rows are hash-chained and append-only (DB triggers reject `UPDATE`/`DELETE`).
- Install orchestration: WebSocket flow under `POST /api/v1/servers/:id/install` that drives `bridge.depot_update` → `seedConfigs` → `bridge.ufw_rule` → `bridge.container_run`.
- Status reconciliation: [`plugins/status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts) polls `container_inspect` every 4 s.
- Worker liveness: aggregates `worker:heartbeat:{name}` Redis keys for `/api/v1/health/workers`.

## What this component does NOT do

- It does not talk RCON or parse Squad logs — those are workers.
- It does not render UI — `web` does.
- It does not write to the host filesystem directly — the bridge does.

## Code location

- Entrypoint: [`apps/api/src/index.ts`](../../../apps/api/src/index.ts) → [`server.ts`](../../../apps/api/src/server.ts) registers routes and plugins.
- Routes: [`apps/api/src/routes/`](../../../apps/api/src/routes/) — `audit.ts`, `auth-steam.ts`, `depot.ts`, `host.ts`, `host-actions.ts`, `players.ts`, `server-configs.ts`, `server-install.ts`, `server-logs.ts`, `servers.ts`, `setup.ts`.
- Plugins: [`apps/api/src/plugins/`](../../../apps/api/src/plugins/) — `auth.ts`, `bridge.ts`, `audit.ts`, `status-reconciler.ts`, `rate-limit.ts`, `swagger.ts`.
- Libs: [`apps/api/src/lib/`](../../../apps/api/src/lib/) — `blame.ts` (Myers diff for config blame), `crypto.ts`, `seed-configs.ts`.

## Dependencies

- Fastify 5.2 + `fastify-type-provider-zod` 4 + Zod 3.24
- `@fastify/cookie/cors/helmet/rate-limit/websocket/swagger(-ui)`
- Auth/crypto: `@oslojs/crypto|encoding`, `arctic` 3 (OpenID 2.0)
- Logs/metrics: `pino` 9, `prom-client` 15
- Redis: `ioredis` 5; HTTP egress: `undici` 8
- DB: `drizzle-orm` 0.45 via `@squad/db`

## Components that depend on it

- [`web`](../web/README.md) — every dashboard page polls or subscribes to API endpoints.
- External integrations (Discord webhook, future Prometheus scraper).

## Components it depends on

- [`bridge`](../bridge/README.md) — every privileged action.
- [`db`](../db/README.md) — sole writer to the operational schema.
- Redis — sessions, rate-limit, event streams, blame cache, worker heartbeats.
- [`shared-types`](../shared-types/README.md), [`shared-config`](../shared-config/README.md), [`bridge-client`](../bridge-client/README.md).

## Basic usage

```bash
pnpm --filter @squad/api dev          # tsx watch src/index.ts
curl -k https://admin.localhost/health
```

## See also

- [API reference](api.md)
- [Configuration](configuration.md) — env vars, ports, plugin tunables.
- [Flows](flows.md) — install WebSocket sequence, status reconciler loop.
- [Testing](testing.md) — three tiers (unit, integration, e2e).
- [Changelog](changelog.md)
