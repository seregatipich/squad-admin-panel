# `bridge` — testing

## Where the tests live

| Tier | Location | What it covers |
|---|---|---|
| Unit (Go) | `apps/bridge/internal/**/*_test.go` | Validators (paths, image names, ufw args), wire framing, peer-cred checks, error mapping. |
| Integration (TS) | [`apps/api/test/install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts), `bridge-coverage.test.ts` | API → fake bridge plumbing: which RPCs the install flow calls, in what order, with what args. |
| E2E | [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) | Real bridge over the actual socket. Every method's success path AND its forbidden path. 10–30 s. |
| Smoke | [`scripts/verify-bridge.sh`](../../../scripts/verify-bridge.sh) | Operator smoke after install: hits all 19 methods, prints `forbidden` / `ok` table. |

## How to run

```bash
# Go unit tests (fast)
cd apps/bridge && go test -race -count=1 ./...

# Lint + vet (also enforced by lefthook)
cd apps/bridge && go vet ./...
gofmt -l -s .   # nothing should print

# Vulnerability scan (CI gate)
cd apps/bridge && govulncheck ./...

# Integration via the API suite
pnpm --filter @squad/api test

# E2E (requires live bridge + docker on the host)
pnpm --filter @squad/api test:e2e

# Smoke
sg panel -c 'bash scripts/verify-bridge.sh'
```

## What is covered

- Every method's allowlist edge cases (paths outside roots, image not in allowlist, container-name regex misses).
- Peer-cred check: connections from outside the `panel` group are rejected before the first frame is read.
- Wire framing: oversized frame drops the connection; partial frames are buffered.
- Stream multiplexing: `container_logs_follow` and `depot_update` interleave `stream:'stdout'` chunks with the final response.
- `directory_delete`: forbidden paths (`/etc/passwd`, `…/ServerConfig/Server.cfg`, `…/configs/../etc`, `…/configs/not-a-uuid`), idempotent miss (`removed:false` for absent dir), invalid JSON → `invalid_args`. Go unit tests in `apps/bridge/internal/handlers/handlers_test.go` and validator tests in `apps/bridge/internal/validate/docker_test.go`. E2E success and forbidden cases in `apps/api/test/e2e/bridge-rpc.e2e.test.ts` `describe('directory_delete (e2e)')`.
- `panel_disk_usage`: three Go unit tests in [`apps/bridge/internal/handlers/handlers_test.go`](../../../apps/bridge/internal/handlers/handlers_test.go) cover the full surface with stubbed `du`/`statfs`/`docker df` injectors:
  - `TestPanelDiskUsage_AllowlistedAndComputed` — populates a tempdir with one configs file (100 B) and one saved file (250 B), asserts every result field including the `total_panel_bytes` formula (no double-counting of the depot volume) and `host_total_bytes = Blocks*Bsize`, `host_used_bytes = (Blocks-Bavail)*Bsize`.
  - `TestPanelDiskUsage_CachesWithinTTL` — calls the handler twice; asserts `du`/`statfs`/`docker df` are invoked exactly once and that `computed_at` is byte-identical between the two responses.
  - `TestPanelDiskUsage_MissingDirsReturnZero` — empty tempdir; asserts the response is `OK` with all zero byte counters and `saved_per_server == []`.
  - E2E coverage in [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts):
    - `panel_disk_usage returns a sane shape against the live host` — calls `bridge.panelDiskUsage()` and asserts `host_total_bytes > 0`, `total_panel_bytes >= 0`, `host_used_bytes >= total_panel_bytes - 1024` (statvfs rounding slop), array shape for `saved_per_server`/`docker_volumes`/`docker_images`, parseable `computed_at`, and `cache_age_seconds ∈ [0, 360)`.
    - `panel_disk_usage caches results — two calls share computed_at and advance cache_age_seconds` — second call after a 1.1 s sleep returns the same `computed_at` and a strictly larger `cache_age_seconds`. There is no meaningful "forbidden" path: the handler takes no params and ignores any client-supplied object.

## What is not covered

- `depot_update` is exercised end-to-end only on a host with internet egress to Steam CDN and ~25 min budget. The CI job uses a stubbed `squad-panel/depot-init` image.
- `host_agent_restart` is excluded from automated suites because restarting the bridge under test would kill the test runner's connection. Verified manually.

## Mocks and stubs

- API integration tests declare an inline fake bridge in each file that needs one (e.g. [`server-logs.test.ts`](../../../apps/api/test/server-logs.test.ts), [`bridge-heartbeat.test.ts`](../../../apps/api/test/bridge-heartbeat.test.ts), [`install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts)) — records calls, returns scripted responses.
- The Docker CLI itself is real in unit tests (a temp container is created and torn down) — there is no `docker` mock.

## Important edge cases

- `container_logs_follow` MUST be invoked over a per-WebSocket bridge connection (see [flows.md](flows.md#live-log-streaming)).
- A bridge-client decode error must NOT set `closed=true` (see [flows.md](flows.md#decode-error--connection-loss)).
- `depot_update` writes into the shared `squad-depot` volume; concurrent calls are serialized by Steam itself (the inner `steamcmd` holds an exclusive flock). The bridge does not add its own mutex.
