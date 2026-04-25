# `bridge` — testing

## Where the tests live

| Tier | Location | What it covers |
|---|---|---|
| Unit (Go) | `apps/bridge/internal/**/*_test.go` | Validators (paths, image names, ufw args), wire framing, peer-cred checks, error mapping. |
| Integration (TS) | [`apps/api/test/install-ws.test.ts`](../../../apps/api/test/install-ws.test.ts), `bridge-coverage.test.ts` | API → fake bridge plumbing: which RPCs the install flow calls, in what order, with what args. |
| E2E | [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) | Real bridge over the actual socket. Every method's success path AND its forbidden path. 10–30 s. |
| Smoke | [`scripts/verify-bridge.sh`](../../../scripts/verify-bridge.sh) | Operator smoke after install: hits all 17 methods, prints `forbidden` / `ok` table. |

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
