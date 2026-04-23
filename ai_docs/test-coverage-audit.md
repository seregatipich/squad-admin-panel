# Test Coverage Audit: Squad Admin Panel Monorepo

**Generated:** 2026-04-23  
**Scope:** Complete inventory of testable units vs. existing test coverage  
**Goal:** Identify gaps and produce implementation plan for full coverage

---

## Executive Summary

The monorepo spans **35 API source files**, **20 web pages**, **20 Go bridge packages**, **33 worker source files**, and **75 package source files** — totaling ~180 meaningful testable modules. Current test suite includes:

- **24 test files** (9 integration, 3 E2E, 12 unit)
- **Tier 1 (Unit):** 12 files covering isolated logic (parsers, validators, crypto, RCON protocol)
- **Tier 2 (Integration):** 9 files covering routes via `inject()`, WebSocket plumbing, fake bridge  
- **Tier 3 (E2E):** 3 files covering server lifecycle, config versioning, bridge RPC surface

**Critical gaps:** Most routes untested at Tier 2; most web pages lack Playwright tests; several workers are stubs with zero tests; audit trail enforcement is manual; 14 bridge RPC methods have E2E coverage but handlers lack unit tests.

---

## 1. Per-App Source Inventory

### apps/api (35 TS files)

**Routes (12 files, 38+ registered endpoints)**

| Route File | Endpoints | Tests | Status |
|---|---|---|---|
| `routes/auth.ts` | `POST /auth/login`, `POST /auth/logout`, `GET /me`, `POST /me/totp/provision`, `POST /me/totp/enable`, `POST /me/totp/disable` | audit-coverage.test.ts (audit guard only) | **UNTESTED** — no happy-path integration tests |
| `routes/auth-steam.ts` | `GET /auth/steam/login`, `GET /auth/steam/callback` | audit-coverage.test.ts | **UNTESTED** — OAuth callback plumbing not exercised |
| `routes/auth-discord.ts` | `GET /auth/discord/login`, `GET /auth/discord/callback` | audit-coverage.test.ts | **UNTESTED** — OAuth plumbing not exercised |
| `routes/servers.ts` | `GET /servers`, `POST /servers`, `GET /servers/:id`, `POST /servers/:id/start`, `POST /servers/:id/stop`, `POST /servers/:id/restart`, `GET /servers/:id/events`, `DELETE /servers/:id` | audit-coverage.test.ts | **UNTESTED** — CRUD, lifecycle transitions untested |
| `routes/server-configs.ts` | `GET /servers/:id/configs`, `GET /servers/:id/configs/:name`, `PUT /servers/:id/configs/:name`, `GET /servers/:id/configs/:name/history`, `GET /servers/:id/configs/:name/versions/:vid`, `GET /servers/:id/configs/:name/diff`, `GET /servers/:id/configs/:name/blame`, `POST /servers/:id/configs/:name/restore/:vid` | audit-coverage.test.ts, config-rewrite.test.ts | **PARTIAL** — config rewrite logic unit-tested; routes untested |
| `routes/server-install.ts` | `POST /servers/:id/install`, `GET /servers/:id/install/progress`, `GET /servers/:id/install/ws` | audit-coverage.test.ts, install-ws.test.ts | **PARTIAL** — WebSocket plumbing tested; install orchestration untested |
| `routes/server-logs.ts` | `GET /servers/:id/logs/ws` | server-logs.test.ts | **GOOD** — WebSocket fan-out, frame splitting exercised |
| `routes/players.ts` | `GET /players`, `GET /players/:steamId` | audit-coverage.test.ts | **UNTESTED** |
| `routes/audit.ts` | `GET /audit` | audit-coverage.test.ts | **UNTESTED** |
| `routes/host.ts` | `GET /host/info`, `GET /host/metrics`, `GET /host/bridge-status` | audit-coverage.test.ts | **UNTESTED** |
| `routes/depot.ts` | `GET /depot`, `POST /depot/update`, `GET /depot/progress/ws` | audit-coverage.test.ts | **UNTESTED** |
| `routes/setup.ts` | `GET /setup/check-env`, `POST /setup/org`, `POST /setup/owner`, `POST /setup/finalize` | audit-coverage.test.ts | **UNTESTED** |

**Plugins (11 files, core infrastructure)**

| Plugin File | Purpose | Tests | Status |
|---|---|---|---|
| `plugins/auth.ts` | Session/cookie auth, permission enforcement | audit-coverage.test.ts (static route guard) | **UNTESTED** — auth plugin logic not exercised |
| `plugins/database.ts` | Drizzle client setup | none | **UNTESTED** |
| `plugins/redis.ts` | Redis client setup | none | **UNTESTED** |
| `plugins/bridge.ts` | Bridge RPC client factory, connection handling | none | **UNTESTED** |
| `plugins/audit.ts` | Audit log middleware; writes to `audit_log` table | none | **UNTESTED** — audit row persistence not verified |
| `plugins/request-context.ts` | Request scoping (user, IP, etc.) | none | **UNTESTED** |
| `plugins/health.ts` | `/health` readiness probe | none | **UNTESTED** |
| `plugins/metrics.ts` | Prometheus metrics export | none | **UNTESTED** |
| `plugins/install-progress.ts` | WebSocket progress relay for server installs | install-ws.test.ts | **PARTIAL** — basic connectivity tested; progress update logic untested |
| `plugins/status-reconciler.ts` | Polls `container_inspect` every 4s, reconciles `servers.status` | none | **UNTESTED** — reconciliation logic untested |
| `plugins/types.ts` | TypeScript ambient declarations | N/A | N/A |

**Libs (9 files, helper functions)**

| Lib File | Purpose | Tests | Status |
|---|---|---|---|
| `lib/logger.ts` | Pino logger setup | none | **UNTESTED** (infrastructure, low priority) |
| `lib/argon.ts` | Argon2 password hashing | none | **UNTESTED** |
| `lib/crypto.ts` | AES encryption for RCON passwords, session tokens | none | **UNTESTED** |
| `lib/sessions.ts` | Session CRUD (create, revoke, lookup) | none | **UNTESTED** |
| `lib/totp.ts` | TOTP generation, verification, backup codes | none | **UNTESTED** |
| `lib/rbac.ts` | Permission checking, clearance levels | none | **UNTESTED** |
| `lib/audit.ts` | Audit row schema construction, hashing | none | **UNTESTED** |
| `lib/blame.ts` | Myers diff walk, per-line attribution | none | **UNTESTED** |
| `lib/rcon-send.ts` | Single RCON command send with auth | rcon-send.test.ts | **GOOD** — AUTH, timeout, bad-password paths tested |

