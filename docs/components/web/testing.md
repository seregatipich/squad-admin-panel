# `web` — testing

## Where the tests live

| Tier | Location | Status |
|---|---|---|
| Property | `apps/web/test/property/` | Active. `@fast-check/vitest` fuzz tests for pure utility modules. |
| Unit | `apps/web/src/lib/*.test.ts`, `apps/web/test/*.test.ts`, `apps/web/src/app/**/*.test.tsx` | Active. Vitest unit tests for `api`, `dal`, `format`, `host-health`, `live-bus`, `use-live-bus`, `ws-backoff`, middleware, and page component validation. |
| E2E | `apps/web/e2e/` | Active. 7 critical-page specs + live-refresh + server-detail + server-logs-resilience suites. Run with `pnpm --filter @squad/web test:e2e` against a live stack. |

## Unit tests

### `src/lib/api.test.ts` (9 tests)
Tests `apiFetch<T>`: URL construction from `API_URL` env var (default `http://api:3000`), `accept: application/json` header, `cache: no-store`, `cookie` header forwarding, `content-type` header injection for body requests, and error throwing with `"API <path> <status>: <text>"` on non-ok responses. Mocks `globalThis.fetch`.

### `src/lib/dal.test.ts` (8 tests)
Tests the server-side DAL: `SESSION_COOKIE` constant equals `__Host-sid`, `getSession` returns a `Me` object when session cookie is present, returns `null` on missing cookie and on `apiFetch` failure, and `requireSession` returns `Me` or throws with `NEXT_REDIRECT:/login`. Mocks `server-only`, `next/headers`, `next/navigation`, `./api`, and `react.cache`.

### `src/lib/live-bus.test.ts` (8 tests)
Tests the SSR no-op stub returned by `getLiveBus()` when `window` is undefined: `state()` returns `'closed'`, `bridgeState()` returns `'unknown'`, `subscribe`/`onStateChange`/`onBridgeChange` each return a callable unsubscribe, `retain` returns a callable release, and `forceReconnect` does not throw.

### `src/lib/use-live-bus.test.ts` (3 tests)
Validates that `useLiveSubscription`, `useLiveBusState`, and `useBridgeState` are exported as functions without invoking them outside a React render context.

### `test/middleware.test.ts` (10 tests)
Tests the Next.js middleware redirect logic using a mocked `next/server` and fake `NextRequest` objects. Covers: unauthenticated redirect from `/dashboard` and `/servers/:id` (verifying `307` status and `?next=<path>`), redirect target is `/login`, authenticated pass-through, public path pass-through, and all 5 `config.matcher` patterns.

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
pnpm --filter @squad/web test                                  # Vitest (all test files)
pnpm --filter @squad/web exec vitest run test/property/        # property tests only
PLAYWRIGHT_BASE_URL=https://squad-panel.lan \
  pnpm --filter @squad/web test:e2e                            # all Playwright specs
PLAYWRIGHT_BASE_URL=https://squad-panel.lan \
  pnpm --filter @squad/web exec playwright test e2e/login.spec.ts  # single spec
```

## E2E spec inventory (`apps/web/e2e/`)

| File | Coverage |
|---|---|
| `_fixtures.ts` | `ownerPage` / `unauthedPage` fixtures — DB-seeds a player with Owner role + creates a session token directly in Postgres + Redis, no Steam OAuth required. |
| `login.spec.ts` | Steam button render, `auth_failed` error param, `not_authorized` + steam_id64 display. |
| `dashboard.spec.ts` | Owner sees full sidebar nav, heading visible, unauthed redirects to /login. |
| `servers-new.spec.ts` | Cyrillic→latin slug auto-gen, form field render, API error message display. |
| `roles.spec.ts` | All 5 roles listed, Owner Системная badge, Owner has no delete button. |
| `users.spec.ts` | Table renders with Owner row; assign-role modal opens/closes and renders a locale-independent date-only expiry plus explained comment. |
| `player-detail.spec.ts` | Profile section and PanelAccessSection are visible for Owner; the inline role editor uses the same date-only expiry contract. |
| `auth.spec.ts` | Steam button on login, dashboard → /login redirect. |
| `live-refresh.spec.ts` | 9 polling surfaces verified without page reload (a–i). |
| `server-detail-live.spec.ts` | LiveIndicator tick/reset on server detail. |
| `server-logs-resilience.spec.ts` | Log WS: live pill, pre-install copy, error-banner retry. |
| `disk-breakdown.spec.ts` | Dashboard `[data-testid="disk-card"]` click opens `<DiskBreakdownModal>` (`role="dialog"` named «Что занимает панель»), «Всего:» and «По типу» sections render, refresh button («Обновить») drives `cache_age_seconds` to 0 (text «обновлено 0 сек назад»), Escape and backdrop click both close the dialog. |

## Auth fixture design

The `seedOwner` helper in `helpers.ts` creates test isolation without Steam OAuth:

1. Inserts a `players` row with `role_id` = Owner role UUID.
2. Mints a `s_<uuidv7>_<random>` session token, stores its SHA-256 in `sessions`.
3. Caches the session in Redis (`session:<tokenId>`) with 24h TTL.
4. Returns `{ uid: steam_id64, token }` — the raw token is set as `__Host-sid` cookie.
5. `teardownOwner` revokes all sessions, nulls `role_id`, and attempts player deletion (silently skips if audit_log FK prevents it).

## What is covered

- `apiFetch` URL/header/error behaviour (unit, 9 tests).
- DAL `getSession` + `requireSession` happy and error paths (unit, 8 tests).
- Next.js middleware redirect logic for all 5 protected path prefixes (unit, 10 tests).
- `getLiveBus` SSR stub interface (unit, 8 tests).
- `useLiveSubscription`, `useLiveBusState`, `useBridgeState` export presence (unit, 3 tests).
- All 7 highest-leverage pages verified against the live stack (E2E, 19 tests).
- Pre-existing breakage repaired: `auth.spec.ts`, `live-refresh.spec.ts`, `server-detail-live.spec.ts`, `server-logs-resilience.spec.ts` were broken by the RBAC migration that removed the `users` table and `org_id` columns.

## What is not yet covered

- Install wizard end-to-end (creates a real Squad container).
- Config editor save → history → restore flow.
- Live log viewer WebSocket on a running server.
- RCON send flow.
- Audit log export.
- Settings page E2E save → verify round-trip (covered by unit component-validation test; E2E pending).
- API tokens pages.
- Archive / restore wizard UI flow (covered at the API layer by `server-delete-restore-lifecycle.e2e.test.ts`; UI flow remains a manual smoke until a Playwright spec lands).

These are covered at the API layer in `apps/api/test/e2e/install-lifecycle.e2e.test.ts` and `apps/api/test/e2e/server-delete-restore-lifecycle.e2e.test.ts`.

## Important edge cases

- Cookies are `__Host-`-prefixed → Playwright needs HTTPS (`ignoreHTTPSErrors: true` for internal CA).
- The RCON status indicator renders `— (сервер не запущен)` when server is `stopped`.
- `player_name_history` has a unique constraint — `ON CONFLICT DO NOTHING` in seedPlayer.
- Deleting a test player may fail if `audit_log.actor_steam_id64` has a FK reference. `teardownOwner` swallows this and leaves the player tombstoned with `role_id=NULL`.
