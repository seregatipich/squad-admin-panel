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

`headers()` in [`apps/web/next.config.mjs`](../../../apps/web/next.config.mjs) sets `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` on every route. `Content-Security-Policy` is built per request by [`apps/web/src/middleware.ts`](../../../apps/web/src/middleware.ts) with [`apps/web/src/lib/csp.ts`](../../../apps/web/src/lib/csp.ts): every page gets a fresh nonce and `script-src 'self' 'nonce-<n>'` — no `'unsafe-inline'` for scripts (#60, finding 424), so injected `<script>` tags and `onerror=` handlers do not run. Middleware sets the policy on the forwarded request too; Next.js reads the nonce from there and stamps it on its inline hydration scripts. That only happens at request time, so the root layout exports `dynamic = 'force-dynamic'` and no page is prerendered — a prerendered page would ship its hydration scripts without a nonce and never hydrate. The middleware matcher covers every path except `/api`, `/health`, `/ready`, `/_next/static`, `/_next/image`, `/favicon.ico` and router prefetches. `style-src 'self' 'unsafe-inline'` stays because the app uses React inline `style={{...}}` attributes, which cannot carry a nonce. `/servers/:id/configs` gets a policy that adds two directives the base policy does not need: `font-src 'self' data:` (Monaco inlines its codicon icon font as a `data:` URI — without this it falls back to `default-src 'self'`, which refuses `data:` and leaves every editor icon a blank box) and `worker-src 'self' blob:` (Monaco starts its language workers from blob URLs).

The Monaco bundle itself is **not** loaded from a CDN. [`apps/web/scripts/sync-monaco.mjs`](../../../apps/web/scripts/sync-monaco.mjs) copies the pinned `monaco-editor` dependency's AMD build into `apps/web/public/monaco/vs` before `next dev` and `next build`, and the page points `@monaco-editor/loader` at `/monaco/vs`. It used to fetch from `https://cdn.jsdelivr.net`, which made the editor unusable for any operator whose network cannot reach that CDN: the page rendered normally but the editor pane hung on `Loading...` forever, because the AMD loader never resolved and `@monaco-editor/react` surfaces no timeout. `public/monaco/` is generated, git-ignored, and listed as a `build` output in `turbo.json` so the Turbo cache restores it.

Both policies differ on exactly one more directive: outside production, `script-src` also carries `'unsafe-eval'`. `next dev` compiles client chunks with an eval-based devtool, so without it the browser blocks the Next.js runtime itself — chunks download with 200s, nothing executes, and every page sits on its unhydrated server fallback emitting only a `securitypolicyviolation` event. `next build` emits no `eval`, so production does without. [`apps/web/src/lib/csp.test.ts`](../../../apps/web/src/lib/csp.test.ts) pins both policies, [`apps/web/test/middleware.test.ts`](../../../apps/web/test/middleware.test.ts) the header wiring and matcher, and [`apps/web/test/headers.test.ts`](../../../apps/web/test/headers.test.ts) that `next.config.mjs` sets no second, static policy. The switch reads `NODE_ENV` per request; no other env var is involved.
