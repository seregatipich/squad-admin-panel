# Conventions

Project-wide conventions for structure, language choices, commit style, and invariants that every contributor must follow.

## Monorepo layout

```
apps/
  api/              Fastify 5 + Zod type-provider (REST + WebSocket)
  web/              Next.js 15 App Router
  bridge/           Go 1.25.11+ privileged host daemon
  workers/
    rcon/           RCON supervisor + Redis Stream publisher
    log-ingest/     docker logs tail → event parser → Redis Streams
    audit-archiver/ cold-archive job for audit_log
    event-partition/monthly Postgres partition rotation
    metrics-sampler/host metrics sampler → host:metrics stream
packages/
  shared-types/     Zod schemas + EventEnvelope discriminated union
  shared-config/    Permission registry, bridge-method allowlist, heartbeat util
  db/               Drizzle schema + SQL migrations
  bridge-client/    TypeScript client for the Go bridge socket
docker/             Dockerfiles (api, web, worker, squad-server, depot-init) + Caddyfile
scripts/            install-host-bridge.sh, verify-bridge.sh, verify-audit-chain.ts
docs/               architecture/, components/, operations/, development/
```

`apps/` contains runnable services. `packages/` contains shared libraries with no runtime process of their own. Never import an `apps/` package from another `apps/` package — cross-service communication goes through Redis Streams, the REST API, or the bridge socket.

## Language choices

| Area | Language / Runtime | Version |
|---|---|---|
| API, workers, packages | TypeScript | Node 22, TSC strict mode |
| Web | TypeScript + React | Node 22, Next.js 15 |
| Host daemon | Go | 1.25, `CGO_ENABLED=0` static binary |

The Go bridge is the only non-TS code. Everything else — including scripts — is TypeScript.

## TypeScript configuration

`tsconfig.base.json` at the repo root is the shared base. All packages extend it. Key compiler flags:

- `strict: true`, `noImplicitAny`, `strictNullChecks`, `noImplicitReturns`
- `noUnusedLocals`, `noUnusedParameters` — unused identifiers are compile errors.
- `noUncheckedIndexedAccess` — array index access returns `T | undefined`.
- `verbatimModuleSyntax` — import type annotations must be explicit.
- `module: ESNext`, `moduleResolution: Bundler`.

Type errors are blockers. Do not use `// @ts-ignore` or `as unknown as T` casts except in generated code or test scaffolding where there is no alternative.

## Package manager

pnpm 9.15 (pinned via `packageManager` in `package.json`). Never use npm or yarn in this repo. Workspace protocol: `workspace:*` for cross-package dependencies.

### Security overrides (`pnpm.overrides`)

An entry added to `pnpm.overrides` to close a Dependabot alert that a parent package won't move on its own must name the alert(s) it closes and the condition under which it can be removed:

