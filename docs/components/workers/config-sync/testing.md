# worker-config-sync — Testing

## Running tests

```bash
# Unit tests (pure, no infra)
pnpm --filter @squad/worker-config-sync exec vitest run test/segment.test.ts

# Contract tests (need Redis + DB + the dist/ build)
pnpm --filter @squad/worker-config-sync build
REDIS_URL=redis://127.0.0.1:6379/14 \
  DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin \
  pnpm --filter @squad/worker-config-sync test
```

## Test files

All tests live under `apps/workers/config-sync/test/`.

### `segment.test.ts` — unit (pure)

Covers the deterministic generator, parser, and splicer in `src/segment.ts`:

| Test | What it verifies |
|---|---|
| `Group=` per role with squad perms; `Admin=` per assignment | sort order (role, then steam_id64), exclusion of roles with 0 perms |
| CRLF line endings | `\r\n` only inside the segment, no stray `\n\n` |
| Stable sha256 across permutations | hash invariant when input order changes |
| Empty body with markers | works for first-sync (no roles, no admins) |
| Optional `// commentary` after `Admin=` line | for P1 comment support |
| `findManagedSegment` | returns null when no markers, finds the slice when present |
| `spliceManagedSegment` | replaces in place, prepends to non-empty file with no markers, leaves outside-segment bytes untouched |
| `hashSegment` | 64-char lowercase hex |

### `contract.test.ts` — subprocess

Spawns `dist/index.js` with a real Redis (DB 14) and a real Postgres test DB; verifies:

- `worker:heartbeat:config-sync` key appears within 30 s of start with TTL ≤ 30 s.
- SIGTERM causes exit code 0 within 5 s.

## Integration coverage from API side

Cross-component coverage that the API publishes the right events:

- `apps/api/test/integration/roles-and-access.test.ts > admins-cfg sync stream is published on role mutations` — asserts `XLEN events:admins-cfg-sync:<server_id> ≥ 1` after `POST /api/v1/roles`.
- The API permission-matrix tests guard that `/api/v1/admins-cfg/drift` and `/api/v1/admins-cfg/drift/all` require `admin_group:view`, while `/api/v1/admins-cfg/sync` requires `admin_group:edit`.

## What is explicitly NOT covered yet

- An e2e test that spawns the worker and verifies a real `Admins.cfg` write through the bridge — would require the bridge socket. Tier-3 e2e (`apps/api/test/e2e/install-lifecycle.e2e.test.ts`) covers the install path through the bridge but does not yet assert managed-segment content; this is a follow-up.
- A test that intentionally corrupts the file outside the markers and asserts the worker leaves those bytes alone after a sync — covered indirectly by `spliceManagedSegment` unit tests, but not end-to-end.
- An XAUTOCLAIM regression test that simulates a crashed prior consumer (manually adds a PEL entry under a stale consumer name, runs the reclaim pass, asserts the entry moves) — would tighten the spec §2.7.7 retry guarantee. Currently the reclaim path is exercised only by a real failed-bridge scenario.

## Important edge cases the unit tests guard

- A role with 0 squad permissions does NOT emit an `Admin=` line for any of its members (it's panel-only).
- Players with `role_id = NULL` are absent from the managed segment.
- Empty file (first-sync) produces a segment-only file ending with `\r\n`.
- Re-running with identical inputs produces an identical hash → no write happens.
