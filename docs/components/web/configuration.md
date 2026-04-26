# `web` — configuration

## Environment variables

The web container exposes a tiny surface — most config is reached via the API.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `NEXT_PUBLIC_API_BASE` | no | `/api/v1` | client + server | API root, normally same-origin via Caddy. | no |
| `NEXT_PUBLIC_APP_NAME` | no | `Squad Admin Panel` | client | Header / title. | no |
| `NODE_ENV` | no | `production` (in image) | server | `next start` mode. | no |

## Tailwind

`@tailwindcss/postcss` is wired through PostCSS in [`apps/web/postcss.config.mjs`](../../../apps/web/postcss.config.mjs). No `tailwind.config.{js,ts}` — Tailwind 4 uses the `@theme` block in [`apps/web/src/styles/globals.css`](../../../apps/web/src/styles/globals.css).

## Locale

UI strings are Russian. Don't machine-translate when editing copy unless asked.

## Listening port

`next start --port 3000` inside the container. Caddy proxies `/` (excluding `/api/*` and the WebSocket upgrade routes) to that port over the internal compose network.

## Live-bus WebSocket

The dashboard opens a single `wss://${origin}/api/v1/ws/live` socket (singleton in [`apps/web/src/lib/live-bus.ts`](../../../apps/web/src/lib/live-bus.ts)). No env var configures it — the URL is derived from `window.location`. Caddy already forwards the upgrade headers; no proxy change required.
