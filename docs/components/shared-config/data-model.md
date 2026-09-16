# `shared-config` — data model

## Bridge method allowlist

30 RPC method names in declaration order (from `BRIDGE_METHODS`):

```
ping  host_info  host_metrics
file_read  file_read_tail  file_write
file_atomic_write  directory_delete  list_panel_dirs
list_squad_containers  ufw_rule  process_info
container_run  container_run_rnsquadjs  container_start
container_stop  container_rm  container_inspect
container_stats  container_logs_follow  depot_update
docker_prune  backup_snapshots  backup_run
backup_restore  panel_disk_usage  squad_log_retention_sweep
squad_log_list  file_read_stream  host_agent_restart
```

Streaming methods (deliver `BridgeStreamFrame` before the final response): `container_logs_follow`, `depot_update`, `docker_prune`.

## Permissions registry

48 entries in `PERMISSIONS`. Columns: `key`, `category`, `label`, optional `dangerous: true`, optional `unimplemented: true`.

| Category | Key | Dangerous | Unimplemented |
|---|---|:---:|:---:|
| `servers` | `server:view` | | |
| `servers` | `server:install` | ✓ | |
| `servers` | `server:start` | | |
| `servers` | `server:stop` | | |
| `servers` | `server:force_stop` | ✓ | |
| `servers` | `server:restart` | | |
| `servers` | `server:delete` | ✓ | |
| `servers` | `server:edit_settings` | | |
| `servers` | `server:update` | | |
| `servers` | `server:download_logs` | | |
| `configs` | `config:view` | | |
| `configs` | `config:edit` | | |
| `configs` | `config:rollback` | | |
| `players` | `player:view` | | |
| `players` | `player:view_ips` | | |
| `players` | `player:view_notes` | | ✓ |
| `players` | `player:edit_notes` | | ✓ |
| `players` | `player:set_flags` | | ✓ |
| `moderation` | `mod:kick` | ✓ | |
| `moderation` | `mod:warn` | | |
| `moderation` | `mod:ban_temp` | ✓ | |
| `moderation` | `mod:ban_perm` | ✓ | |
| `moderation` | `mod:unban` | | |
| `admin_groups` | `admin_group:view` | | ✓ |
| `admin_groups` | `admin_group:edit` | | ✓ |
| `whitelist` | `whitelist:view` | | ✓ |
| `whitelist` | `whitelist:edit` | | ✓ |
| `host` | `host:view` | | |
| `host` | `host:metrics` | | |
| `host` | `host:manage` | ✓ | |
| `audit` | `audit:view` | | |
| `audit` | `audit:export` | | ✓ |
| `events` | `events:view` | | |
| `users` | `user:view` | | |
| `users` | `user:manage_roles` | ✓ | |
| `roles` | `role:view` | | |
| `roles` | `role:create` | | |
| `roles` | `role:edit` | | |
| `roles` | `role:delete` | ✓ | |
| `backup` | `backup:view` | | ✓ |
| `backup` | `backup:trigger` | | ✓ |
| `backup` | `backup:restore` | ✓ | ✓ |
| `api_tokens` | `api_token:create` | | |
| `api_tokens` | `api_token:revoke` | | |
| `discord` | `discord:link` | | ✓ |
| `triggers` | `trigger:view` | | ✓ |
| `triggers` | `trigger:edit` | | ✓ |
| `scheduler` | `scheduler:view` | | ✓ |
| `scheduler` | `scheduler:edit` | | ✓ |

`dangerous: true` — requires explicit confirmation in the UI; visible to roles-editor as high-risk.  
`unimplemented: true` — key exists in the registry and DB but the feature has no active code path.

### `PermissionCategory` values (16)

```
servers  configs  players  moderation  admin_groups  whitelist
host  audit  events  users  roles  backup  api_tokens  discord  triggers  scheduler
```

## Role color palette

16 colors in `ROLE_COLORS`, matched by the `roles_color_palette` SQL CHECK constraint in migration `0009_panel_rbac.sql`:

```
red  rose  pink  fuchsia  purple  violet  indigo  blue
sky  cyan  teal  emerald  green  lime  amber  neutral
```

Colors map to Tailwind CSS color names. The web UI resolves each to its `500`-weight ring and badge variant.

## Log-stream encoding

Redis Stream field map (key → single-letter field name):

| Field name | Source struct field | Example value |
|---|---|---|
| `s` | `source` — single-letter code | `B` `R` `L` `W` `D` `I` `A` |
| `l` | `level` — single-letter code | `D` `I` `W` `E` |
| `m` | `msg` | `auth ok` |
| `i` | `serverId` (omitted when absent) | `01903f7d-...` |
| `c` | `ctx` — JSON-serialized object (omitted when empty) | `{"rttMs":14}` |

Source → code mapping:

| Source | Code |
|---|---|
| `bridge` | `B` |
| `rcon` | `R` |
| `log-ingest` | `L` |
| `worker` | `W` |
| `depot` | `D` |
| `install` | `I` |
| `api` | `A` |

Level → code mapping: `debug → D`, `info → I`, `warn → W`, `error → E`.

The Redis Stream key is `panel:logs`, max length 100 000 entries (MAXLEN `~` approximate trimming).

## Metrics-pack 8-integer tuple

`packHostMetrics` encodes `HostMetricsSample` into `number[8]`:

| Index | Source field | Encoding |
|---|---|---|
| 0 | `cpu_percent` | `× 100`, rounded |
| 1 | `ram_used_bytes` | rounded integer |
| 2 | `disk_used_bytes` | rounded integer |
| 3 | `net_rx_bytes_per_sec` | rounded integer |
| 4 | `net_tx_bytes_per_sec` | rounded integer |
| 5 | `load_avg_1m` | `× 100`, rounded |
| 6 | `load_avg_5m` | `× 100`, rounded |
| 7 | `load_avg_15m` | `× 100`, rounded |

Negatives and `NaN` are clamped to 0. Precision loss for percentages/load: ±0.005 (two decimal places).

Redis stream: `host:metrics`, max 5 760 entries (48 h at 30-second sampling intervals).

## Heartbeat payload shape

Stored in Redis at `worker:heartbeat:{name}`, serialized as JSON, TTL 30 s:

```ts
{
  name: string;
  ts: string;          // ISO-8601 — when this heartbeat was written
  pid: number;
  hostname?: string;
  version?: string;
  started_at: string;  // ISO-8601 — when the worker process started
  status?: string;     // optional ad-hoc string from statusFn
}
```

A missing key means the worker has been unresponsive for at least the TTL.
