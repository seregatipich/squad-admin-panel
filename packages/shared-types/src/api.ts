import { z } from 'zod';

export const uuidString = z.string().uuid();

export const hostInfo = z
  .object({
    hostname: z.string(),
    os_name: z.string(),
    os_version: z.string(),
    kernel: z.string(),
    arch: z.string(),
    cpu_model: z.string(),
    cpu_cores: z.number().int().positive(),
    ram_total_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type HostInfo = z.infer<typeof hostInfo>;

export const hostMetrics = z
  .object({
    cpu_percent: z.number().min(0).max(100),
    ram_used_bytes: z.number().int().nonnegative(),
    ram_total_bytes: z.number().int().positive(),
    disk_used_bytes: z.number().int().nonnegative(),
    disk_total_bytes: z.number().int().positive(),
    net_rx_bytes_per_sec: z.number().nonnegative(),
    net_tx_bytes_per_sec: z.number().nonnegative(),
    sampled_at: z.string().datetime(),
  })
  .strict();
export type HostMetrics = z.infer<typeof hostMetrics>;

export const bridgeStatus = z
  .object({
    connected: z.boolean(),
    version: z.string().nullable(),
    uptime_seconds: z.number().int().nonnegative().nullable(),
    last_error: z.string().nullable(),
  })
  .strict();
export type BridgeStatus = z.infer<typeof bridgeStatus>;

export const serverStatus = z.enum([
  'pending',
  'installing',
  'ready',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
]);
export type ServerStatus = z.infer<typeof serverStatus>;

export const serverCreateInput = z
  .object({
    display_name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().max(500).nullable().optional(),
    game_port: z.number().int().min(1024).max(65_535),
    query_port: z.number().int().min(1024).max(65_535),
    beacon_port: z.number().int().min(1024).max(65_535),
    rcon_port: z.number().int().min(1024).max(65_535),
    multihome: z.string().default('0.0.0.0'),
    max_players: z.number().int().min(1).max(100).default(100),
    tickrate: z.number().int().min(10).max(120).default(50),
    extra_args: z.string().default(''),
    launch_args_override: z.string().nullable().optional(),
    cpu_affinity: z.string().nullable().optional(),
    cpu_weight: z.number().int().min(1).max(10_000).nullable().optional(),
    niceness: z.number().int().min(-20).max(19).nullable().optional(),
    memory_high_mb: z.number().int().positive().nullable().optional(),
    memory_max_mb: z.number().int().positive().nullable().optional(),
    io_weight: z.number().int().min(1).max(10_000).nullable().optional(),
  })
  .strict()
  .refine(
    (d) => {
      const ports = [d.game_port, d.query_port, d.beacon_port, d.rcon_port];
      return new Set(ports).size === ports.length;
    },
    { message: 'game_port, query_port, beacon_port, and rcon_port must all be distinct' },
  );
export type ServerCreateInput = z.infer<typeof serverCreateInput>;

/**
 * Where a server row's process lives. `container` — a Squad container the
 * panel installs and runs on its own host through the bridge; `external` — a
 * Squad instance hosted elsewhere that the panel only reaches over RCON/A2S
 * (no bridge, no container lifecycle, no config files).
 */
export const serverRuntime = z.enum(['container', 'external']);
export type ServerRuntime = z.infer<typeof serverRuntime>;

/** Hostname or IP literal the panel dials for RCON/A2S — no scheme, no port, no spaces. */
export const rconHostString = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:\-[\]]+$/, 'host must be a hostname, IPv4 or IPv6 literal');

/**
 * Body of `POST /api/v1/servers/external` — registers an already-running
 * Squad server that the panel does not host. The RCON password is the one
 * configured in that server's `Rcon.cfg`; the panel stores it encrypted and
 * never returns it. `query_port` feeds the A2S probe, `game_port` only the
 * `steam://connect` join link.
 */
export const externalServerCreateInput = z
  .object({
    display_name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().max(500).nullable().optional(),
    rcon_host: rconHostString,
    rcon_port: z.number().int().min(1).max(65_535),
    rcon_password: z.string().min(1).max(200),
    query_port: z.number().int().min(1).max(65_535),
    game_port: z.number().int().min(1).max(65_535).default(7787),
    max_players: z.number().int().min(1).max(100).default(100),
  })
  .strict();
export type ExternalServerCreateInput = z.infer<typeof externalServerCreateInput>;

/**
 * Body of `PUT /api/v1/servers/:id/external-connection` — every field is
 * optional, but at least one must be present. An omitted `rcon_password`
 * keeps the stored secret.
 */
export const externalServerConnectionUpdate = z
  .object({
    rcon_host: rconHostString.optional(),
    rcon_port: z.number().int().min(1).max(65_535).optional(),
    rcon_password: z.string().min(1).max(200).optional(),
    query_port: z.number().int().min(1).max(65_535).optional(),
    game_port: z.number().int().min(1).max(65_535).optional(),
    max_players: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'at least one connection field is required',
  });
