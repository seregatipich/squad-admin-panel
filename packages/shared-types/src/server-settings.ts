import { z } from 'zod';

export const serverSettingsUpdate = z
  .object({
    game_port: z.number().int().min(1024).max(65_535).optional(),
    query_port: z.number().int().min(1024).max(65_535).optional(),
    beacon_port: z.number().int().min(1024).max(65_535).optional(),
    rcon_port: z.number().int().min(1024).max(65_535).optional(),
    max_players: z.number().int().min(1).max(100).optional(),
    tickrate: z.number().int().min(10).max(60).optional(),
    // Bare IP literal only: it becomes the RCONIP=/MULTIHOME= launch args (#53).
    multihome: z.string().ip().nullable().optional(),
    // Launch-arg and cgroup knobs: the container is never started with them,
    // so only their "unset" value is accepted (and ignored) — a real limit is
    // rejected rather than stored as if it were in force (#53).
    extra_args: z.literal('').optional(),
    cpu_affinity: z.null().optional(),
    cpu_weight: z.null().optional(),
    niceness: z.null().optional(),
    memory_high_mb: z.null().optional(),
    memory_max_mb: z.null().optional(),
    io_weight: z.null().optional(),
    // AUTO-4 (#75): per-server toggle for panel-owned in-game chat commands and
    // the `!rules` reply text. `rules_text` is capped to worker-rcon's
    // single-message limit since it is answered with one `AdminWarn`.
    chat_commands_enabled: z.boolean().optional(),
    rules_text: z.string().max(300).nullable().optional(),
    // LOG-3 (#51): per-server toggle. When true, rotated logs expiring under the
    // LOG-1 retention sweep are copied into the restic backup staging tree
    // before deletion. Default (column) false = current delete-only behavior.
    archive_logs_to_backup: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) => {
      const ports = [d.game_port, d.query_port, d.beacon_port, d.rcon_port].filter(
        (p) => p !== undefined,
      );
      return new Set(ports).size === ports.length;
    },
    { message: 'Ports must be unique' },
  );
export type ServerSettingsUpdate = z.infer<typeof serverSettingsUpdate>;

/**
 * Rejects control characters (C0, DEL, C1 — CR/LF included) and the Unicode
 * line/paragraph separators: License.cfg is rendered as
 * `LicenseId=<id>\nLicenseKey=<key>\n`, so a line break would inject extra lines.
 */
const LICENSE_FIELD_PATTERN = /^[^\p{Cc}\u2028\u2029]*$/u;

export const serverPatch = z
  .object({
    display_name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\r\n"]+$/, 'must not contain quotes or newlines')
      .optional(),
    description: z.string().max(500).nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    license_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(LICENSE_FIELD_PATTERN, 'license_control_characters')
      .nullable()
      .optional(),
    license_key: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(LICENSE_FIELD_PATTERN, 'license_control_characters')
      .nullable()
      .optional(),
  })
  .strict()
  // SRV-6 (#45): the license is written to License.cfg as an id+key pair, so
  // half-updates are rejected (route maps this issue to 422 license_incomplete):
  // - setting the key requires the id in the same request;
  // - clearing exactly one side would leave an orphaned half on record.
  // Allowed shapes: {id,key} attach, {key:null[,id:null]} detach, {id} id-only
  // edit (key stays as stored). No format regex: the real key format is not
  // publicly specified, so only trim/min/max/pairing and the absence of control
  // characters are enforced.
  .superRefine((d, ctx) => {
    const incomplete =
      (typeof d.license_key === 'string' && typeof d.license_id !== 'string') ||
      (d.license_key === null && typeof d.license_id === 'string') ||
      (d.license_id === null && d.license_key === undefined);
    if (incomplete) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'license_incomplete',
        path: ['license_key'],
      });
    }
  });
export type ServerPatch = z.infer<typeof serverPatch>;

/**
 * The `a2s:status:<id>` cache entry of worker-rcon (#127). A query that got an
 * answer carries `visible` as the server reported it. A query that did not
 * (a game process that does not service its query port, a refused address)
 * carries `visible: null` and the `reason`: no answer says nothing about the
 * server's visibility, so it must not be shown as hidden or offline.
 * `last_success_at` is the time of the last answer, `null` when there never was one.
 */
export const a2sStatus = z
  .object({
    visible: z.boolean().nullable(),
    server_name: z.string().optional(),
    map: z.string().optional(),
    players: z.number().int().optional(),
    max_players: z.number().int().optional(),
    latency_ms: z.number().optional(),
    reason: z.string().optional(),
    queried_at: z.string().datetime(),
    last_success_at: z.string().datetime().nullable().optional(),
  })
  .strict();
