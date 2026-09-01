# Web — Public Surface

## App Router pages

All pages live under `apps/web/src/app/`. The `(dashboard)` route group requires an active session cookie (`__Host-sid`) **and** panel access; the layout at `apps/web/src/app/(dashboard)/layout.tsx` calls `requireSession()`, redirects a session with an empty `permissions` array to `/me`, and otherwise renders the top bar and server switcher.

### Unauthenticated pages

| Route | File | What it does |
|---|---|---|
| `/` | `app/page.tsx` | Reads `__Host-sid` cookie server-side; redirects to `/login` when absent, to `/me` when the session carries no panel permissions, otherwise to `/dashboard`. |
| `/login` | `app/login/page.tsx` | Проверяет текущий сеанс: при успехе открывает `/dashboard`, иначе один раз запускает единый вход через `/api/v1/auth/bss/login`. После ошибки показывает ручную кнопку повтора без цикла перенаправлений. |
| `/setup` | `app/setup/page.tsx` | Первичная настройка панели. До назначения первого Owner предлагает войти через единый вход BSS; после входа Owner запрашивает название организации и вызывает `POST /api/v1/setup/complete`. Настроенная панель перенаправляет на `/`. |

### Self-service pages

The `(me)` route group requires a session cookie but **not** panel access — its layout (`app/(me)/layout.tsx`) calls `requireSession()` and renders only a header with the display name and a logout button, no top bar and no live-bus widgets.

| Route | File | What it does |
|---|---|---|
| `/me` | `app/(me)/me/page.tsx` | «Мой VIP». Стартовая страница пользователя без `panel_access`: BSS-callback создаёт ограниченный `self_service`-сеанс и направляет сюда. Показывает баланс, срок VIP, подписку, тарифы и историю бонусов; все `/api/v1/me/*` работают только с владельцем сеанса. В шапке доступны переход на `bss.games`, выход из текущей панели и глобальный выход. |

### Dashboard pages

All require a valid session. Permission gating is noted where applicable.

| Route | File | Required permission(s) | What it displays |
|---|---|---|---|
| `/dashboard` | `(dashboard)/dashboard/page.tsx` | none (all authenticated users) | Summary cards (server count, online players, host health, alerts). Host info/metrics widget with sparkline buttons that open `MetricHistoryModal` for CPU / RAM / Network. The disk card has its own click handler that opens `DiskBreakdownModal` instead of the metric-history modal — its outer `<button>` carries `data-testid="disk-card"` for the Playwright suite. The disk card splits the used portion of its bar into two sub-segments — `Панель` (deeper purple) and `Прочее` (lighter purple) — driven by `panel_pct` / `other_pct` from `GET /api/v1/host/disk-usage` (polled every 30 s, independent of the 4 s host-metrics poll). A swatch legend below the bar shows both percentages with one-decimal precision. While the breakdown payload is loading or failed, the bar falls back to the single-segment threshold-tinted rendering (emerald/amber/red) and the legend is hidden. The two sub-segments are clamped so they never visually exceed the total used % shown in the card title — if the bridge's `panel_disk_usage` and `host_metrics` samples drift, the panel sub-segment is the source of truth and `other = max(0, used_pct - panel_pct)` absorbs the rounding gap. Recent activity feed from `GET /api/v1/audit`. Connection health panel (PostgreSQL, Redis, bridge, workers). Polls every 4 s. |
| `/servers` | `(dashboard)/servers/page.tsx` | none | Server list with status dot, player count, RCON state, last-poll time. Free-text search by name, slug, or id. Start / stop / restart action buttons. Polls every 4 s. |
| `/servers/new` | `(dashboard)/servers/new/page.tsx` | `server:create` (enforced by API) | Two-step wizard: form (display_name, slug auto-transliterated from Cyrillic, ports, max_players) → POST /servers → POST /servers/:id/install → WebSocket log tail via `LogConsole`. |
| `/servers/[id]` | `(dashboard)/servers/[id]/page.tsx` | none | Server detail: status, RCON state, container runtime, log tail (WebSocket), start/stop/restart buttons, links to configs and events tabs. Delete confirm modal warns that files will be wiped from disk and the cfg backup will live in `/servers/archive`. |
| `/servers/[id]/configs` | `(dashboard)/servers/[id]/configs/page.tsx` | `config:view` | Monaco-backed config editor with three tabs: Editor (dirty-tracking, optional commit message), History (config_versions list with diff/restore), Blame (per-line attribution). |
| `/servers/[id]/events` | `(dashboard)/servers/[id]/events/page.tsx` | none | Per-server event feed from Redis Streams via `GET /api/v1/servers/:id/events`. |
| `/servers/archive` | `(dashboard)/servers/archive/page.tsx` | `server:view` | Soft-deleted server table from `GET /api/v1/servers/archive`. Forbidden state when caller lacks the permission. |
| `/servers/archive/[id]` | `(dashboard)/servers/archive/[id]/page.tsx` | `server:view` (+ `config:view` to read backup contents) | Detail + per-cfg backup browser. Each row opens a read-only Monaco viewer fed by `GET /api/v1/servers/archive/:id/configs/:filename`. |
| `/servers/archive/[id]/restore` | `(dashboard)/servers/archive/[id]/restore/page.tsx` | `server:install` (+ `config:edit`) | Restore wizard: slug + display_name → POST `/restore` (409 inline on slug conflict) → POST `/install` with WS log tail → POST `/restore-configs` → POST `/start`. |
| `/players` | `(dashboard)/players/page.tsx` | none | Paginated player list; search by name, SteamID64, EOS ID. Server-driven sorting on Ник, Total playtime, Created, and Last seen — each header is a button that sets `?sort=`/`?dir=` on `GET /api/v1/players` and shows a direction indicator (`↑`/`↓` active, `↕` inactive); clicking the active column flips its direction. New **Created** column rendering `first_seen_at`. A `новые (<7 дней)` checkbox sets `filter=new`. The pure sort/filter state machine lives in `(dashboard)/players/helpers.ts`. The "Online" filter (last_seen_at within 90 s) and the search box stay client-side. Polls every 8 s. |
| `/players/[steam_id64]` | `(dashboard)/players/[steam_id64]/page.tsx` | none | Player profile: SteamID64, EOS ID, playtime, name history, IP history (hidden unless `player:view_ips`). `PanelAccessSection` (assign/remove panel role) shown when caller has `user:manage_roles`. |
| `/audit` | `(dashboard)/audit/page.tsx` | none | Full audit log (last 200 entries), filterable by action_type, target, or actor. Expandable context JSON per row. Polls every 6 s. |
| `/logs` | `(dashboard)/logs/page.tsx` | `host:view` (top-bar link gated) | Live log stream from `GET /api/v1/logs`. `LogList` component with source, level, server, and text filters. Export button. |
| `/roles` | `(dashboard)/roles/page.tsx` | `role:view` | Role list with color dot, description, user count. Create link (requires `role:create`). Edit/Delete buttons gated by `role:edit` / `role:delete`. Owner role is protected. |
| `/roles/new` | `(dashboard)/roles/new/page.tsx` | `role:create` (API-enforced) | `RoleEditor` component in create mode. POST /api/v1/roles on submit. |
| `/roles/[id]` | `(dashboard)/roles/[id]/page.tsx` | `role:edit` (API-enforced) | `RoleEditor` in edit mode; read-only for the Owner system role. PUT /api/v1/roles/:id on submit. |
| `/users` | `(dashboard)/users/page.tsx` | `user:view` | Users with panel roles (players where role_id IS NOT NULL). `AssignModal` (player search + role select) shown when caller has `user:manage_roles`; assigns role via PUT /api/v1/players/:steam_id64/role. Owner role assignment requires confirm dialog. |
| `/settings/account` | `(dashboard)/(account)/settings/account/page.tsx` | none | Account name (in-game, Steam persona as fallback) plus nickname history in the page header. Profile (SteamID64, permissions count). Own in-game statistics first, profile below it: the «Игровая статистика» block (the shared `DossierSection`, retitled, `serverFilter={false}`) and «Последние матчи», both keyed on `player_id` from `GET /api/v1/me`. Full width — the route sits in the `(account)` group so the section's `reading` layout does not wrap it. Active sessions table with individual and bulk revoke. Logout lives in the top-nav user menu, not on this page. Polls every 30 s. |
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