**Other**

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/config.ts` | Environment loading, validation | none | **UNTESTED** |
| `src/server.ts` | Fastify bootstrap, route registration | none | **UNTESTED** (configuration, low priority) |
| `src/index.ts` | Entry point | none | N/A |

**API Summary:** 
- Routes: 38 endpoints, **0 happy-path integration tests** (only audit guard enforcement tested)
- Plugins: 11 plugins, **1 partially tested** (install-progress), **0 others**
- Libs: 9 utility libs, **2 unit-tested** (rcon-send, config-rewrite)
- **TIER 1 GAPS:** 7 libs untested (argon, crypto, sessions, totp, rbac, audit, blame)
- **TIER 2 GAPS:** 37/38 routes untested; 10/11 plugins untested

---

### apps/web (20 TS/TSX files)

**Pages (13 app router pages)**

| Page | Route | Purpose | Test | Status |
|---|---|---|---|---|
| `app/page.tsx` | `/` | Root redirect / landing | none | **UNTESTED** |
| `app/login/page.tsx` | `/login` | Email/TOTP login form | none | **UNTESTED** |
| `app/setup/page.tsx` | `/setup` | Org + owner onboarding flow | none | **UNTESTED** |
| `app/(dashboard)/dashboard/page.tsx` | `/dashboard` | Home; server list + status | none | **UNTESTED** |
| `app/(dashboard)/servers/page.tsx` | `/servers` | Server listing table | none | **UNTESTED** |
| `app/(dashboard)/servers/new/page.tsx` | `/servers/new` | Server creation form | none | **UNTESTED** |
| `app/(dashboard)/servers/[id]/page.tsx` | `/servers/:id` | Server detail view | none | **UNTESTED** |
| `app/(dashboard)/servers/[id]/configs/page.tsx` | `/servers/:id/configs` | Monaco editor; Редактор/История/Blame tabs | none | **UNTESTED** |
| `app/(dashboard)/servers/[id]/events/page.tsx` | `/servers/:id/events` | Event feed (Redis Streams tail) | none | **UNTESTED** |
| `app/(dashboard)/players/page.tsx` | `/players` | Global player listing | none | **UNTESTED** |
| `app/(dashboard)/players/[steam_id64]/page.tsx` | `/players/:steamId` | Player profile | none | **UNTESTED** |
| `app/(dashboard)/audit/page.tsx` | `/audit` | Audit log table + search | none | **UNTESTED** |
| `app/(dashboard)/settings/account/page.tsx` | `/settings/account` | Password, 2FA (TOTP), backup codes | none | **UNTESTED** |

**Components:** Web app includes client-side components (form handlers, API client, tables, modals) in `src/components/` — **not enumerated here** but all untested.

**Web Summary:**
- **13 pages, 0 Playwright/E2E tests**
- Pages range from read-only (dashboard, audit) to state-mutating (login, server create, config editor)
- **TIER 3 GAPS:** No Playwright test file exists; recommend one test per user-visible flow (minimum 6: login, setup, server CRUD, config edit, player search, audit log browse)

---

### apps/bridge (20 Go files)

**RPC Handlers**

The bridge exports 15 whitelisted methods (per `packages/shared-config/src/bridge-methods.ts`). Handler dispatch in `apps/bridge/internal/handlers/handlers.go`.

| Method | Handler | Unit Test | Integration/E2E | Status |
|---|---|---|---|---|
| `ping` | `handlers.go:ping()` | none | bridge-rpc.e2e.test.ts (success path) | **PARTIAL** |
| `host_info` | `handlers.go:hostInfo()` | none | bridge-rpc.e2e.test.ts (success path) | **PARTIAL** |
| `host_metrics` | `handlers.go:hostMetrics()` | none | bridge-rpc.e2e.test.ts (success path) | **PARTIAL** |
| `process_info` | `handlers.go:processInfo()` | none | not in bridge-rpc.e2e.test.ts | **UNTESTED** |
| `file_read` | `handlers.go:fileRead()` + `validate.go:validateReadablePath()` | none | bridge-rpc.e2e.test.ts (allowlist tests) | **PARTIAL** |
| `file_write` | `handlers.go:fileWrite()` + `validate.go:validateWritablePath()` | none | not in bridge-rpc.e2e.test.ts | **UNTESTED** |
| `file_atomic_write` | `handlers.go:fileAtomicWrite()` + path validation | none | bridge-rpc.e2e.test.ts (forbidden path test) | **PARTIAL** |
| `ufw_rule` | `handlers.go:ufwRule()` + `validate.go:validateUfwRule()` | ufw_test.go (paths allowed) | bridge-rpc.e2e.test.ts (add/remove success) | **GOOD** |
| `container_run` | `handlers.go:containerRun()` + `validate.go:validateContainerRun()` | docker_test.go (image/mount allowlist) | bridge-rpc.e2e.test.ts (image forbid, mount forbid) | **GOOD** |
| `container_start` | `handlers.go:containerStart()` | none | not in bridge-rpc.e2e.test.ts | **UNTESTED** |
| `container_stop` | `handlers.go:containerStop()` | none | not in bridge-rpc.e2e.test.ts | **UNTESTED** |
| `container_rm` | `handlers.go:containerRm()` | none | not in bridge-rpc.e2e.test.ts | **UNTESTED** |
| `container_inspect` | `handlers.go:containerInspect()` | none | bridge-rpc.e2e.test.ts (nonexistent container) | **PARTIAL** |
| `container_logs_follow` | `handlers.go:containerLogsFollow()` + streaming | none | install-lifecycle.e2e.test.ts (implicit; follows logs during install) | **PARTIAL** |
| `depot_update` | `handlers.go:depotUpdate()` + streaming | none | install-lifecycle.e2e.test.ts (implicit; updates depot during install) | **PARTIAL** |

**Validation Packages**

| Package | Purpose | Unit Tests | E2E | Status |
|---|---|---|---|---|
| `validate/paths.go` | Config/saved/depot path allowlisting | paths_test.go (fixtures) | bridge-rpc.e2e.test.ts (integration) | **GOOD** |
| `validate/docker.go` | Container name, image, mount allowlist | docker_test.go (fixtures) | bridge-rpc.e2e.test.ts (integration) | **GOOD** |
| `validate/ufw.go` | UFW rule (proto, port range) validation | ufw_test.go (fixtures) | bridge-rpc.e2e.test.ts (integration) | **GOOD** |
| `validate/errors.go` | Error type definitions | none (infra) | N/A | N/A |

**Core Infrastructure**

| Package | Purpose | Tests | Status |
|---|---|---|---|
| `rpc/frame.go` | Length-prefixed JSON framing, marshaling | frame_test.go (encode/decode) | none | **UNIT OK** |
| `rpc/types.go` | Request/Response types | (covered by frame_test.go) | N/A | N/A |
| `metrics/host.go` | CPU/RAM/disk info + rates | host_test.go (fixtures) | bridge-rpc.e2e.test.ts | **UNIT+E2E OK** |
| `fsx/fsx.go` | File read/write/atomic operations | fsx_test.go (read/write round-trip) | none | **UNIT OK** |
| `runner/docker.go` | Docker CLI wrapper (run, start, stop, rm, inspect, logs) | docker_test.go (image/mount validation) | install-lifecycle.e2e.test.ts | **PARTIAL** — validation tested; CLI invocation not unit-tested |
| `runner/runner.go` | Docker subprocess lifecycle | none | install-lifecycle.e2e.test.ts | **UNTESTED** at unit level |
| `auth/peer.go` | SO_PEERCRED + GID auth | none | (tested implicitly by e2e; requires sgid panel group) | **UNTESTED** in isolation |
| `sysd/ufw.go` | UFW rule addition/removal via ufw CLI | none | bridge-rpc.e2e.test.ts | **UNTESTED** at unit level |

**Bridge Summary:**
- 15 RPC methods: **6 fully exercised** (ping, host_info, host_metrics, ufw_rule, container_run, container_inspect), **6 partially tested** (file_read, file_atomic_write, container_logs_follow, depot_update, container_inspect), **3 untested** (process_info, file_write, container_start, container_stop, container_rm)
- Validation layer: **GOOD** — paths, docker, ufw all have unit + E2E
- Core packages: 7/8 have unit tests; runner subprocess untested at unit level
- **TIER 1 GAPS:** 3 handler methods, runner subprocess, auth/peer, sysd/ufw (need unit tests)
- **TIER 3 GAPS:** Missing E2E cases for process_info, file_write, container_start/stop/rm

---

### apps/workers

**Status by worker (per CLAUDE.md, {automation, backup, config-sync, discord, scheduler, stats} are P0 stubs):**

#### Stub workers (minimal index.ts, zero functionality)

| Worker | Files | Status | Tests |
|---|---|---|---|
| `automation/` | index.ts (stub) | **STUB** | none |
| `backup/` | index.ts (stub) | **STUB** | none |
| `config-sync/` | index.ts (stub) | **STUB** | none |
| `discord/` | index.ts (stub) | **STUB** | none |
| `scheduler/` | index.ts (stub) | **STUB** | none |
| `stats/` | index.ts (stub) | **STUB** | none |

#### Production workers

**rcon/** (Valve-RCON client, keeper of server status)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/supervisor.ts` | Polls ListPlayers (30s) + ShowServerInfo (90s), publishes `rcon:status:{id}` | none | **UNTESTED** |
| `src/client.ts` | RCON socket connection, command queuing | none | **UNTESTED** |
| `src/protocol.ts` | Wire codec (packets, framing) | protocol.test.ts | **GOOD** |
| `src/parse-list-players.ts` | Parser for squad-specific output format | parse-list-players.test.ts | **GOOD** |
| `src/persist.ts` | DB integration (insert poll history) | none | **UNTESTED** |
| `src/index.ts` | Worker entrypoint, heartbeat publish | none | **UNTESTED** |