export type A2SStatus = z.infer<typeof a2sStatus>;

export const crashEntry = z.object({
  timestamp: z.string().datetime(),
  exit_code: z.number().int(),
  oom_killed: z.boolean(),
  restart_count: z.number().int(),
});
export type CrashEntry = z.infer<typeof crashEntry>;

export const metricsPoint = z.object({
  timestamp: z.string(),
  cpu_percent: z.number(),
  mem_bytes: z.number(),
  mem_percent: z.number(),
  pids: z.number().int(),
  tickrate: z.number().optional(),
});
export type MetricsPoint = z.infer<typeof metricsPoint>;

/**
 * Response schemas for the server settings page in `apps/web`. They describe
 * only the fields the page reads and strip the rest, so the API can add fields
 * without breaking the UI; a missing or mistyped field makes `safeParse` fail.
 */

/** The editable subset of `server_settings` returned by `GET /servers/:id` and `PUT /servers/:id/settings`. */
export const serverSettingsView = z.object({
  server_id: z.string(),
  game_port: z.number(),
  query_port: z.number(),
  beacon_port: z.number(),
  rcon_port: z.number(),
  max_players: z.number(),
  tickrate: z.number(),
  multihome: z.string().nullable(),
  seed_live_at: z.number(),
  seed_hysteresis: z.number(),
  chat_commands_enabled: z.boolean(),
  rules_text: z.string().nullable(),
  // Defaults to false so a response from a release that predates the column still parses.
  archive_logs_to_backup: z.boolean().default(false),
});
export type ServerSettingsView = z.infer<typeof serverSettingsView>;

/** License state in `GET /servers/:id`; the key itself never leaves the API. */
export const serverLicenseState = z.object({
  configured: z.boolean(),
  license_id: z.string().nullable(),
  updated_at: z.string().nullable(),
  restart_required: z.boolean(),
});
export type ServerLicenseState = z.infer<typeof serverLicenseState>;

/** `GET /servers/:id`. `settings` is null when the server has no settings row. */
export const serverDetailResponse = z.object({
  server: z.object({
    status: z.string(),
    display_name: z.string(),
    tags: z.array(z.string()).nullish(),
    runtime: z.string().nullish(),
    license: serverLicenseState.nullish(),
  }),
  settings: serverSettingsView.nullable(),
  connection: z
    .object({ rcon_host: z.string().nullable(), rcon_port: z.number().nullable() })
    .nullish(),
  container: z
    .object({ running: z.boolean().nullish(), started_at: z.string().nullish() })
    .nullish(),
});
export type ServerDetailResponse = z.infer<typeof serverDetailResponse>;

/** `GET`/`PUT /servers/:id/log-source` of an external server. */
export const logSourceView = z.object({
  configured: z.boolean(),
  ssh_host: z.string().optional(),
  ssh_port: z.number().optional(),
  ssh_user: z.string().optional(),
  log_path: z.string().optional(),
  enabled: z.boolean().optional(),
  public_key: z.string().optional(),
  host_key_fingerprint: z.string().nullish(),
  key_version: z.number().optional(),
  status: z
    .object({
      state: z.enum(['connecting', 'connected', 'error']),
      ts: z.string(),
      lines: z.number().optional(),
      last_line_at: z.string().nullish(),
      error: z.string().nullish(),
    })
    .nullable(),
});
export type LogSourceView = z.infer<typeof logSourceView>;

/** `PUT /servers/:id/external-connection`. */
export const externalConnectionResponse = z.object({
  rcon_host: z.string().nullable(),
  rcon_port: z.number().nullable(),
  query_port: z.number().nullable(),
  game_port: z.number().nullable(),
});
export type ExternalConnectionResponse = z.infer<typeof externalConnectionResponse>;

/** `PUT /servers/:id/seeding-settings`. */
export const seedingSettingsResponse = z.object({
  seed_live_at: z.number(),
  seed_hysteresis: z.number(),
});
export type SeedingSettingsResponse = z.infer<typeof seedingSettingsResponse>;

/** `GET /me`, the part the settings page needs to gate the seeding section. */
export const meSquadPermissionsResponse = z.object({
  squad_permissions: z.array(z.string()).optional(),
});

/** `GET /servers/:id/rnsquadjs`. */
export const sidecarIntegrationResponse = z.object({
  server_id: z.string(),
  mode: z.enum(['production', 'shadow', 'legacy']),
  cutover: z.boolean(),
  status: z
    .object({ state: z.enum(['connected', 'disconnected']), last_change: z.string() })
    .nullable(),
});
