import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { configVersions, MAP_VOTE_SELECTIONS, type MapVoteSelection } from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Filename the map-vote screen's history is stored under in `config_versions`
 * — the same table, chain and author columns the config editor uses, so a
 * change made on that screen is versioned exactly like a change to a `.cfg`.
 *
 * It is deliberately NOT one of `ALLOWED_CONFIG_FILES`: map auto-selection
 * writes no file on the game server (the scheduler applies the pick over RCON
 * with `AdminSetNextLayer`), so `/configs` must never list it, offer it for
 * editing, or sweep it for drift against a disk that has no such file.
 */
export const MAP_VOTE_VERSION_FILENAME = 'map-vote.json';

const snapshotSchema = z.object({
  enabled: z.boolean(),
  selection: z.enum(MAP_VOTE_SELECTIONS),
  layer_cooldown: z.number().int().min(0).max(20),
  map_cooldown: z.number().int().min(0).max(20),
  broadcast_template: z.string().max(300).nullable(),
  candidates: z
    .array(
      z.object({
        layer: z.string().min(1).max(200),
        weight: z.number().int().min(1).max(100),
        enabled: z.boolean(),
      }),
    )
    .max(200),
});

export type MapVoteSnapshot = z.infer<typeof snapshotSchema>;

/**
 * Renders a snapshot as the stored version content.
 *
 * Candidates are sorted by layer name and the key order is fixed, so two saves
 * that describe the same pool produce byte-identical content — otherwise the
 * sha256 comparison below would record a new version every time the UI
 * happened to send its rows in another order.
 */
export function serializeMapVoteSnapshot(snapshot: MapVoteSnapshot): string {
  const ordered = {
    enabled: snapshot.enabled,
    selection: snapshot.selection,
    layer_cooldown: snapshot.layer_cooldown,
    map_cooldown: snapshot.map_cooldown,
    broadcast_template: snapshot.broadcast_template,
    candidates: [...snapshot.candidates]
      .sort((left, right) => left.layer.localeCompare(right.layer))
      .map((candidate) => ({
        layer: candidate.layer,
        weight: candidate.weight,
        enabled: candidate.enabled,
      })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parses stored version content back into a snapshot; `null` when unusable. */
export function parseMapVoteSnapshot(content: string): MapVoteSnapshot | null {
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RecordMapVoteVersionInput {
  serverId: string;
  snapshot: MapVoteSnapshot;
  message: string | null;
  authorPlayerId: string | null;
  authorIp: string | null;
}

export interface RecordMapVoteVersionResult {
  /** `null` when the snapshot matched the current tip and nothing was written. */
  versionId: string | null;
  unchanged: boolean;
  sha256: string;
}

/**
 * Appends one map-vote version, chained to the previous one.
 *
 * A save that changes nothing writes no row: the screen sends the whole form
 * on every click, and an unchanged history is more useful than one padded
 * with identical entries. Failure here must never fail the save that already
 * happened — the caller keeps its 200 and the history simply misses an entry.
 */
export async function recordMapVoteVersion(
  db: DatabaseClient,
  input: RecordMapVoteVersionInput,
): Promise<RecordMapVoteVersionResult> {
  const content = serializeMapVoteSnapshot(input.snapshot);
  const sha = createHash('sha256').update(content).digest();

  const previous = await db
    .select({ id: configVersions.id, sha256: configVersions.sha256 })
    .from(configVersions)
    .where(
      and(
        eq(configVersions.serverId, input.serverId),
        eq(configVersions.filename, MAP_VOTE_VERSION_FILENAME),
      ),
    )
    .orderBy(desc(configVersions.createdAt))
    .limit(1);

  const tip = previous[0];
  if (tip && Buffer.from(tip.sha256 as unknown as Buffer).equals(sha)) {
    return { versionId: null, unchanged: true, sha256: sha.toString('hex') };
  }

  const inserted = await db
    .insert(configVersions)
    .values({
      serverId: input.serverId,
      filename: MAP_VOTE_VERSION_FILENAME,
      content,
      sha256: sha,
      parentVersionId: tip?.id ?? null,
      authorPlayerId: input.authorPlayerId,
      // The table requires an author, and a player id alone satisfies it; the
      // label is what a system-issued restore or a token write falls back to.
      authorLabel: input.authorPlayerId ? null : 'panel',
      authorIp: input.authorIp,
      message: input.message,
    })
    .returning({ id: configVersions.id });

  return {
    versionId: inserted[0]?.id ?? null,
    unchanged: false,
    sha256: sha.toString('hex'),
  };
}

export type { MapVoteSelection };
