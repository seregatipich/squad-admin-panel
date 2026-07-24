import { z } from 'zod';

export const serverSettingsUpdate = z
  .object({
    game_port: z.number().int().min(1024).max(65_535).optional(),
    query_port: z.number().int().min(1024).max(65_535).optional(),
    beacon_port: z.number().int().min(1024).max(65_535).optional(),
    rcon_port: z.number().int().min(1024).max(65_535).optional(),
    max_players: z.number().int().min(1).max(100).optional(),
    tickrate: z.number().int().min(10).max(60).optional(),
    multihome: z.string().nullable().optional(),
    extra_args: z.string().optional(),
    cpu_affinity: z.string().nullable().optional(),
    cpu_weight: z.number().int().min(1).max(10_000).nullable().optional(),
    niceness: z.number().int().min(-20).max(19).nullable().optional(),
    memory_high_mb: z.number().int().min(2048).nullable().optional(),
    memory_max_mb: z.number().int().min(2048).nullable().optional(),
    io_weight: z.number().int().min(10).max(1000).nullable().optional(),
    // AUTO-4 (#75): per-server toggle for panel-owned in-game chat commands and
    // the `!rules` reply text. `rules_text` is capped to worker-rcon's
    // single-message limit since it is answered with one `AdminWarn`.
    chat_commands_enabled: z.boolean().optional(),
    rules_text: z.string().max(300).nullable().optional(),
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

export const serverPatch = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    license_id: z.string().max(200).nullable().optional(),
    license_key: z.string().max(500).nullable().optional(),
  })
  .strict();
export type ServerPatch = z.infer<typeof serverPatch>;

export const a2sStatus = z
  .object({
    visible: z.boolean(),
    server_name: z.string().optional(),
    map: z.string().optional(),
    players: z.number().int().optional(),
    max_players: z.number().int().optional(),
    latency_ms: z.number().optional(),
    reason: z.string().optional(),
    queried_at: z.string().datetime(),
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
