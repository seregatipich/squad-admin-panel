# Web — Public Surface

## App Router pages

All pages live under `apps/web/src/app/`. The `(dashboard)` route group requires an active session cookie (`__Host-sid`); the layout at `apps/web/src/app/(dashboard)/layout.tsx` calls `requireSession()` and renders the sidebar.

### Unauthenticated pages

| Route | File | What it does |
|---|---|---|
| `/` | `app/page.tsx` | Reads `__Host-sid` cookie server-side; redirects to `/dashboard` when present, otherwise to `/login`. |
| `/login` | `app/login/page.tsx` | Steam OpenID sign-in entry point. Redirects to `/dashboard` if already authenticated. Shows errors for `?error=auth_failed` and `?error=not_authorized`. |
| `/no-access` | `app/no-access/page.tsx` | Landing for authenticated Steam users who have no panel role. Shows optional `?steam_id64=` in the URL. |

### Dashboard pages

All require a valid session. Permission gating is noted where applicable.

| Route | File | Required permission(s) | What it displays |
|---|---|---|---|
| `/dashboard` | `(dashboard)/dashboard/page.tsx` | none (all authenticated users) | Summary cards (server count, online players, host health, alerts). Host info/metrics widget with sparkline buttons that open `MetricHistoryModal`. The disk card splits the used portion of its bar into two sub-segments — `Панель` (deeper purple) and `Прочее` (lighter purple) — driven by `panel_pct` / `other_pct` from `GET /api/v1/host/disk-usage` (polled every 30 s, independent of the 4 s host-metrics poll). A swatch legend below the bar shows both percentages with one-decimal precision. While the breakdown payload is loading or failed, the bar falls back to the single-segment threshold-tinted rendering (emerald/amber/red) and the legend is hidden. The two sub-segments are clamped so they never visually exceed the total used % shown in the card title — if the bridge's `panel_disk_usage` and `host_metrics` samples drift, the panel sub-segment is the source of truth and `other = max(0, used_pct - panel_pct)` absorbs the rounding gap. Recent activity feed from `GET /api/v1/audit`. Connection health panel (PostgreSQL, Redis, bridge, workers). Polls every 4 s. |
| `/servers` | `(dashboard)/servers/page.tsx` | none | Server list with status dot, player count, RCON state, last-poll time. Free-text search by name, slug, or id. Start / stop / restart action buttons. Polls every 4 s. |
| `/servers/new` | `(dashboard)/servers/new/page.tsx` | `server:create` (enforced by API) | Two-step wizard: form (display_name, slug auto-transliterated from Cyrillic, ports, max_players) → POST /servers → POST /servers/:id/install → WebSocket log tail via `LogConsole`. |
| `/servers/[id]` | `(dashboard)/servers/[id]/page.tsx` | none | Server detail: status, RCON state, container runtime, log tail (WebSocket), start/stop/restart buttons, links to configs and events tabs. Delete confirm modal warns that files will be wiped from disk and the cfg backup will live in `/servers/archive`. |
| `/servers/[id]/configs` | `(dashboard)/servers/[id]/configs/page.tsx` | `config:view` | Monaco-backed config editor with three tabs: Editor (dirty-tracking, optional commit message), History (config_versions list with diff/restore), Blame (per-line attribution). |
| `/servers/[id]/events` | `(dashboard)/servers/[id]/events/page.tsx` | none | Per-server event feed from Redis Streams via `GET /api/v1/servers/:id/events`. |
| `/servers/archive` | `(dashboard)/servers/archive/page.tsx` | `server:view` | Soft-deleted server table from `GET /api/v1/servers/archive`. Forbidden state when caller lacks the permission. |
| `/servers/archive/[id]` | `(dashboard)/servers/archive/[id]/page.tsx` | `server:view` (+ `config:view` to read backup contents) | Detail + per-cfg backup browser. Each row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`. |
| `/servers/archive/[id]/restore` | `(dashboard)/servers/archive/[id]/restore/page.tsx` | `server:install` (+ `config:edit`) | Restore wizard: slug + display_name → POST `/restore` (409 inline on slug conflict) → POST `/install` with WS log tail → POST `/restore-configs` → POST `/start`. |
| `/players` | `(dashboard)/players/page.tsx` | none | Paginated player list; search by name, SteamID64, EOS ID. "Online" filter (last_seen_at within 90 s). Polls every 8 s. |
| `/players/[steam_id64]` | `(dashboard)/players/[steam_id64]/page.tsx` | none | Player profile: SteamID64, EOS ID, playtime, name history, IP history (hidden unless `player:view_ips`). `PanelAccessSection` (assign/remove panel role) shown when caller has `user:manage_roles`. |
| `/audit` | `(dashboard)/audit/page.tsx` | none | Full audit log (last 200 entries), filterable by action_type, target, or actor. Expandable context JSON per row. Polls every 6 s. |
| `/logs` | `(dashboard)/logs/page.tsx` | `host:view` (sidebar link gated) | Live log stream from `GET /api/v1/logs`. `LogList` component with source, level, server, and text filters. Export button. |
| `/roles` | `(dashboard)/roles/page.tsx` | `role:view` | Role list with color dot, description, user count. Create link (requires `role:create`). Edit/Delete buttons gated by `role:edit` / `role:delete`. Owner role is protected. |
| `/roles/new` | `(dashboard)/roles/new/page.tsx` | `role:create` (API-enforced) | `RoleEditor` component in create mode. POST /api/v1/roles on submit. |
| `/roles/[id]` | `(dashboard)/roles/[id]/page.tsx` | `role:edit` (API-enforced) | `RoleEditor` in edit mode; read-only for the Owner system role. PUT /api/v1/roles/:id on submit. |
| `/users` | `(dashboard)/users/page.tsx` | `user:view` | Users with panel roles (players where role_id IS NOT NULL). `AssignModal` (player search + role select) shown when caller has `user:manage_roles`; assigns role via PUT /api/v1/players/:steam_id64/role. Owner role assignment requires confirm dialog. |
| `/settings/account` | `(dashboard)/settings/account/page.tsx` | none | Profile (SteamID64, canonical_name, permissions count). Active sessions table with individual and bulk revoke. Logout button. Polls every 30 s. |
| `/settings/tokens` | `(dashboard)/settings/tokens/page.tsx` | none | API token management. Create a named token with a subset of the user's own permissions (scopes). Token plaintext shown once on creation. Revoke existing tokens. |

---

## Reusable components

All components live under `apps/web/src/components/`.

### `ConnectionBanner`

```ts
function ConnectionBanner(): JSX.Element | null
```

Sticky top-of-layout banner. Returns `null` when `useLiveBusState() === 'open'` AND `useBridgeState() !== 'down'`. Otherwise renders one of:

- Red: `Связь с панелью потеряна — переподключаемся…` (WS not in `open` state).
- Amber: `Bridge не отвечает — операции с сервером временно недоступны` (WS open but bridge state is `down`).

The banner has `role="alert"` and `data-testid="connection-banner"` for Playwright. Mounted by `apps/web/src/app/(dashboard)/layout.tsx` so every authenticated page sees it.

### `LiveIndicator`

```ts
function LiveIndicator(props: {
  lastUpdate: Date | number | null;
  label?: string;     // default: "обновлено"
  title?: string;     // tooltip override
}): JSX.Element
```

Displays a pulsing colored dot and elapsed time since the last successful data fetch. Dot color: emerald (<10 s), amber (<60 s), red (≥60 s), neutral (no data). Refreshes every second.

Also exports `liveTone(ageMs: number | null): LiveTone` for programmatic color logic.

### `LogConsole`

```ts
function LogConsole(props: {
  lines: LogEntry[];
  height?: string;              // CSS value, default "24rem"
  title?: string;
  live?: boolean;               // shows live/offline indicator in header
  showStep?: boolean;           // prepends step label (used by install wizard)
  emptyText?: string;
  errorBanner?: LogConsoleErrorBanner | null;
}): JSX.Element