- `postcss: ^8.5.23` — `next@15.5.x` pins `postcss` to an exact `8.4.31` in every published release including `latest`; `vite@6.4.2` / `@tailwindcss/postcss@4.2.4` independently resolve `8.5.10`. Both are below the fix for GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 and GHSA-qx2v-qp2m-jg93 (Dependabot alerts #9, #88, #90 — see #237). Remove once `next`'s own `dependencies.postcss` moves past `8.5.23` on its own (check with `npm view next dependencies.postcss`).
- `sharp: ^0.35.3` — forces `next`'s `optionalDependencies: sharp ^0.34.3` past GHSA-f88m-g3jw-g9cj (alert #78 — see #236). Remove under the same condition once `next` bundles a fixed `sharp` on its own.

## Build orchestration

Turbo (`turbo.json`) orchestrates builds, type checks, and tests across all packages. Common commands:

```bash
pnpm turbo run typecheck      # tsc --noEmit across all packages
pnpm turbo run test           # vitest + go test (excludes e2e)
pnpm turbo run build          # per-service dist/
pnpm turbo run test --force   # bypass Turbo cache
```

## UI language

The UI is in **Russian**. All user-visible strings (labels, headings, error messages, button text, empty-state copy) must be written in Russian. Do not translate to English unless the user explicitly requests it.

## API conventions

- Framework: Fastify 5 with `@fastify/type-provider-zod`. All route schemas are Zod objects.
- Every POST/PUT/PATCH/DELETE route that mutates state **must** include `config: { audit: { action, resource } }`. The `audit-coverage.test.ts` integration test fails the suite for any mutating route that omits this.
- Route files live in `apps/api/src/routes/`. One file per resource group.
- Plugin decorators (bridge, redis, db, auth) are registered in `apps/api/src/plugins/`.
- Permission checks use `app.requirePermission(req, 'permission:key')` — never inline the RBAC logic in a route handler.

## Three-tier testing model

| Tier | What it tests | Location | Runner |
|---|---|---|---|
| 1 — unit | Pure functions, parsers, validators | `apps/api/test/*.test.ts`, `apps/bridge/internal/**/*_test.go`, `packages/**/test/` | `pnpm turbo run test` |
| 2 — integration | Full Fastify instance via `inject()`, fake bridge, real/ephemeral Postgres + Redis | `apps/api/test/*.test.ts` | `pnpm --filter @squad/api test` |
| 3 — e2e | Live panel stack: real bridge, Docker containers, RCON, config edits | `apps/api/test/e2e/` | `pnpm --filter @squad/api test:e2e` |

E2e tests are excluded from `pnpm turbo run test` on purpose — they require a live host.

A change is not complete until the relevant tier is green. "Works on manual retry" is not a passing test.

## Bridge-method allowlist invariant

Three sources must be kept in sync whenever a bridge RPC method is added, renamed, or removed:

1. `packages/shared-config/src/bridge-methods.ts` — TS constant and type.
2. `packages/bridge-client/src/client.ts` — typed method wrappers.
3. `apps/bridge/internal/handlers/handlers.go` — Go dispatch map.

Keep the `validate.*` allowlist in the Go handler tight. Add an e2e test case covering the success path and the forbidden path (path/image allowlist violation) in `apps/api/test/e2e/bridge-rpc.e2e.test.ts`.

## Commit style

Format: `<type>(<scope>): <subject>` — lowercase, imperative mood, no trailing period.

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.

Scope is the affected package or area: `api`, `web`, `bridge`, `workers`, `db`, `rbac`, `web/roles`, `api/auth`, etc.

Examples from this repo:

```
feat(api/routes): permissions/roles/users CRUD, single-role assign, drop M:N
fix(web/servers/new): cyrillic→latin slug auto-gen + readable validation errors
test(api/integration): adapt harness and tests to single-role / no-orgs RBAC model
docs(rbac): component dir + decision record + cross-references
refactor(api): drop remaining orgId references after multi-tenancy removal
```

Commit early and often. After every logical chunk (a new file, a passing test, a bug fix), commit immediately. Do not accumulate large diffs.

## Pre-commit hooks (lefthook)

Defined in `lefthook.yml`. Run automatically after `pnpm install`.

| Hook | Trigger | What it does |
|---|---|---|
| `biome-check` | `*.ts`, `*.tsx`, `*.js`, `*.json`, `*.css` staged | `biome check` on staged files. Fails on lint or format errors. |
| `go-fmt` | `apps/bridge/**/*.go` staged | `gofmt -l -s .` + `go vet ./...`. Fails on format violations or vet errors. |
| `gitleaks` | All staged files | Scans for secrets. Warns only — does not block the commit. |

Pre-push hooks run `pnpm turbo run typecheck` and `pnpm turbo run test`. Both must be green before pushing.

Never bypass hooks with `--no-verify` unless explicitly instructed.

## Documentation

All project documentation lives under `docs/`. After every code change, check whether the documentation needs to be updated. A task is not complete until documentation matches the final code.

See `CLAUDE.md` (project root) for the full documentation workflow and required structure.

## See also

- [`docs/development/code-style.md`](./code-style.md) — formatting, naming, and lint rules.
- [`docs/development/testing.md`](./testing.md) — test tiers, how to run, definition of done.
- [`docs/development/local-development.md`](./local-development.md) — first-run setup and useful commands.
- [`docs/architecture/decisions.md`](../architecture/decisions.md) — record of architectural choices.
