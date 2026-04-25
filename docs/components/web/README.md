# `web` — Next.js dashboard

Next.js 15 (App Router) + React 19 + Tailwind CSS 4. UI is in Russian. Server components handle auth gates; client components do polling and live updates over WebSocket.

## Responsibilities

- Dashboard pages: `/dashboard`, `/servers`, `/servers/:id`, `/servers/:id/configs`, `/servers/:id/logs`, `/players`, `/audit`, `/account`, `/setup`.
- Auth screens: login, TOTP enrollment / challenge, OIDC return.
- Install wizard for new Squad servers.
- Monaco-based config editor with three tabs (Editor / History / Blame).
- Live log viewer over `/api/v1/servers/:id/logs` WebSocket.

## What this component does NOT do

- It does not call the bridge directly — it goes through `api`.
- Next.js middleware never authorises. The real gate is server-side `requireSession()` inside `src/app/(dashboard)/layout.tsx`, deduped via `react.cache()`. This is intentional after CVE-2025-29927.

## Code location

- App Router: [`apps/web/src/app/`](../../../apps/web/src/app/) — `(dashboard)/`, `login/`, `setup/`.
- Components: [`apps/web/src/components/`](../../../apps/web/src/components/).
- Auth helper: `apps/web/src/app/(dashboard)/layout.tsx` calls `requireSession()`.

## Key components

| File | Purpose |
|---|---|
| `MetricHistoryChart.tsx` | Recharts `AreaChart` that renders a 24h series for cpu / ram / disk (% axis) or net (KB/s axis, two areas: rx + tx). Loaded lazily — never imported at module level. |
| `MetricHistoryChart.tsx` (exported types) | `MetricKey` (`'cpu'\|'ram'\|'disk'\|'net'`), `MetricPoint` (one decoded row). |
| `MetricHistoryModal.tsx` | Backdrop modal that fetches `/api/v1/host/metrics/history?seconds=86400`, decodes via `unpackHostMetrics`, then lazy-loads `MetricHistoryChart` via `next/dynamic`. Supports ESC / backdrop-click to close. |

## Dependencies

- `next` 15.1, `react` 19, `react-dom` 19
- `tailwindcss` 4 + `@tailwindcss/postcss`
- `@monaco-editor/react` 4.7
- `recharts` 3 — used only inside `MetricHistoryChart`; split into its own JS chunk via `next/dynamic`
- Tests: `@playwright/test` 1.59, `vitest` 3 (only `--passWithNoTests` is wired today)

## Components that depend on it

- Operators in their browsers.

## Components it depends on

- [`api`](../api/README.md) — every page is data-driven by REST or WebSocket.
- [`shared-types`](../shared-types/README.md), [`shared-config`](../shared-config/README.md) — Zod schemas, permission keys, hot-reload table.

## Basic usage

```bash
pnpm --filter @squad/web dev          # next dev --port 3000
```

In compose, Caddy serves the prebuilt `next start` output.

## See also

- [Configuration](configuration.md)
- [Testing](testing.md)
