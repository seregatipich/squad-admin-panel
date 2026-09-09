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

## Security headers

`headers()` in [`apps/web/next.config.mjs`](../../../apps/web/next.config.mjs) sets `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` on every route. The base policy (`default-src 'self'`) needs `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'` because Next's App Router injects inline hydration `<script>` tags and the app uses React inline `style={{...}}` attributes in places — a stricter policy without `'unsafe-inline'` blanks the page. `/servers/:id/configs` gets its own `Content-Security-Policy`, still same-origin only, which adds two directives the base policy does not need: `font-src 'self' data:` (Monaco inlines its codicon icon font as a `data:` URI — without this it falls back to `default-src 'self'`, which refuses `data:` and leaves every editor icon a blank box) and `worker-src 'self' blob:` (Monaco starts its language workers from blob URLs).

The Monaco bundle itself is **not** loaded from a CDN. [`apps/web/scripts/sync-monaco.mjs`](../../../apps/web/scripts/sync-monaco.mjs) copies the pinned `monaco-editor` dependency's AMD build into `apps/web/public/monaco/vs` before `next dev` and `next build`, and the page points `@monaco-editor/loader` at `/monaco/vs`. It used to fetch from `https://cdn.jsdelivr.net`, which made the editor unusable for any operator whose network cannot reach that CDN: the page rendered normally but the editor pane hung on `Loading...` forever, because the AMD loader never resolved and `@monaco-editor/react` surfaces no timeout. `public/monaco/` is generated, git-ignored, and listed as a `build` output in `turbo.json` so the Turbo cache restores it.

Both policies are built in `next.config.mjs` and differ on exactly one directive: outside production, `script-src` also carries `'unsafe-eval'`. `next dev` compiles client chunks with an eval-based devtool, so without it the browser blocks the Next.js runtime itself — chunks download with 200s, nothing executes, and every page sits on its unhydrated server fallback emitting only a `securitypolicyviolation` event. `next build` emits no `eval`, so the production policy is unchanged byte-for-byte; [`apps/web/test/headers.test.ts`](../../../apps/web/test/headers.test.ts) asserts both branches. The switch reads `NODE_ENV` per `headers()` call; no other env var is involved.
