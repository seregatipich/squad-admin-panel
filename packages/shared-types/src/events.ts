import { z } from 'zod';

export const EVENT_TYPES = [
  'server.ready',
  'server.starting',
  'server.running',
  'server.stopping',
  'server.stopped',
  'server.crashed',
  'server.restarted',
  'server.updated',
  'server.installed',
  'server.install.started',
  'server.install.progress',
  'server.install.failed',
  'server.install.completed',

  'player.connected',
  'player.disconnected',
  'player.name_changed',
  'player_report',

  'moderation.ban',
  'moderation.kick',
  'moderation.warn',
  'moderation.unban',

  'match.started',
  'match.ended',

  'rcon.connected',
  'rcon.disconnected',
  'rcon.players_polled',

  'bridge.connected',
  'bridge.disconnected',

  'performance.degraded',

  'banname.matched',
  'externalban.matched',
  'alt.ban_evasion_suspected',
  'seed.call_sent',
  'bansync.completed',
  'bansync.failed',
  'server.seeding_started',
  'server.seeding_ended',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const actorKind = z.enum(['user', 'system', 'external']);

export const eventEnvelope = z
  .object({
    event_id: z.string().uuid(),
    version: z.number().int().positive(),
    type: z.enum(EVENT_TYPES),
    server_id: z.string().uuid().nullable(),
    ts: z.string().datetime(),
    actor: z
      .object({
        kind: actorKind,
        id: z.string().nullable(),
      })
      .nullable(),
    correlation_id: z.string().uuid().nullable(),
    payload: z.unknown(),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelope>;

export const playerConnectedPayload = z
  .object({
    steam_id64: z.string().regex(/^\d{17}$/),
    eos_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    name: z.string().min(1).max(128),
    ip: z.string().nullable(),
  })
  .strict();
export type PlayerConnectedPayload = z.infer<typeof playerConnectedPayload>;

export const playerDisconnectedPayload = z
  .object({
    steam_id64: z.string().regex(/^\d{17}$/),
    eos_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type PlayerDisconnectedPayload = z.infer<typeof playerDisconnectedPayload>;

/** Payload emitted when an in-game or panel report is recorded. */
export const playerReportPayload = z
  .object({
    report_id: z.string().uuid(),
    reporter_player_id: z.string().uuid().nullable(),
    reporter_name: z.string().min(1),
    target_player_id: z.string().uuid().nullable(),
    target_raw: z.string().min(1),
    body: z.string().min(1),
    channel: z.string().min(1),
    source: z.enum(['ingame', 'ui']),
  })
  .strict();
export type PlayerReportPayload = z.infer<typeof playerReportPayload>;

/** Payload shared by moderation ban/kick/warn/unban event envelopes. */
export const moderationActionPayload = z
  .object({
    moderation_action_id: z.string().uuid(),
    action_type: z.enum(['ban', 'kick', 'warn', 'unban']),
    player_id: z.string().uuid(),
    steam_id64: z
      .string()
      .regex(/^\d{17}$/)
      .nullable(),
    eos_id: z.string().min(1).nullable(),
    name: z.string().min(1),
    reason: z.string().nullable(),
    duration: z.string().nullable(),
    actor_name: z.string().min(1),
    report_id: z.string().uuid().nullable(),
  })
  .strict();
export type ModerationActionPayload = z.infer<typeof moderationActionPayload>;

export const bannameMatchedPayload = z
  .object({
    player_id: z.string().uuid().nullable(),
    rule_id: z.string().uuid(),
    nickname: z.string().min(1).max(128),
    action: z.enum(['kick', 'alert']),
    escalated: z.boolean(),
  })
  .strict();
export type BannameMatchedPayload = z.infer<typeof bannameMatchedPayload>;

export const externalBanMatchedPayload = z
  .object({
    player_id: z.string().uuid().nullable(),
    source_id: z.string().uuid(),
    external_ban_id: z.string().uuid(),
    steam_id64: z.string().regex(/^\d{17}$/),
    eos_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    name: z.string().min(1).max(128),
    source_name: z.string().min(1).max(128),
    reason: z.string().max(1024).nullable(),
    action: z.enum(['none', 'alert', 'kick']),
  })
  .strict();
export type ExternalBanMatchedPayload = z.infer<typeof externalBanMatchedPayload>;

/** Payload emitted when a confirmed alt of an actively banned player connects. */
export const altBanEvasionSuspectedPayload = z
  .object({
    target_player_id: z.string().uuid(),
    confirmed_alt_ids: z.array(z.string().uuid()).min(1),
    candidate_ids: z.array(z.string().uuid()),
    trigger: z.literal('player_connected'),
    server_id: z.string().uuid().nullable(),
    connection_event_id: z.string().uuid(),
  })
  .strict();
export type AltBanEvasionSuspectedPayload = z.infer<typeof altBanEvasionSuspectedPayload>;

export const seedCallSentPayload = z
  .object({
    server_name: z.string().min(1).max(128),
    join_link: z.string().url().max(512),
    seed_layer: z.string().max(128).nullable(),
    scheduled_for: z.string().datetime().nullable(),
    source: z.enum(['manual', 'schedule']),
    message: z.string().max(512),
  })
  .strict();
export type SeedCallSentPayload = z.infer<typeof seedCallSentPayload>;

export const rconPlayersPolledPayload = z
  .object({
    players: z.array(
      z
        .object({
          steam_id64: z.string().regex(/^\d{17}$/),
          eos_id: z
            .string()
            .regex(/^[a-f0-9]{32}$/)
            .nullable(),
          name: z.string().min(1).max(128),
          team_id: z.number().int().nullable(),
          squad_id: z.number().int().nullable(),
          is_leader: z.boolean().optional(),
          role: z.string().optional(),
        })
        .strict(),
    ),
    polled_at: z.string().datetime(),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict();
export type RconPlayersPolledPayload = z.infer<typeof rconPlayersPolledPayload>;

export const matchStateChangedPayload = z
  .object({
    from_state: z.string(),
    to_state: z.string(),
    layer: z.string().nullable(),
    game_mode: z.string().nullable(),
  })
  .strict();
export type MatchStateChangedPayload = z.infer<typeof matchStateChangedPayload>;

export const serverLifecyclePayload = z
  .object({
    pid: z.number().int().positive().nullable(),
    reason: z.string().nullable(),
    exit_code: z.number().int().nullable(),
  })
  .strict();
export type ServerLifecyclePayload = z.infer<typeof serverLifecyclePayload>;

/**
 * Payload for `server.seeding_started` / `server.seeding_ended` transitions
 * emitted by worker-rcon's per-server seeding state machine (SEED-1, #140).
 * See `apps/workers/rcon/src/seeding.ts` for the state machine itself.
 */
export const seedingTransitionPayload = z
  .object({
    player_count: z.number().int().nonnegative(),
    layer: z.string().nullable(),
    live_at: z.number().int().positive(),
    hysteresis: z.number().int().nonnegative(),
    progress_pct: z.number().int().min(0).max(100),
    server_name: z.string().min(1).max(128).optional(),
    join_link: z.string().url().max(512).optional(),
  })
  .strict();
export type SeedingTransitionPayload = z.infer<typeof seedingTransitionPayload>;

export const PAYLOAD_SCHEMAS: Partial<Record<EventType, z.ZodTypeAny>> = {
  'player.connected': playerConnectedPayload,
  'player.disconnected': playerDisconnectedPayload,
  player_report: playerReportPayload,
  'moderation.ban': moderationActionPayload,
  'moderation.kick': moderationActionPayload,
  'moderation.warn': moderationActionPayload,
  'moderation.unban': moderationActionPayload,
  'rcon.players_polled': rconPlayersPolledPayload,
  'match.started': matchStateChangedPayload,
  'match.ended': matchStateChangedPayload,
  'server.ready': serverLifecyclePayload,
  'server.starting': serverLifecyclePayload,
  'server.running': serverLifecyclePayload,
  'server.stopping': serverLifecyclePayload,
  'server.stopped': serverLifecyclePayload,
  'server.crashed': serverLifecyclePayload,
  'banname.matched': bannameMatchedPayload,
  'externalban.matched': externalBanMatchedPayload,
  'alt.ban_evasion_suspected': altBanEvasionSuspectedPayload,
  'seed.call_sent': seedCallSentPayload,
  'server.seeding_started': seedingTransitionPayload,
  'server.seeding_ended': seedingTransitionPayload,
};

export function validatePayload<T extends EventType>(
  type: T,
  payload: unknown,
): { ok: true; data: unknown } | { ok: false; errors: z.ZodIssue[] } {
  const schema = PAYLOAD_SCHEMAS[type];
  if (!schema) return { ok: true, data: payload };
  const res = schema.safeParse(payload);
  if (res.success) return { ok: true, data: res.data };
  return { ok: false, errors: res.error.issues };
}

export const STREAM_NAME = {
  eventsServer: (serverId: string) => `events:server:${serverId}`,
  eventsGlobal: () => 'events:global',
  eventsDlq: () => 'events:dlq',
} as const;

export const DEDUP_KEY = (group: string, eventId: string) => `dedup:${group}:${eventId}`;
export const DEDUP_TTL_SECONDS = 86_400;

export const CONSUMER_GROUP = {
  playersProjector: 'players-projector:v1',
  auditArchiver: 'audit-archiver:v1',
  stats: 'stats:v1',
} as const;

export const XAUTOCLAIM_IDLE_MS = 120_000;
export const XAUTOCLAIM_TICK_MS = 30_000;
export const DLQ_DELIVER_THRESHOLD = 5;
