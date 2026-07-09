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
