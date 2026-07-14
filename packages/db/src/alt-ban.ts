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

/** Raises one AUTO-3 alert per enabled custom ALT-7 rule and publishes it live. */
export async function raiseAltBanAlert(
  db: DatabaseClient,
  publisher: AltBanAlertPublisher,
  payload: AltBanAlertPayload,
): Promise<number> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));

  let raised = 0;
  for (const rule of rules) {
    const config = rule.config as AltBanAlertRuleConfig;
    if (config.eventKind !== 'alt.ban_evasion_suspected') continue;
    await db.insert(alertEvents).values({
      id: uuidv7(),
      ruleId: rule.id,
      severity: config.severity ?? 'warning',
      payload,
    });
    await publisher.publish(
      'live-bus',
      JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
    );
    raised++;
  }
  return raised;
}
