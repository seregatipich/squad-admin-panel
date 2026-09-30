import { z } from 'zod';
import { isRestrictedNetworkHost } from './network-host.js';

export const uuidString = z.string().uuid();

export const serverCreateInput = z
  .object({
    display_name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\r\n"]+$/, 'must not contain quotes or newlines'),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().max(500).nullable().optional(),
    game_port: z.number().int().min(1024).max(65_535),
    query_port: z.number().int().min(1024).max(65_535),
    beacon_port: z.number().int().min(1024).max(65_535),
    rcon_port: z.number().int().min(1024).max(65_535),
    // Interpolated into the Squad command line (RCONIP=/MULTIHOME=) by the
    // bridge, so only a bare IP literal is accepted (#52).
    multihome: z.string().ip().default('0.0.0.0'),
    max_players: z.number().int().min(1).max(100).default(100),
    tickrate: z.number().int().min(10).max(120).default(50),
    // Launch-arg and cgroup knobs: the container is never started with them,
    // so only their "unset" value is accepted (kept for existing clients that
    // send the defaults) — a real limit is rejected rather than stored as if it
    // were in force (#53).
    extra_args: z.literal('').optional(),
    launch_args_override: z.null().optional(),
    cpu_affinity: z.null().optional(),
    cpu_weight: z.null().optional(),
    niceness: z.null().optional(),
    memory_high_mb: z.null().optional(),
    memory_max_mb: z.null().optional(),
    io_weight: z.null().optional(),
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

/**
 * Hostname or IP literal the panel dials for RCON/A2S/SSH — no scheme, no
 * port, no spaces, and never the panel host itself (loopback, link-local,
 * single-label service names; see {@link isRestrictedNetworkHost}, #30).
 */
export const rconHostString = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:\-[\]]+$/, 'host must be a hostname, IPv4 or IPv6 literal')
  .refine((host) => !isRestrictedNetworkHost(host), {
    message: 'host must not be a loopback, link-local or internal address',
  });

/**
 * An RCON password as stored in the target's `Rcon.cfg`. It is sent verbatim
 * as the body of the SERVERDATA_AUTH packet, so control characters are
 * refused: CR/LF/NUL let a password smuggle line-protocol commands into
 * whatever service the host/port really points at (#30, finding #333).
 */
export const rconPasswordString = z
  .string()
  .min(1)
  .max(200)
  .refine((password) => ![...password].some((c) => c < ' ' || c === '\u007f'), {
    message: 'rcon_password must not contain control characters',
  });

/**
 * RCON host of an external server: {@link rconHostString}, which already
 * refuses every address that resolves into the panel host itself (loopback,
 * link-local, Docker/Podman host aliases, service names). Container-runtime
 * servers keep dialling loopback, but they never go through this schema.
 */
export const externalRconHost = rconHostString;

/**
 * Body of `POST /api/v1/servers/external` — registers an already-running
 * Squad server that the panel does not host. The RCON password is the one
 * configured in that server's `Rcon.cfg`; the panel stores it encrypted and
 * never returns it. `query_port` feeds the A2S probe, `game_port` only the
 * `steam://connect` join link.
 */
export const externalServerCreateInput = z
  .object({
    display_name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\r\n"]+$/, 'must not contain quotes or newlines'),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().max(500).nullable().optional(),
    rcon_host: externalRconHost,
    rcon_port: z.number().int().min(1).max(65_535),
    rcon_password: rconPasswordString,
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
    rcon_host: externalRconHost.optional(),
    rcon_port: z.number().int().min(1).max(65_535).optional(),
    rcon_password: rconPasswordString.optional(),
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
