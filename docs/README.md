# Squad Admin Panel — documentation

Open-source, self-hosted control panel for Squad dedicated servers. Owns the full destructive lifecycle: install, update, start/stop, live config editing, log/event ingestion, audit, **soft-delete with mandatory config backup**, and **restore from archive**. Each Squad server runs as its own Docker container; the panel is `docker compose up -d` on a single Linux host. Live status (server, container, RCON, bridge connectivity) is pushed over a single authenticated WebSocket so the UI never feels stale.

## Table of contents

### Architecture

- [System overview](architecture/system-overview.md) — privilege zones, components, bird's-eye view
- [Data flow](architecture/data-flow.md) — install flow, event pipeline, RCON loop
- [RBAC](architecture/rbac.md) — permission keys, system roles, enforcement
- [Security](architecture/security.md) — threat model, secrets, attack surface
- [Decisions](architecture/decisions.md) — meaningful architectural choices

### Components

- [`api`](components/api/README.md) — Fastify HTTP/WebSocket
- [`api-tokens`](components/api-tokens/README.md) — Bearer auth + per-user API tokens
- [`live-bus`](components/live-bus/README.md) — typed WebSocket push channel + Redis pub/sub fan-out
- [`web`](components/web/README.md) — Next.js dashboard
- [`bridge`](components/bridge/README.md) — Go host daemon (the only privileged component)
- [`workers`](components/workers/README.md) — RCON, log-ingest, archiver, partitioner, stubs
- [`db`](components/db/README.md) — Drizzle schema + Postgres migrations
- [`shared-types`](components/shared-types/README.md) — Zod schemas + `EventEnvelope`
- [`shared-config`](components/shared-config/README.md) — permission keys, bridge-method allowlist
- [`bridge-client`](components/bridge-client/README.md) — TS client for the Go bridge

### Operations

- [Setup](operations/setup.md) — first-time install on a host
- [Deployment](operations/deployment.md) — container topology, image rebuild, update procedure
- [Environment variables](operations/environment-variables.md) — `.env` reference
- [Migrations](operations/migrations.md) — Drizzle migration workflow, forward-only policy, DB reset
- [Monitoring](operations/monitoring.md) — logs stream, metrics stream, worker liveness, audit chain
- [Troubleshooting](operations/troubleshooting.md) — common operator-level issues

### Development

- [Local development](development/local-development.md) — clone-to-running-stack
- [Testing](development/testing.md) — unit / integration / e2e tiers
- [Conventions](development/conventions.md) — monorepo layout, language choices, commit style, invariants
- [Code style](development/code-style.md) — formatting, naming, imports, Biome config

## Maintenance rules

`docs/` is part of the source of truth. Every change to code, schema, configuration, or workflow must land with the matching documentation update in the same task. The full policy lives in [CLAUDE.md](../CLAUDE.md#documentation-system).

When code and docs disagree, **the code wins** — but the doc must be updated to match in the same change. Never document behavior that does not exist.