**log-ingest/** (Docker log tail + regex parser → Redis Streams)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/parser/patterns.ts` | Squad log line regex patterns | patterns.test.ts | **GOOD** |
| `src/parser/ingest.ts` | Event envelope construction | none | **UNTESTED** — pattern matching exercised, envelope logic not |
| `src/tail.ts` | Docker logs -f line processor | none | **UNTESTED** |
| `src/publish.ts` | Redis Streams insertion | none | **UNTESTED** |
| `src/index.ts` | Worker entrypoint, log/publish orchestration | none | **UNTESTED** |

**event-partition/** (Monthly Postgres partition rotation)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Cron job that creates `events_YYYY_MM` partitions | none | **UNTESTED** |

**audit-archiver/** (Cold-archive audit_log rows older than 90d)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Batch archive + delete old audit rows | none | **UNTESTED** |

**Workers Summary:**
- **6 stub workers:** no implementation; testing deferred until P1
- **2 production workers with logic:** rcon (supervisor + client untested; protocol + parser unit-tested), log-ingest (pattern unit-tested; ingest/tail/publish untested)
- **2 cron workers:** event-partition, audit-archiver untested
- **TIER 1 GAPS:** supervisor, client, persist (rcon); ingest, tail, publish (log-ingest); event-partition, audit-archiver
- **TIER 2 GAPS:** No integration tests for worker-to-Redis, worker-to-DB pipelines

---

## 2. Per-Package Source Inventory

### packages/shared-types (3 files)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Shared type exports | none | N/A (re-exports) |
| `src/api.ts` | API input/output Zod schemas | none | **UNTESTED** — schemas not validated |
| `src/events.ts` | EventEnvelope discriminated union | events.test.ts | **GOOD** — discriminant validation |

### packages/shared-config (4 files)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Constants (paths, ports, images) | none | N/A (infra) |
| `src/bridge-methods.ts` | Whitelist of 15 RPC methods | none | N/A (data) |
| `src/permissions.ts` | RBAC permission keys + clearance levels | permissions.test.ts | **GOOD** — key validation |
| `src/heartbeat.ts` | Worker heartbeat TTL utility | none | **UNTESTED** — logic is 2 lines; low priority |

### packages/db (25+ files)

**Schema files** (auto-generated by Drizzle; schema definitions live in `schema/*.ts`)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Schema export | none | N/A (infra) |
| `src/client.ts` | Drizzle client factory | none | **UNTESTED** |
| `src/migrate.ts` | Migration runner | none | **UNTESTED** |
| `src/schema/*.ts` (19 files: users, sessions, servers, roles, audit-log, etc.) | Table definitions | schema.test.ts (sample validation) | **PARTIAL** — sample table constraints exercised; most tables untested |

**Database Summary:**
- **25 files, 1 partial test** (schema.test.ts validates user table constraints; other 18 tables untested)
- **TIER 1 GAPS:** All schema files lack unit tests for constraints (NOT NULL, UNIQUE, FK, triggers)
- **TIER 2 GAPS:** Migration + client initialization untested

### packages/bridge-client (4 files)

| File | Purpose | Tests | Status |
|---|---|---|---|
| `src/index.ts` | Client export + setup | none | N/A (infra) |
| `src/client.ts` | RPC method wrappers (15 methods) | none | **UNTESTED** — request/response marshaling not tested; E2E covers happy paths only |
| `src/frame.ts` | Frame encode/decode | frame.test.ts | **GOOD** — framing tested |
| `src/types.ts` | TypeScript interfaces | none | N/A (types) |

**Bridge-Client Summary:**
- Client wrapper methods untested at unit level; E2E covers success paths only
- **TIER 1 GAPS:** client.ts method wrappers (15 methods)
- **TIER 2 GAPS:** Error handling, decode failures, connection loss

---

## 3. Route-Level Coverage for apps/api

**Master route table (all 38 endpoints):**

| HTTP Method | Path | Audit Tag | Integration Test | Mutation? | Status |
|---|---|---|---|---|---|
| POST | `/auth/login` | ✓ user.login | none | ✓ | **UNTESTED** |
| POST | `/auth/logout` | ✓ user.logout | none | ✓ | **UNTESTED** |
| GET | `/me` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/me/totp/provision` | ✓ user.2fa.provision | none | ✓ | **UNTESTED** |
| POST | `/me/totp/enable` | ✓ user.2fa.enabled | none | ✓ | **UNTESTED** |
| POST | `/me/totp/disable` | ✓ user.2fa.disabled | none | ✓ | **UNTESTED** |
| GET | `/setup/check-env` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/setup/org` | ✓ setup.org | none | ✓ | **UNTESTED** |
| POST | `/setup/owner` | ✓ setup.owner | none | ✓ | **UNTESTED** |
| POST | `/setup/finalize` | ✓ setup.finalize | none | ✓ | **UNTESTED** |
| GET | `/host/info` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/host/metrics` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/host/bridge-status` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/servers` | ✓ server.create | none | ✓ | **UNTESTED** |
| GET | `/servers/:id` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/servers/:id/start` | ✓ server.start | none | ✓ | **UNTESTED** |
| POST | `/servers/:id/stop` | ✓ server.stop | none | ✓ | **UNTESTED** |
| POST | `/servers/:id/restart` | ✓ server.restart | none | ✓ | **UNTESTED** |
| POST | `/servers/:id/install` | ✓ server.install | none | ✓ | **UNTESTED** |
| GET | `/servers/:id/install/progress` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers/:id/install/ws` | ✗ | install-ws.test.ts (partial) | ✓ (streaming) | **PARTIAL** |
| GET | `/servers/:id/logs/ws` | ✗ | server-logs.test.ts | ✗ | **GOOD** |
| GET | `/servers/:id/events` | ✗ | none | ✗ | **UNTESTED** |
| DELETE | `/servers/:id` | ✓ server.delete | none | ✓ | **UNTESTED** |
| GET | `/servers/:id/configs` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers/:id/configs/:name` | ✗ | none | ✗ | **UNTESTED** |
| PUT | `/servers/:id/configs/:name` | ✓ server.config.write | none | ✓ | **UNTESTED** |
| GET | `/servers/:id/configs/:name/history` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers/:id/configs/:name/versions/:vid` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers/:id/configs/:name/diff` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/servers/:id/configs/:name/blame` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/servers/:id/configs/:name/restore/:vid` | ✓ server.config.restore | none | ✓ | **UNTESTED** |
| GET | `/players` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/players/:steamId` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/audit` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/depot` | ✗ | none | ✗ | **UNTESTED** |
| POST | `/depot/update` | ✓ depot.update | none | ✓ | **UNTESTED** |
| GET | `/depot/progress/ws` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/auth/steam/login` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/auth/steam/callback` | ✗ (allowlist) | none | ✓ | **UNTESTED** |
| GET | `/auth/discord/login` | ✗ | none | ✗ | **UNTESTED** |
| GET | `/auth/discord/callback` | ✗ (allowlist) | none | ✓ | **UNTESTED** |
| GET | `/permissions` | ✗ | none | ✗ | **UNTESTED** |

**Key findings:**
- **37/38 endpoints untested** at integration level (via `inject()`)
- **2 WebSocket endpoints** partially tested (install-ws, logs partially; install-progress, depot/progress untested)
- **15 mutating endpoints** (POST/PUT/DELETE) with audit tags; **0 audit row assertions** (except audit guard)
- **11 read endpoints** without audit tags; all untested

---

## 4. Bridge RPC Coverage

**Cross-reference: bridge-methods.ts whitelist ↔ handlers.go ↔ e2e tests**

| Method | Whitelist | Handler | Success Test | Forbidden Test | Status |
|---|---|---|---|---|---|
| ping | ✓ | handlers.go:75 | ✓ e2e:27 | N/A (no params) | **OK** |
| host_info | ✓ | handlers.go:85 | ✓ e2e:34 | N/A (read-only) | **OK** |
| host_metrics | ✓ | handlers.go:94 | ✓ e2e:40 | N/A (read-only) | **OK** |
| process_info | ✓ | handlers.go:53 | ✗ | ✗ | **UNTESTED** |
| file_read | ✓ | handlers.go:117 | ✓ (depot) e2e:50 | ✓ (/etc/passwd) e2e:46 | **OK** |
| file_write | ✓ | handlers.go:139 | ✗ | ✗ | **UNTESTED** |
| file_atomic_write | ✓ | handlers.go:161 | ✗ | ✓ (/etc/shadow) e2e:57 | **FORBIDDEN OK** |
| ufw_rule | ✓ | handlers.go:175 | ✓ e2e:63 | ✓ (proto/port range) ufw_test.go | **OK** |
| container_run | ✓ | handlers.go:215 | ✗ (success path skipped) | ✓ (forbidden image) e2e:84 | **FORBIDDEN OK** |
| container_start | ✓ | handlers.go:237 | ✗ | ✗ | **UNTESTED** |
| container_stop | ✓ | handlers.go:249 | ✗ | ✗ | **UNTESTED** |
| container_rm | ✓ | handlers.go:260 | ✗ | ✗ | **UNTESTED** |
| container_inspect | ✓ | handlers.go:273 | ✓ e2e:76 (nonexistent) | ✗ | **PARTIAL** |
| container_logs_follow | ✓ | handlers.go:284 | ✓ (implicit in e2e:install) | N/A (streaming) | **PARTIAL** |
| depot_update | ✓ | handlers.go:310 | ✓ (implicit in e2e:install) | N/A (streaming) | **PARTIAL** |

**Gap summary:**
- **6/15 methods** fully tested (success + forbidden paths per CLAUDE.md §17.12 rule)
- **4/15 methods** partially tested (success only)
- **5/15 methods** untested (process_info, file_write, container_start/stop/rm)
- **TIER 1 GAPS:** process_info, file_write handlers lack unit tests; container_* handlers lack unit tests
- **TIER 3 GAPS:** Missing success-path E2E for file_write, process_info, container_start/stop/rm, container_run success

---

## 5. Audit-Tagged Routes

**Per audit-coverage.test.ts guards:** every POST/PUT/PATCH/DELETE must declare `config.audit` (either `{action, resource}` or explicit `false`).

**Current audit tags (23 mutating routes):**

| Route | Action | Resource | Test Coverage |
|---|---|---|---|
| POST `/auth/login` | user.login | session | **none** |
| POST `/auth/logout` | user.logout | session | **none** |
| POST `/me/totp/provision` | user.2fa.provision | user | **none** |
| POST `/me/totp/enable` | user.2fa.enabled | user | **none** |
| POST `/me/totp/disable` | user.2fa.disabled | user | **none** |
| POST `/setup/org` | setup.org | organization | **none** |
| POST `/setup/owner` | setup.owner | user | **none** |
| POST `/setup/finalize` | setup.finalize | installation | **none** |
| POST `/servers` | server.create | server | **none** |
| POST `/servers/:id/start` | server.start | server | **none** |
| POST `/servers/:id/stop` | server.stop | server | **none** |
| POST `/servers/:id/restart` | server.restart | server | **none** |
| POST `/servers/:id/install` | server.install | server | **none** |
| PUT `/servers/:id/configs/:name` | server.config.write | server | **none** |
| POST `/servers/:id/configs/:name/restore/:vid` | server.config.restore | server | **none** |
| DELETE `/servers/:id` | server.delete | server | **none** |
| POST `/depot/update` | depot.update | depot | **none** |

**Audit enforcement:** audit-coverage.test.ts **enforces tagging** (CI guard passes) but **does NOT test** that `audit_log` rows are actually written. Requires:
- Integration tests asserting `SELECT * FROM audit_log WHERE action=$1 AND resource=$2` returns a row
- User context (req.user.id, req.ip) properly captured in row
- Request/response metadata serialized
- Consecutive rows hash-chain verified (per CLAUDE.md audit invariant)

**TIER 2 GAPS:** No integration tests asserting audit row persistence for any route.

---

## 6. Web Pages / Flows

**User-visible flows (13 pages, 0 Playwright tests)**

| Page/Flow | Auth | Components | Critical Path | E2E Test | Status |
|---|---|---|---|---|---|
| **Login** (`/login`) | no | email input, TOTP input, submit | Email + TOTP capture, session creation | **NONE** | **CRITICAL** |
| **Setup** (`/setup`) | no | org name, owner email/password forms | Organization + user onboarding | **NONE** | **CRITICAL** |
| **Dashboard** (`/dashboard`) | ✓ owner | Server list table, real-time status (Redis poll) | View running servers, player count, RCON state | **NONE** | **HIGH** |
| **Server List** (`/servers`) | ✓ | Table, create button | List, filter, quick actions | **NONE** | **HIGH** |
| **Create Server** (`/servers/new`) | ✓ | Form (port config, max players, etc.) | Server insert, status=pending | **NONE** | **CRITICAL** |
| **Server Detail** (`/servers/:id`) | ✓ | Info card, status widget, action buttons (start/stop/restart/delete) | View settings, trigger container lifecycle | **NONE** | **HIGH** |
| **Config Editor** (`/servers/:id/configs`) | ✓ | Monaco (3 tabs: Редактор, История, Blame) | Read file, edit, commit, view diff, restore, blame | **NONE** | **CRITICAL** |
| **Events** (`/servers/:id/events`) | ✓ | Event feed (Streams tail, real-time) | View RCON status, task logs | **NONE** | **MEDIUM** |
| **Players** (`/players`) | ✓ | Global player listing, search | View all seen players, last seen times | **NONE** | **LOW** |
| **Player Detail** (`/players/:steamId`) | ✓ | Profile, servers joined, IP history | View player across servers | **NONE** | **LOW** |
| **Audit Log** (`/audit`) | ✓ | Table, date range filter, action search | View historical actions, verify chain | **NONE** | **MEDIUM** |
| **Account Settings** (`/settings/account`) | ✓ | Password change, TOTP enable/disable, backup codes | User account mutations | **NONE** | **MEDIUM** |

**Web Summary:**
- **0 Playwright test files** (playwright.config.ts not present)
- **13 pages, 0 tested**
- **4 critical flows** (login, setup, server create, config edit) driving server lifecycle; untested
- **TIER 3 GAPS:** Entire web layer; recommend ≥ 6 Playwright tests (login, setup, server CRUD, config edit, key state-driven flows)

---

## 7. Test Infrastructure

### Tier 1 (Unit) — Vitest + Go Test

| Config File | Location | Purpose | Coverage |
|---|---|---|---|
| `vitest.config.ts` | apps/api | Vitest runner config; exclude `test/e2e/**` | Unit + integration tests |
| `vitest.config.ts` | apps/workers/rcon, log-ingest | Vitest per-worker | Worker unit tests |
| `vitest.config.ts` | packages/* | Vitest per-package | Schema, crypto, parser unit tests |
| `go test` runner | apps/bridge/Makefile | `go test -race -count=1 ./...` | Bridge validation + infrastructure |

**Tier 1 assumes:**
- Vitest: no DB/Redis (in-memory fakes)
- Go: no Docker, no UFW, no real FS (fixtures + mocks)

### Tier 2 (Integration) — Fastify inject()

| Config File | Location | Tests | Infrastructure |
|---|---|---|---|
| `vitest.config.ts` | apps/api (default) | 9 files under `test/*.test.ts` (server-logs, install-ws, rcon-send, config-rewrite, event-dlq-autoclaim, audit-coverage, smoke, etc.) | Fake bridge (onStream callbacks); real or ephemeral DB/Redis not currently used |

**Tier 2 assumes:**
- Fastify instance via `app.register()` + `app.inject()`
- Fake bridge client (callbacks for streaming)
- No real Squad container
- No real DB (tests currently use stubs; could use ephemeral Postgres)

### Tier 3 (E2E) — vitest.e2e.config.ts

| Config File | Location | Tests | Infrastructure |
|---|---|---|---|
| `vitest.e2e.config.ts` | apps/api | 3 files under `test/e2e/*.e2e.test.ts` (bridge-rpc, install-lifecycle, config-versioning) | Real panel-host-bridge socket; real Docker daemon; real Postgres; real Redis; real Squad container (install-lifecycle only) |

**Tier 3 assumes:**
- `docker compose up -d` running
- Bridge active on `/run/panel-host-bridge.sock`
- Depot volume populated (`depot_update` takes ~25 min first run)
- Valid owner session cookie in `PANEL_TEST_COOKIE` env var
- 15 min global timeout, serial test execution

**Test configs summary:**

| Tier | Scope | Infrastructure | Run Command |
|---|---|---|---|
| 1 | Unit | In-memory, fakes | `pnpm turbo run test` (all packages) |
| 2 | Integration | Fake bridge, real app | `pnpm --filter @squad/api test` (9 files) |
| 3 | E2E | Real stack | `pnpm --filter @squad/api test:e2e` (requires setup) |

---

## 8. Existing Test Files (Complete Inventory)

### Tier 1 (Unit)

| File | Scope | Tests | Purpose |
|---|---|---|---|
| `apps/api/test/smoke.test.ts` | API startup | 1 test | Server builds without error (sanity check) |
| `apps/api/test/config-rewrite.test.ts` | Lib | 6 tests | rewriteRconCfg / rewriteServerCfg port + name substitution |
| `apps/api/test/rcon-send.test.ts` | Lib | 3 tests | rconSendOnce: auth, bad password, connect timeout |
| `apps/api/test/event-dlq-autoclaim.test.ts` | Lib | 6 tests | EventDLQ claim + unclaim logic |
| `apps/workers/rcon/test/protocol.test.ts` | Worker | 3 tests | RCON packet encode/decode; stream buffering |
| `apps/workers/rcon/test/parse-list-players.test.ts` | Worker | 5 tests | Squad output parser (player count, teams) |
| `apps/workers/log-ingest/test/patterns.test.ts` | Worker | 8 tests | SquadGame.log regex patterns (spawn, wound, etc.) |
| `apps/bridge/internal/fsx/fsx_test.go` | Go | 6 tests | File read/write/atomic; edge cases |
| `apps/bridge/internal/metrics/host_test.go` | Go | 2 tests | CPU/RAM/disk info + rate calculation |
| `apps/bridge/internal/rpc/frame_test.go` | Go | 4 tests | JSON frame marshal/unmarshal; size limits |
| `apps/bridge/internal/validate/paths_test.go` | Go | 10 tests | Allowlist matching (configs, saved, depot) |
| `apps/bridge/internal/validate/docker_test.go` | Go | 6 tests | Image + mount allowlist; image regex |
| `apps/bridge/internal/validate/ufw_test.go` | Go | 5 tests | UFW proto/port validation |
| `packages/shared-types/test/events.test.ts` | Package | 2 tests | EventEnvelope discriminant, type narrowing |
| `packages/shared-config/test/permissions.test.ts` | Package | 4 tests | Permission key structure, clearance levels |
| `packages/db/test/schema.test.ts` | Package | 1 test | User table constraints (sample) |
| `packages/bridge-client/test/frame.test.ts` | Package | 4 tests | Frame length prefix encode/decode |

**Tier 1 Total: 12 files, 76 tests** covering isolated logic (parsers, validators, crypto, codecs).

### Tier 2 (Integration)

| File | Routes/Components | Tests | Purpose |
|---|---|---|---|
| `apps/api/test/install-ws.test.ts` | `GET /servers/:id/install/ws` | 3 tests | WebSocket handshake + progress frame fan-out (fake progress source) |
| `apps/api/test/server-logs.test.ts` | `GET /servers/:id/logs/ws` | 3 tests | WebSocket log fan-out; multi-line frame splitting; stream routing (stdout/stderr) |
| `apps/api/test/audit-coverage.test.ts` | Route registration static guard | 2 tests | Every POST/PUT/PATCH/DELETE has `config.audit` tag; audit:false limited to allowlist |

**Tier 2 Total: 3 files, 8 tests** covering route + plugin plumbing (WebSocket, injection, auth, audit tagging).

### Tier 3 (E2E)

| File | Scope | Tests | Infrastructure |
|---|---|---|---|
| `apps/api/test/e2e/bridge-rpc.e2e.test.ts` | Bridge RPC surface (15 methods) | 9 tests | Hits `/run/panel-host-bridge.sock` directly; validates method allowlists + path validation |
| `apps/api/test/e2e/install-lifecycle.e2e.test.ts` | Server lifecycle (install → running → stop → delete) | 1 test (17 assertions) | Real docker, Squad boot, RCON auth, config edit, graceful stop |
| `apps/api/test/e2e/config-versioning.e2e.test.ts` | Config editor (version history, blame, diff, restore) | 4 tests | Real DB, config file read/write, sha256 tracking, diff computation |

**Tier 3 Total: 3 files, 14 tests** covering critical paths (bridge RPC, server install, config editor).

**Grand total: 24 test files, ~100 tests.**

---

## 9. Gaps Summary (Ranked by Critical Path Impact)

### Tier 2 (Integration) — Biggest Gaps

**1. POST /auth/login — no integration test**
- Critical path: user authentication entry point
- Risk: password verification, TOTP/backup code logic, session creation, cookie handling untested
- Estimate: 1 test file (auth.test.ts), 8–12 test cases

**2. POST /servers — no integration test**
- Critical path: server CRUD entry point
- Risk: DB transaction, RCON password generation, settings insert untested
- Estimate: 1 test file (servers.test.ts), 10–15 cases

**3. POST /servers/:id/install — no integration test**
- Critical path: install orchestration via WebSocket
- Risk: depot validation, config seeding, bridge container_run contract untested
- Estimate: covered by E2E but needs integration variant (faster feedback)

**4. PUT /servers/:id/configs/:name — no integration test**
- Critical path: config editing, version creation, audit row assertion
- Risk: sha256 tracking, version insert, blame cache invalidation untested at integration level
- Estimate: 1 test file (server-configs.test.ts), 6–10 cases

**5. All auth plugins (auth.ts, audit.ts) — not exercised**
- Risk: permission enforcement, audit middleware, session lookup untested
- Estimate: 1 test file (plugins.test.ts), 8–12 cases

**6. All remaining routes (25+ read endpoints, 3+ setup routes)**
- Risk: permission enforcement, response schema validation, DB query correctness untested
- Estimate: 2–3 test files (host.test.ts, players.test.ts, audit.test.ts, setup.test.ts), 25–40 cases

### Tier 1 (Unit) — Secondary Gaps

**7. Crypto lib (argon.ts, crypto.ts, sessions.ts, totp.ts)**
- Risk: password hashing, AES encryption, TOTP generation untested at unit level
- Estimate: 1 test file (crypto-libs.test.ts), 12–16 cases

**8. RBAC lib (rbac.ts) — permission checking logic**
- Risk: clearance levels, permission set union untested
- Estimate: 1 test file (rbac.test.ts), 6–8 cases

**9. Blame computation (blame.ts) — attribution walk**
- Risk: Myers diff, line attribution logic untested
- Estimate: 1 test file (blame.test.ts), 6–10 cases

**10. Audit row construction (audit.ts) — schema + hashing**
- Risk: row serialization, hash chain construction untested
- Estimate: 1 test file (audit.test.ts), 4–6 cases

**11. Database schema constraints (db/schema/*.ts)**
- Risk: foreign keys, NOT NULL, UNIQUE, triggers untested
- Estimate: expand schema.test.ts, 20–30 cases

**12. Bridge RPC handlers (file_write, process_info, container_start/stop/rm)**
- Risk: Handler implementations lack unit tests; E2E may not catch edge cases
- Estimate: 1 test file (handlers.test.go), 12–16 cases

### Tier 3 (E2E) — Tertiary Gaps

**13. Web pages (Playwright) — 13 pages untested**
- Critical flows: login, setup, server create, config editor
- Estimate: 1 playwright.config.ts + 1–2 e2e test files (login.spec.ts, server.spec.ts, etc.), 6–10 tests

**14. Missing E2E methods (5 bridge RPC untested success paths)**
- process_info, file_write, container_start/stop/rm
- Estimate: expand bridge-rpc.e2e.test.ts, 5–8 assertions

**15. Worker integration (rcon supervisor, log-ingest tail/publish)**
- Risk: worker-to-Redis, worker-to-DB pipelines untested
- Estimate: 1–2 test files (worker-integration.test.ts), 8–12 cases

**16. Stub workers (when P1) — automation, backup, config-sync, discord, scheduler, stats**
- Deferred until feature implementation
- Estimate: 6+ test files (one per worker), 40+ cases total

---

## 10. Implementation Roadmap (By Tier)

### Tier 1 (Unit) — 40–60 hours

**Priority 1 (critical path crypto):**
1. `apps/api/test/crypto-libs.test.ts` — argon2 password hash/verify, AES encrypt/decrypt, session creation, TOTP generation
2. `apps/api/test/lib.test.ts` — blame diff walk, rbac clearance, audit row schema, config validation
3. Expand `packages/db/test/schema.test.ts` — add constraints for all 19 tables (FKs, NOT NULL, UNIQUE, triggers)

**Priority 2 (bridge infrastructure):**
1. `apps/bridge/internal/handlers/handlers_test.go` — 5 untested methods (process_info, file_write, container_start/stop/rm)
2. Expand route-handler tests in bridge (runner, auth/peer)

**Priority 3 (packages):**
1. `packages/bridge-client/test/client.test.ts` — RPC method wrappers (15 methods), error handling

### Tier 2 (Integration) — 50–80 hours

**Priority 1 (critical routes):**
1. `apps/api/test/auth.test.ts` — POST /login (happy path, bad credentials, TOTP, backup codes), POST /logout, /me, TOTP endpoints
2. `apps/api/test/servers.test.ts` — POST /servers (create), GET /servers (list), GET /servers/:id, lifecycle (start/stop/restart), DELETE
3. `apps/api/test/server-configs.test.ts` — GET/PUT configs, history, diff, blame, restore; audit row assertions
4. `apps/api/test/setup.test.ts` — setup flow (org + owner), /check-env, /finalize

**Priority 2 (remaining routes):**
1. `apps/api/test/host.test.ts` — /host/info, /host/metrics, /host/bridge-status
2. `apps/api/test/players.test.ts` — /players, /players/:steamId
3. `apps/api/test/audit.test.ts` — /audit log querying
4. `apps/api/test/depot.test.ts` — /depot, /depot/update, /depot/progress/ws

**Priority 3 (plugins):**
1. `apps/api/test/plugins.test.ts` — auth plugin (session lookup, permission enforcement), audit middleware (row insertion), request context

### Tier 3 (E2E) — 20–30 hours

**Priority 1 (web critical paths):**
1. `apps/web/playwright.config.ts` — Playwright runner config
2. `apps/web/tests/e2e/auth.spec.ts` — login flow (email + TOTP/backup codes)
3. `apps/web/tests/e2e/server.spec.ts` — server CRUD (create → start → edit config → stop → delete)

**Priority 2 (web secondary flows):**
1. `apps/web/tests/e2e/setup.spec.ts` — onboarding (org + owner)
2. `apps/web/tests/e2e/audit.spec.ts` — audit log browsing + filter
3. `apps/web/tests/e2e/players.spec.ts` — player list + search

**Priority 3 (bridge + workers):**
1. Expand `apps/api/test/e2e/bridge-rpc.e2e.test.ts` — add 5 untested methods (success + forbidden paths)
2. `apps/api/test/e2e/worker-integration.e2e.test.ts` — rcon supervisor polling + log-ingest tail (if time permits)

---

## 11. Route-by-Route Detail: Integration Test Gaps

### Routes needing POST/PUT/DELETE + audit row assertion:

**Auth routes (6 mutating):**
- POST `/auth/login` — assert session in DB + cache, cookie set
- POST `/auth/logout` — assert session revoked
- POST `/me/totp/provision` — assert TOTP secret encrypted in DB
- POST `/me/totp/enable` — assert lastUsedStep updated
- POST `/me/totp/disable` — assert secret nulled
- POST `/setup/org` — assert org row inserted, audit row written

**Server routes (8 mutating):**
- POST `/servers` — assert server + settings + credentials rows inserted, audit row written
- POST `/servers/:id/start` — assert RCON start command sent, audit row written, status reconciliation triggered
- POST `/servers/:id/stop` — assert RCON stop command sent, audit row written
- POST `/servers/:id/restart` — assert RCON stop + start, audit row written
- POST `/servers/:id/install` — assert depot check, config seed, container_run call, audit row written
- PUT `/servers/:id/configs/:name` — assert file written via bridge, version inserted, sha256 stored, blame cache invalidated, audit row written
- POST `/servers/:id/configs/:name/restore/:vid` — assert new version created with old content, audit row written
- DELETE `/servers/:id` — assert row deleted, container_rm called, audit row written

**Depot routes (1 mutating):**
- POST `/depot/update` — assert depot_update called, audit row written

---

## 12. Summary Statistics

| Metric | Count | Status |
|---|---|---|
| **Total source files** | ~180 | — |
| **Total test files** | 24 | ~13% coverage |
| **Routes (API)** | 38 | 0% integration tested (audit guard only) |
| **Web pages** | 13 | 0% E2E tested |
| **Bridge RPC methods** | 15 | 6 fully tested, 4 partially, 5 untested |
| **Worker modules** | 10 (6 stubs, 4 prod) | 2 unit-tested, 8 untested |
| **Lib/utility modules** | 30+ | 4 unit-tested, 26+ untested |
| **Plugins** | 11 | 0 fully tested, 1 partially |
| **Estimated effort (full coverage)** | 120–170 hours | — |
| **Recommended per-tier effort** | T1: 50h, T2: 70h, T3: 25h | Phased implementation |

---

## 13. High-Level Implementation Strategy

### Phase 1: Tier 1 (Unit) — Weeks 1–2

Focus: Crypto libs + database schema constraints. Highest ROI (fast tests, unlock integration).

1. Create `apps/api/test/crypto-libs.test.ts` — 16 tests (argon, crypto, sessions, totp)
2. Create `apps/api/test/lib.test.ts` — 10 tests (blame, rbac, audit, misc)
3. Expand `packages/db/test/schema.test.ts` — 25 tests (all table constraints)
4. Create `apps/bridge/internal/handlers/handlers_test.go` — 16 tests (5 untested methods)

**Files:** 4 new/expanded, **~70 tests**, ~50 hours

### Phase 2: Tier 2 (Integration) — Weeks 3–5

Focus: Critical routes first (auth, servers, configs, setup). Use real DB for ✓ assertions.

1. Create `apps/api/test/auth.test.ts` — 12 tests (login, logout, TOTP, 2FA)
2. Create `apps/api/test/servers.test.ts` — 15 tests (CRUD, lifecycle, ✓ audit rows)
3. Create `apps/api/test/server-configs.test.ts` — 10 tests (edit, history, restore, ✓ audit + version rows)
4. Create `apps/api/test/setup.test.ts` — 8 tests (org + owner, env check, finalize)
5. Create `apps/api/test/plugins.test.ts` — 12 tests (auth enforcement, audit middleware)
6. Create remaining route tests (host, players, audit, depot) — 30 tests across 4 files

**Files:** 6 new, **~87 tests**, ~70 hours

### Phase 3: Tier 3 (E2E) — Weeks 6–7

Focus: Web critical paths + bridge methods. Requires running stack.

1. Create `apps/web/playwright.config.ts` + runner setup
2. Create `apps/web/tests/e2e/auth.spec.ts` — login flow
3. Create `apps/web/tests/e2e/server.spec.ts` — server CRUD
4. Create `apps/web/tests/e2e/setup.spec.ts` — onboarding
5. Expand bridge-rpc.e2e.test.ts — 5 untested methods

**Files:** 4 new, **~20 tests**, ~25 hours

### Phase 4: Polish + Validation — Week 8

1. Run full suite (`pnpm turbo run test` + `pnpm --filter @squad/api test:e2e`)
2. Measure coverage (`nyc` or vitest built-in)
3. Document any discovered architectural gaps
4. Update CLAUDE.md testing section

**Expected outcome:** >80% coverage on critical paths; all audit-tagged routes have ✓ assertions; all web user flows have Playwright tests.

---

## Appendix: File Paths Reference

### API Sources
```
apps/api/src/
  routes/          (12 files: auth, servers, configs, install, logs, audit, players, host, depot, setup)
  plugins/         (11 files: auth, db, redis, bridge, audit, request-context, health, metrics, install-progress, status-reconciler, types)
  lib/             (9 files: logger, argon, crypto, sessions, totp, rbac, audit, blame, rcon-send)
  config.ts
  server.ts
  index.ts
```

### Web Sources
```
apps/web/src/
  app/
    page.tsx         (root landing)
    layout.tsx
    login/page.tsx
    setup/page.tsx
    (dashboard)/
      layout.tsx
      dashboard/page.tsx
      servers/page.tsx, new/page.tsx, [id]/page.tsx, [id]/configs/page.tsx, [id]/events/page.tsx
      players/page.tsx, [steam_id64]/page.tsx
      audit/page.tsx
      settings/account/page.tsx
  components/      (client components, API client, etc.)
```

### Bridge Sources
```
apps/bridge/internal/
  handlers/handlers.go     (15 RPC method dispatch)
  rpc/                     (frame.go, types.go — framing)
  validate/                (paths.go, docker.go, ufw.go, errors.go — allowlists)
  fsx/fsx.go               (file operations)
  metrics/host.go          (CPU/RAM/disk)
  runner/                  (docker.go, runner.go)
  auth/peer.go             (SO_PEERCRED)
  sysd/ufw.go              (UFW CLI wrapper)
```

### Worker Sources
```
apps/workers/
  rcon/src/                (supervisor.ts, client.ts, protocol.ts, parse-list-players.ts, persist.ts)
  log-ingest/src/          (index.ts, tail.ts, publish.ts, parser/patterns.ts, parser/ingest.ts)
  {event-partition,audit-archiver,automation,backup,config-sync,discord,scheduler,stats}/src/index.ts
```

### Package Sources
```
packages/
  shared-types/src/        (index.ts, api.ts, events.ts)
  shared-config/src/       (index.ts, bridge-methods.ts, permissions.ts, heartbeat.ts)
  db/src/                  (index.ts, client.ts, migrate.ts, schema/*.ts [19 files])
  bridge-client/src/       (index.ts, client.ts, frame.ts, types.ts)
```

### Test Sources
```
apps/api/test/
  *.test.ts                (8 integration files)
  e2e/*.e2e.test.ts        (3 E2E files)

apps/bridge/internal/
  */*_test.go              (7 Go unit files)

apps/workers/*/test/
  *.test.ts                (3 worker unit files)

packages/*/test/
  *.test.ts                (4 package unit files)
```

