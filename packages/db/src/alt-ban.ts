import { and, eq, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { DatabaseClient } from './client.js';
import { alertEvents, alertRules, playerLinks } from './schema/index.js';

interface AltBanAlertRuleConfig {
  eventKind?: string;
  severity?: 'info' | 'warning' | 'critical';
}

/** Minimal publisher contract used by the shared ALT-7 alert emitter. */
export interface AltBanAlertPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/** One confirmed `alt` relationship from the requested player to its linked account. */
export interface ConfirmedAltLink {
  id: string;
  linkedPlayerId: string;
  linkType: string;
  status: string;
}

interface AltBanAlertPayloadBase {
  target_player_id: string;
  confirmed_alt_ids: string[];
  candidate_ids: string[];
}

/** Alert context emitted when an administrator bans a player with linked accounts. */
export interface AdminBanAltAlertPayload extends AltBanAlertPayloadBase {
  trigger: 'admin_ban';
}

/** Alert context emitted when an alt of an actively banned player connects. */
export interface ConnectAltBanAlertPayload extends AltBanAlertPayloadBase {
  trigger: 'player_connected';
  server_id: string | null;
  connection_event_id: string;
}

export type AltBanAlertPayload = AdminBanAltAlertPayload | ConnectAltBanAlertPayload;

/**
 * Returns confirmed relationships classified as `alt`, normalized so callers
 * always receive the account on the opposite side of the undirected link.
 */
export async function findConfirmedAltLinks(
  db: DatabaseClient,
  playerId: string,
): Promise<ConfirmedAltLink[]> {
  const links = await db
    .select({
      id: playerLinks.id,
      playerAId: playerLinks.playerAId,
      playerBId: playerLinks.playerBId,
      linkType: playerLinks.linkType,
      status: playerLinks.status,
    })
    .from(playerLinks)
    .where(
      and(
        eq(playerLinks.status, 'confirmed'),
        eq(playerLinks.linkType, 'alt'),
        or(eq(playerLinks.playerAId, playerId), eq(playerLinks.playerBId, playerId)),
      ),
    );

  return links.map((link) => ({
    id: link.id,
    linkedPlayerId: link.playerAId === playerId ? link.playerBId : link.playerAId,
    linkType: link.linkType,
    status: link.status,
  }));
}

const ALT_BAN_EVENT_KIND = 'alt.ban_evasion_suspected';

/**
 * Raises one AUTO-3 alert per enabled custom ALT-7 rule and publishes it live.
 *
 * Every matching rule's `alert_events` row is written by one INSERT before
 * anything is published, so a live-bus failure can never leave a matching rule
 * without its stored alert. Each stored alert then gets its own
 * `alert.triggered` frame carrying `event_kind`, `alert_event_id`, `rule_id`
 * and `severity` — the shape the other alert producers use — so clients and
 * the live fan-out can classify it. The frame deliberately omits the player
 * ids: the link details stay in `alert_events` for authorized readers instead
 * of going to every connected session.
 *
 * @returns The number of alerts stored.
 * @throws When the insert fails, or when publishing a frame fails (the alerts
 *   are stored by then).
 */
export async function raiseAltBanAlert(
  db: DatabaseClient,
  publisher: AltBanAlertPublisher,
  payload: AltBanAlertPayload,
): Promise<number> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));

  const alerts = rules
    .filter((rule) => (rule.config as AltBanAlertRuleConfig).eventKind === ALT_BAN_EVENT_KIND)
    .map((rule) => ({
      id: uuidv7(),
      ruleId: rule.id,
      severity: (rule.config as AltBanAlertRuleConfig).severity ?? 'warning',
      payload,
    }));
  if (alerts.length === 0) return 0;

  await db.insert(alertEvents).values(alerts);
  const ts = new Date().toISOString();
  for (const alert of alerts) {
    await publisher.publish(
      'live-bus',
      JSON.stringify({
        type: 'alert.triggered',
        ts,
        data: {
          event_kind: ALT_BAN_EVENT_KIND,
          alert_event_id: alert.id,
          rule_id: alert.ruleId,
          severity: alert.severity,
          trigger: payload.trigger,
          ...(payload.trigger === 'player_connected' ? { server_id: payload.server_id } : {}),
        },
      }),
    );
  }
  return alerts.length;
}
