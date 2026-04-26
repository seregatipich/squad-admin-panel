# `web` — testing

## Where the tests live

| Tier | Location | Status |
|---|---|---|
| Property | `apps/web/test/property/` | Active. `@fast-check/vitest` fuzz tests for pure utility modules. |
| Unit | `apps/web/src/**/__tests__/` (none yet) | `pnpm --filter @squad/web test` is wired with `--passWithNoTests`. Component-level Vitest tests will land with the first non-trivial client-side logic. |
| E2E | not yet present | Playwright is in `package.json` (`test:e2e` script) but no spec files have landed. The user-facing flows are covered by [`apps/api/test/e2e/install-lifecycle.e2e.test.ts`](../../../apps/api/test/e2e/install-lifecycle.e2e.test.ts) at the API layer for now. |

## Property-based tests

`apps/web/test/property/slug.test.ts` — 4 properties exercised against `nameToSlug` and `sanitizeSlug` in `_slug.ts`:

| Property | Assertion |
|---|---|
| `nameToSlug always produces empty or API-valid slug` | output matches `/^[a-z0-9][a-z0-9-]{0,63}$/` or is empty |
| `sanitizeSlug never starts with a dash` | first character is never `-` |
| `sanitizeSlug never exceeds 64 chars` | length ≤ 64 |
| `already-valid latin slugs round-trip through nameToSlug unchanged` | idempotent for slugs not containing trailing dashes |

## How to run

```bash
pnpm --filter @squad/web test                     # Vitest (all test files)
pnpm --filter @squad/web exec vitest run test/property/   # property tests only
pnpm --filter @squad/web test:e2e                 # Playwright (no specs yet)
```

## What is covered today

The user-visible flows are covered transitively by the API e2e suite (install lifecycle, config edit, RCON status). When Playwright specs land they should cover at minimum:

- Steam login button → OpenID redirect → callback → dashboard redirect.
- `/no-access` page shown for player with no role.
- Install wizard happy path.
- Config editor save → new history row → restore-as-new.
- Live log viewer subscription.

## Important edge cases (when adding tests)

- Cookies are `__Host-`-prefixed → Playwright needs HTTPS (set `ignoreHTTPSErrors: true` for the dev internal CA).
- The RCON status indicator must render `— (сервер не запущен)` when the server is `stopped`.