`LogoutButton` вызывает `POST /api/v1/auth/logout` и возвращает на `/login`. `GlobalLogoutButton` вызывает `POST /api/v1/auth/logout-all` и переходит по проверенному сервером адресу `bss.games`; при частичном отказе сайт получает только безопасный признак ошибки. Обе команды доступны в меню пользователя, а на `/me` — в шапке самообслуживания.

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

### `DiskBreakdownModal`

```ts
function DiskBreakdownModal(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialData: DiskUsage | null;
  onRefresh: () => Promise<DiskUsage | null>;
}): JSX.Element | null
```

Mounted by `apps/web/src/app/(dashboard)/dashboard/page.tsx`; opened when the user clicks the disk card (`data-testid="disk-card"`). Controlled — the parent owns `open` and toggles it via `onOpenChange`. `initialData` is the dashboard's polled `diskBreakdown` state; the modal seeds its local state from this prop on open so there is no duplicate fetch. The refresh button (`↻`) calls `onRefresh`, which is the parent-supplied closure that does `fetch('/api/v1/host/disk-usage?refresh=1')`, parses the body, also writes back into the dashboard's `diskBreakdown` state, and returns the fresh payload (or `null` on failure). The button is disabled while the request is in flight and shows a spinning glyph. Closes on Escape or backdrop click.

Render structure:

- **Header**: «Что занимает панель» as the dialog title plus a close button.
- **Summary line**: `Всего: <fmt(total_panel_bytes)> · X.X% диска · обновлено N сек назад` where `N = data.cache_age_seconds`. Refresh button to the right.
- **Section "По типу"**: rows built from `configs_bytes`, `saved_total_bytes`, `depot_volume_bytes`, every entry in `docker_volumes` (label `volume:<name>`), every entry in `docker_images` (label `image:<repo>:<tag>`), and `audit_archive_bytes`. Sorted by bytes descending. Right column is monospace-formatted byte size.
- **Section "По серверам (saved)"**: rendered only if `saved_per_server.length > 0`. Scrollable table (`max-h-72 overflow-y-auto`) with `Server` (Next `<Link>` to `/servers/<uuid>`, displaying first 8 chars of UUID) and right-aligned monospace `Saved` columns. Sorted by bytes descending.
- **Loading / empty states**: when `data === null`, shows «Загрузка…» while a refresh is in-flight, otherwise «Нет данных». The latter never fires in practice because the parent always passes a non-null `initialData` once the dashboard's first poll completes.

The component-private `fmt(bytes: number): string` helper picks a base-1024 unit (`B/KB/MB/GB/TB`) and formats with 0/1/2 decimals depending on magnitude. It is not exported.

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
