# Squad Admin Panel — documentation

Open-source, self-hosted control panel for Squad dedicated servers. Owns the full destructive lifecycle: install, update, start/stop, live config editing, log/event ingestion, audit, **soft-delete with mandatory config backup**, and **restore from archive**. Each Squad server runs as its own Docker container; the panel is `docker compose up -d` on a single Linux host. Live status (server, container, RCON, bridge connectivity) is pushed over a single authenticated WebSocket so the UI never feels stale.

## Table of contents

### Architecture

- [**Architecture map**](architecture/map.md) — short verified overview: repository layout, privilege boundary, API, workers, messaging, database
- [Architecture summary](architecture/README.md) — three privilege zones, component diagram, constraints
- [System overview](architecture/system-overview.md) — privilege zones, components, bird's-eye view
- [Data flow](architecture/data-flow.md) — install flow, event pipeline, RCON loop
- [RBAC](architecture/rbac.md) — permission keys, system roles, enforcement
- [Security](architecture/security.md) — threat model, secrets, attack surface
- [Decisions](architecture/decisions.md) — meaningful architectural choices

### Components

- [`api`](components/api/README.md) — Fastify HTTP/WebSocket
- [`api-tokens`](components/api-tokens/README.md) — Bearer auth + per-user API tokens
- [`live-bus`](components/live-bus/README.md) — typed WebSocket push channel + Redis pub/sub fan-out
- [`web`](components/web/README.md) — Next.js dashboard ([design system](components/web/design-system.md))
- [`bridge`](components/bridge/README.md) — Go host daemon (the only privileged component)
- [`rbac`](components/rbac/README.md) — permission registry, roles, enforcement
- [`workers`](components/workers/README.md) — the worker fleet, one directory per documented worker
- [`db`](components/db/README.md) — Drizzle schema + Postgres migrations
- [`diag`](components/diag/README.md) — `@squad/diag` panel-internal diagnostic event emitter (Redis Stream `diag:queue`)
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
- [Local test setup](development/local-test-setup.md) — isolated, migrated test database; env vars; API test rules
- [Testing](development/testing.md) — unit / integration / e2e tiers
- [Conventions](development/conventions.md) — monorepo layout, language choices, commit style, invariants
- [Code style](development/code-style.md) — formatting, naming, imports, Biome config
- [CI gate and pre-check](development/ci.md) — the `ci` workflow on `master`, SHA pinning, `test:cov`, the pre-push checklist
- [Dev stand and promotion](development/deploy.md) — stand deploy, rollback, fast-forward promotion
- [Completion evidence](development/completion-evidence.md) — issue evidence comments and the parallel-wave handoff
- [Agent enforcement harness](development/agent-harness.md) — branch-model guards, runners, deploy pipeline, troubleshooting
- [Solving issues in parallel](development/solve-issues-parallel.md) — `pnpm solve:issues` with Claude Managed Agents

### Open design specs

- [RNSquadJS migration](superpowers/specs/2026-04-24-rnsquadjs-migration-design.md) — sidecar cutover; fleet rollout and cleanup phases are still open
- [Diagnostic bundle and panel disk breakdown](superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md) — the disk breakdown shipped; the diagnostic bundle endpoint is not implemented

Specs and plans of shipped work are removed; git history keeps them.

## Maintenance rules

`docs/` is part of the source of truth. Every change to code, schema, configuration, or workflow must land with the matching documentation update in the same task. The policy is the "Documentation" rule in [CLAUDE.md](../CLAUDE.md#documentation); new docs are linked from the table of contents above.

When code and docs disagree, **the code wins** — but the doc must be updated to match in the same change. Never document behavior that does not exist.