export type ExternalServerConnectionUpdate = z.infer<typeof externalServerConnectionUpdate>;

/**
 * Absolute POSIX path of a `SquadGame.log` on the game host. It ends up in
 * `tail -F -- '<path>'` inside an SSH exec, so the character set is closed
 * (no quotes, spaces or shell metacharacters) and `..` segments are refused.
 */
export const remoteLogPath = z
  .string()
  .min(2)
  .max(512)
  .regex(/^\/[A-Za-z0-9._/-]+$/, 'log_path must be an absolute path of [A-Za-z0-9._/-]')
  .refine((p) => !p.split('/').includes('..'), { message: 'log_path must not contain ..' });

/**
 * Body of `PUT /api/v1/servers/:id/log-source` (external servers only). The
 * panel generates the SSH key pair itself on the first PUT and keeps it on
 * later updates unless `regenerate_key` is set; the operator installs the
 * returned public key on the game host.
 */
export const logSourceUpsertInput = z
  .object({
    ssh_host: rconHostString,
    ssh_port: z.number().int().min(1).max(65_535).default(22),
    ssh_user: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9._-]*$/, 'ssh_user must be a POSIX user name'),
    log_path: remoteLogPath,
    enabled: z.boolean().default(true),
    regenerate_key: z.boolean().default(false),
  })
  .strict();
export type LogSourceUpsertInput = z.infer<typeof logSourceUpsertInput>;

/** Live state worker-log-ingest publishes to Redis `log-source:status:<server id>`. */
export const logSourceStatus = z
  .object({
    state: z.enum(['connecting', 'connected', 'error']),
    ts: z.string(),
    last_line_at: z.string().nullable().optional(),
    lines: z.number().int().nonnegative().optional(),
    error: z.string().nullable().optional(),
    host_key_fingerprint: z.string().nullable().optional(),
  })
  .passthrough();
export type LogSourceStatus = z.infer<typeof logSourceStatus>;

/** Redis key carrying {@link logSourceStatus} for one server. */
export function logSourceStatusKey(serverId: string): string {
  return `log-source:status:${serverId}`;
}

export const serverRow = z
  .object({
    id: uuidString,
    display_name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: serverStatus,
    tags: z.array(z.string()).default([]),
    game_port: z.number().int(),
    query_port: z.number().int(),
    beacon_port: z.number().int(),
    rcon_port: z.number().int(),
    max_players: z.number().int(),
    tickrate: z.number().int(),
    multihome: z.string(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type ServerRow = z.infer<typeof serverRow>;

export const playerRow = z
  .object({
    steam_id64: z.string().regex(/^\d{17}$/),
    canonical_name: z.string(),
    eos_id: z.string().nullable(),
    first_seen_at: z.string().datetime(),
    last_seen_at: z.string().datetime(),
    total_time_played_seconds: z.number().int().nonnegative(),
    is_online: z.boolean().optional(),
  })
  .strict();
export type PlayerRow = z.infer<typeof playerRow>;

export const auditEntry = z
  .object({
    id: z.string(),
    created_at: z.string().datetime(),
    actor_user_id: uuidString.nullable(),
    actor_display_name: z.string().nullable(),
    actor_ip: z.string().nullable(),
    actor_kind: z.enum(['user', 'system', 'external']),
    action_type: z.string(),
    target_type: z.string().nullable(),
    target_id: z.string().nullable(),
    status_code: z.number().int().nullable(),
    duration_ms: z.number().int().nullable(),
  })
  .strict();
export type AuditEntry = z.infer<typeof auditEntry>;

export const layerTeamInfo = z
  .object({
    faction: z.string(),
    unit: z.string().optional(),
    tickets: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LayerTeamInfo = z.infer<typeof layerTeamInfo>;

export const layerTeams = z
  .object({
    team1: layerTeamInfo.optional(),
    team2: layerTeamInfo.optional(),
  })
  .strict();
export type LayerTeams = z.infer<typeof layerTeams>;

export const layerRow = z
  .object({
    id: uuidString,
    name: z.string(),
    map: z.string(),
    gamemode: z.string(),
    version: z.string(),
    is_seed: z.boolean(),
    teams: layerTeams,
    depot_version: z.string().nullable(),
    deprecated: z.boolean(),
    created_at: z.string().datetime(),
  })
  .strict();
export type LayerRow = z.infer<typeof layerRow>;

export const layerListQuery = z
  .object({
    map: z.string().trim().min(1).max(200).optional(),
    gamemode: z.string().trim().min(1).max(64).optional(),
    is_seed: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type LayerListQuery = z.infer<typeof layerListQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      page_size: z.number().int().positive(),
    })
    .strict();

export {
  type A2SStatus,
  a2sStatus,
  type CrashEntry,
  crashEntry,
  type MetricsPoint,
  metricsPoint,
  type ServerPatch,
  type ServerSettingsUpdate,
  serverPatch,
  serverSettingsUpdate,
} from './server-settings.js';
