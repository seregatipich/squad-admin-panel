# Web — Data Model

## Session

The session is tracked by the `__Host-sid` HTTP-only, Secure, SameSite=Strict cookie set by the API on successful Steam OpenID callback. The cookie name constant is exported from `apps/web/src/lib/dal.ts`:

```ts
export const SESSION_COOKIE = '__Host-sid';
```

The cookie value is an opaque session token. The web app never decodes it — it only forwards it as a `Cookie` header to the API.

---

## `Me` type

Returned by `GET /api/v1/me` and used in both server components (via `getSession` / `requireSession`) and client components (via direct `fetch('/api/v1/me')`).

```ts
interface Me {
  steam_id64: string;       // 17-digit decimal string
  canonical_name: string;   // last-known Steam display name
  avatar_url: string | null;
  permissions: string[];    // permission keys granted by the user's role, e.g. ["server:view", "config:view"]
}
```

Source: `apps/web/src/lib/dal.ts`.

The `permissions` array drives every conditional render in the sidebar and page-level gating (e.g., showing the Roles link only when `role:view` is in the array). It reflects the user's role at the time of the last `/me` call; the API re-reads the role on every request so changes take effect on the next poll cycle.

---

## Active session shape

Used in `/settings/account` to display and revoke browser sessions.

```ts
interface ActiveSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  last_activity_at: string;   // ISO 8601
  expires_at: string;          // ISO 8601
  current: boolean;            // true for the session making the request
}
```

---

## API token shape

Used in `/settings/tokens`.

```ts
interface ApiToken {
  id: string;
  name: string;
  scopes: string[];            // subset of the owner's permission keys
  last_used_at: string | null; // ISO 8601
  created_at: string;          // ISO 8601
  revoked_at: string | null;   // non-null means soft-deleted
}

interface CreateResponse extends ApiToken {
  plaintext: string;           // full token — shown once, never again
}
```

---

## Server-install form schema

Used in `/servers/new`. Field-level constraints:

| Field | Type | Constraints |
|---|---|---|
| `display_name` | string | 1–120 characters |
| `slug` | string | `^[a-z0-9][a-z0-9-]{0,63}$`; auto-generated from `display_name` by Cyrillic transliteration |
| `game_port` | number | 1024–65535; default 7787 |
| `query_port` | number | 1024–65535; default 27165 |
| `beacon_port` | number | 1024–65535; default 15000 |
| `rcon_port` | number | 1024–65535; default 21114 |
| `max_players` | number | 1–100; default 20 in the wizard |

Cyrillic-to-Latin transliteration table lives in `apps/web/src/app/(dashboard)/servers/new/page.tsx` (`CYRILLIC_TO_LATIN`). Non-alpha characters are collapsed to `-`, leading/trailing dashes stripped, total limited to 64 characters.

---

## Role editor form schema

Used in `/roles/new` and `/roles/[id]`.

```ts
interface RoleFormData {
  name: string;               // 1–64 characters
  color: RoleColor;           // one of 16 Tailwind color names
  description: string | null; // max 256 characters
  permissions: string[];      // subset of keys from GET /api/v1/permissions
}
```

`RoleColor` type and the full list of 16 valid values come from `@squad/shared-config/role-colors`.

---

## Server list item shape (client-side)

Used in `/servers`, `/dashboard` (servers widget).

```ts
interface Server {
  id: string;           // UUID v7
  display_name: string;
  slug: string;
  status: string;       // 'pending' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
  rcon_state: string | null;       // 'connected' | 'disconnected' | 'authenticating' | 'reconnecting' | 'failed' | 'not_polled'
  player_count: number | null;
  last_poll_at: string | null;     // ISO 8601
}
```

---

## User list item shape

Used in `/users`.

```ts
interface UserRow {
  steam_id64: string;
  canonical_name: string;
  last_seen_at: string;   // ISO 8601
  role: {
    id: string;
    name: string;
    color: RoleColor;
    is_system_role: boolean;
  };
}
```

---

## Role list item shape

Used in `/roles`.

```ts
interface RoleRow {
  id: string;
  name: string;
  color: RoleColor;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
  assigned_users_count: number;
}
```

---

## Audit entry shape (client-side)

Used in `/audit` and the dashboard Recent Activity widget.

```ts
interface AuditEntry {
  id: string;
  created_at: string;          // ISO 8601
  actor_user_id: string | null;
  actor_kind: 'user' | 'system' | 'external';
  action_type: string;         // dot-separated, e.g. "server.start"
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;  // HTTP status code of the handled request
  duration_ms: number | null;
  context: Record<string, unknown>;
}
```

The `context` field contains action-specific metadata (before/after sha256 for config edits, container IDs for lifecycle events, etc.). The dashboard widget reads only the first 25 rows from the audit endpoint (`?page_size=25`); the full audit page reads 200.

---

## Player detail shape

Used in `/players/[steam_id64]`.

```ts
interface PlayerResponse {
  player: {
    steam_id64: string;
    canonical_name: string;
    eos_id: string | null;
    first_seen_at: string;
    last_seen_at: string;
    total_time_played_seconds: number;
  };
  names: Array<{
    name: string;
    name_normalized: string;
    first_seen_at: string;
    last_seen_at: string;
    observation_count: number;
  }>;
  ips: Array<{
    ip: string;
    first_seen_at: string;
    last_seen_at: string;
  }>;
  ips_visible: boolean;   // false when caller lacks player:view_ips
}
```
