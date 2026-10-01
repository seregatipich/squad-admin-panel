/** Database lookups shared by the issue tracker route modules. */

import {
  type IssueLinkEntityType,
  type IssueLinkRow,
  issueLabelLinks,
  issueLabels,
  issueLinks,
  issues,
  mediaFiles,
  moderationActions,
  players,
  servers,
} from '@squad/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  IssueLabelView,
  IssueLinkView,
  IssueRow,
  LinkTarget,
  ResolvedEntity,
} from './views.js';
import { DELETED_ENTITY_LABEL, targetKey } from './views.js';

/**
 * Binds the issue lookups to one Fastify instance's database.
 *
 * @param app - The instance whose `db` decoration the lookups query.
 * @returns Label, issue-row, player-name and link resolvers: link targets are
 *   resolved per `entity_type`, and a target whose row is gone resolves to nothing.
 */
export function issueQueries(app: FastifyInstance) {
  async function labelsForIssues(issueIds: string[]): Promise<Map<string, IssueLabelView[]>> {
    const grouped = new Map<string, IssueLabelView[]>();
    if (issueIds.length === 0) return grouped;
    const rows = await app.db
      .select({
        issueId: issueLabelLinks.issueId,
        id: issueLabels.id,
        name: issueLabels.name,
        color: issueLabels.color,
      })
      .from(issueLabelLinks)
      .innerJoin(issueLabels, eq(issueLabels.id, issueLabelLinks.labelId))
      .where(inArray(issueLabelLinks.issueId, issueIds))
      .orderBy(issueLabels.name);
    for (const row of rows) {
      const list = grouped.get(row.issueId) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      grouped.set(row.issueId, list);
    }
    return grouped;
  }

  async function resolveLabelIds(
    names: string[],
  ): Promise<{ ok: true; ids: string[] } | { ok: false; unknown: string[] }> {
    const deduped = Array.from(new Set(names));
    if (deduped.length === 0) return { ok: true, ids: [] };
    const rows = await app.db
      .select({ id: issueLabels.id, name: issueLabels.name })
      .from(issueLabels)
      .where(inArray(issueLabels.name, deduped));
    const foundByName = new Map(rows.map((row) => [row.name, row.id]));
    const unknown = deduped.filter((name) => !foundByName.has(name));
    if (unknown.length > 0) return { ok: false, unknown };
    return { ok: true, ids: deduped.map((name) => foundByName.get(name) as string) };
  }

  async function getIssueRow(id: string): Promise<IssueRow | null> {
    const rows = await app.db.select().from(issues).where(eq(issues.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function resolvePlayerNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
    const names = new Map<string, string>();
    if (unique.length === 0) return names;
    const rows = await app.db
      .select({ id: players.id, name: players.canonicalName })
      .from(players)
      .where(inArray(players.id, unique));
    for (const row of rows) names.set(row.id, row.name);
    return names;
  }

  /**
   * Batch-resolves the polymorphic targets of a set of links, one query per
   * `entity_type` present. A key missing from the returned map means the row
   * is gone — `entity_id` carries no foreign key, so that is a normal state
   * rather than an integrity failure, and callers render it as deleted.
   */
  async function resolveEntities(targets: LinkTarget[]): Promise<Map<string, ResolvedEntity>> {
    const resolved = new Map<string, ResolvedEntity>();
    const byType = new Map<IssueLinkEntityType, string[]>();
    for (const target of targets) {
      const list = byType.get(target.entity_type) ?? [];
      if (!list.includes(target.entity_id)) list.push(target.entity_id);
      byType.set(target.entity_type, list);
    }

    const playerIds = byType.get('player');
    if (playerIds?.length) {
      const rows = await app.db
        .select({ id: players.id, name: players.canonicalName })
        .from(players)
        .where(inArray(players.id, playerIds));
      for (const row of rows) {
        resolved.set(`player:${row.id}`, { label: row.name, ref: `/players/${row.id}` });
      }
    }

    const serverIds = byType.get('server');
    if (serverIds?.length) {
      const rows = await app.db
        .select({ id: servers.id, name: servers.displayName })
        .from(servers)
        // Soft-deleted servers 404 on `/servers/:id`, so a link to one must
        // read as gone rather than hand out a dead ref.
        .where(and(inArray(servers.id, serverIds), isNull(servers.deletedAt)));
      for (const row of rows) {
        resolved.set(`server:${row.id}`, { label: row.name, ref: `/servers/${row.id}` });
      }
    }

    const actionIds = byType.get('moderation_action');
    if (actionIds?.length) {
      const rows = await app.db
        .select({
          id: moderationActions.id,
          actionType: moderationActions.actionType,
          playerId: moderationActions.playerId,
          createdAt: moderationActions.createdAt,
        })
        .from(moderationActions)
        .where(inArray(moderationActions.id, actionIds));
      for (const row of rows) {
        resolved.set(`moderation_action:${row.id}`, {
          label: `${row.actionType} · ${row.createdAt.toISOString().slice(0, 10)}`,
          // No moderation-action page exists yet (MOD-2, #59); the offender's
          // card is the surface that shows the action.
          ref: `/players/${row.playerId}`,
        });
      }
    }

    const mediaIds = byType.get('media_file');
    if (mediaIds?.length) {
      const rows = await app.db
        .select({
          id: mediaFiles.id,
          title: mediaFiles.title,
          originalFilename: mediaFiles.originalFilename,
        })
        .from(mediaFiles)
        // Same reasoning as servers: the stream route only serves live rows.
        .where(and(inArray(mediaFiles.id, mediaIds), isNull(mediaFiles.deletedAt)));
      for (const row of rows) {
        resolved.set(`media_file:${row.id}`, {
          label: row.title ?? row.originalFilename,
          ref: `/api/v1/media/${row.id}/stream`,
        });
      }
    }

    return resolved;
  }

  async function findUnknownTargets(targets: LinkTarget[]): Promise<LinkTarget[]> {
    if (targets.length === 0) return [];
    const resolved = await resolveEntities(targets);
    return targets.filter((target) => !resolved.has(targetKey(target)));
  }

  async function serializeLinks(rows: IssueLinkRow[]): Promise<IssueLinkView[]> {
    if (rows.length === 0) return [];
    const targets: LinkTarget[] = rows.map((row) => ({
      entity_type: row.entityType as IssueLinkEntityType,
      entity_id: row.entityId,
    }));
    const resolved = await resolveEntities(targets);
    return rows.map((row, index) => {
      // biome-ignore lint/style/noNonNullAssertion: targets is built 1:1 from rows
      const hit = resolved.get(targetKey(targets[index]!));
      return {
        id: row.id,
        issue_id: row.issueId,
        entity_type: row.entityType as IssueLinkEntityType,
        entity_id: row.entityId,
        label: hit?.label ?? DELETED_ENTITY_LABEL,
        ref: hit?.ref ?? null,
        exists: hit !== undefined,
        created_by: row.createdBy,
        created_at: row.createdAt.toISOString(),
      };
    });
  }

  async function linksForIssue(issueId: string): Promise<IssueLinkView[]> {
    const rows = await app.db
      .select()
      .from(issueLinks)
      .where(eq(issueLinks.issueId, issueId))
      .orderBy(issueLinks.createdAt);
    return serializeLinks(rows);
  }

  return {
    labelsForIssues,
    resolveLabelIds,
    getIssueRow,
    resolvePlayerNames,
    resolveEntities,
    findUnknownTargets,
    serializeLinks,
    linksForIssue,
  };
}
