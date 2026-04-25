# `web` — testing

## Where the tests live

| Tier | Location | Status |
|---|---|---|
| Unit | `apps/web/src/**/__tests__/` (none yet) | `pnpm --filter @squad/web test` is wired with `--passWithNoTests`. Component-level Vitest tests will land with the first non-trivial client-side logic. |
| E2E | not yet present | Playwright is in `package.json` (`test:e2e` script) but no spec files have landed. The user-facing flows are covered by [`apps/api/test/e2e/install-lifecycle.e2e.test.ts`](../../../apps/api/test/e2e/install-lifecycle.e2e.test.ts) at the API layer for now. |

## How to run

```bash
pnpm --filter @squad/web test         # Vitest (passes with no tests today)
pnpm --filter @squad/web test:e2e     # Playwright (no specs yet)
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