interface LogEntry {
  ts?: string;
  step?: string;
  stream?: 'stdout' | 'stderr';
  message: string;
  id?: string;
}

interface LogConsoleErrorBanner {
  code: number | null;
  reason: string | null;
  retryInMs?: number | null;
  onRetry?: () => void;
}
```

Sticky-to-bottom log viewer. Auto-scrolls when the user is within 24 px of the bottom. When scrolled up a "↓ к последней" pill appears. `stderr` lines render in red. The `errorBanner` renders an error strip above the viewport with optional retry button.

### `LogList`

```ts
function LogList(props: {
  servers: Array<{ id: string; display_name: string }>;
}): JSX.Element

type Level = 'debug' | 'info' | 'warn' | 'error';
```

Fetches log entries from `GET /api/v1/logs` and polls for new entries every 1 s (using the `after` cursor). Filters by source (bridge/rcon/log-ingest/worker/depot/install/api), minimum level, server, and free-text search. Pause button suspends polling. Export link to `/api/v1/logs/export`. Expandable ctx JSON per entry. Retains at most 1000 entries client-side.

### `LogoutButton`

```ts
function LogoutButton(): JSX.Element
```

Calls `POST /api/v1/auth/logout` then redirects to `/login`. Renders as a text button in the sidebar footer.

### `MetricHistoryChart`

Lazy-loaded chart component (via `dynamic()` with `ssr: false`). Renders a line chart for one of the four metric keys: `cpu`, `ram`, `disk`, `net`. Receives an array of `MetricPoint` values fetched from `GET /api/v1/host/metrics/history`.

```ts
export type MetricKey = 'cpu' | 'ram' | 'disk' | 'net';
```

### `MetricHistoryModal`

```ts
function MetricHistoryModal(props: {
  open: boolean;
  onClose: () => void;
  metric: MetricKey;
  ramTotalBytes: number;
  diskTotalBytes: number;
}): JSX.Element
```

Modal wrapper around `MetricHistoryChart`. Fetches `GET /api/v1/host/metrics/history` when opened. Closes on Escape or backdrop click.

### `RestartBridgeButton`

```ts
function RestartBridgeButton(props: {
  disabled?: boolean;
  disabledReason?: string;
}): JSX.Element
```

Button that triggers `POST /api/v1/host/restart`. Shows a confirmation modal. Displays "Перезапускается…" spinner during the call. Requires `host:restart` permission (enforced by API; button remains visible but returns 403 if not granted). Becomes disabled and shows `disabledReason` tooltip when bridge is offline.

### `RoleColorDot`

```ts
function RoleColorDot(props: {
  color: RoleColor;
  size?: 'sm' | 'md';   // default 'md'
}): JSX.Element
```

Renders a small colored circle representing a role. Uses a static `CLASS_MAP` from `@squad/shared-config/role-colors`. Aria-hidden. 16 supported colors: red, rose, pink, fuchsia, purple, violet, indigo, blue, sky, cyan, teal, emerald, green, lime, amber, neutral.

### `RoleEditor`

```ts
interface RoleEditorProps {
  initial?: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
    isSystemRole?: boolean;
    isOwner?: boolean;     // makes the form fully read-only
  };
  onSubmit: (data: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
  }) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}
```

Full role creation/editing form. Fields: name (text), color (color picker using `RoleColorDot`), description (textarea), permissions (grouped checkboxes loaded from `GET /api/v1/permissions`, filterable by search). When `isOwner` is true the entire form is read-only and only a Back button is shown. Permission categories render in a fixed order defined by `CATEGORY_ORDER`.

---

## DAL functions

Located in `apps/web/src/lib/dal.ts`. Server-only (`import 'server-only'`).

### `getSession`

```ts
async function getSession(): Promise<Me | null>
```

Reads `__Host-sid` from the Next.js cookie jar and calls `GET /api/v1/me` with that cookie. Returns `null` on missing cookie, network error, or non-OK response. Memoized with React `cache()` for the duration of a single request.

### `requireSession`

```ts
async function requireSession(): Promise<Me>
```

Calls `getSession()`; if the result is null, calls `redirect('/login')`. Used by all dashboard layout components.

### `apiFetch`

Located in `apps/web/src/lib/api.ts`. Can be used server-side or in API routes.

```ts
async function apiFetch<T>(path: string, opts?: RequestOptions): Promise<T>

interface RequestOptions extends RequestInit {
  cookie?: string;
}
```

Forwards requests to the internal API container at `API_URL` (env var, defaults to `http://api:3000`). Sets `accept: application/json` and `content-type: application/json` automatically. Throws an `Error` with the status code and response body on non-OK responses.
