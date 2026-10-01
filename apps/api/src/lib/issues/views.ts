/** View types and serializers of the issue tracker routes. */

import type { IssueLinkEntityType, issues } from '@squad/db/schema';
import type {
  IssueCommentLiveView,
  IssueLiveView,
  IssuePlayerRef,
} from '../../plugins/live-bus.js';

/** Shown for a link whose polymorphic target row no longer exists. */
export const DELETED_ENTITY_LABEL = 'Удалённый объект';

/** A label as shown on a ticket. */
export interface IssueLabelView {
  id: string;
  name: string;
  color: string;
}

/** A ticket→entity link expanded for display: `label` is human-readable, `ref` is where a click goes. */
export interface IssueLinkView {
  id: string;
  issue_id: string;
  entity_type: IssueLinkEntityType;
  entity_id: string;
  label: string;
  ref: string | null;
  exists: boolean;
  created_by: string | null;
  created_at: string;
}

/** The polymorphic entity a ticket link points at. */
export interface LinkTarget {
  entity_type: IssueLinkEntityType;
  entity_id: string;
}

/** Display label and click target of a resolved link entity. */
export interface ResolvedEntity {
  label: string;
  ref: string | null;
}

/** A row of the `issues` table. */
export type IssueRow = typeof issues.$inferSelect;

/** Map key identifying a link target. */
export function targetKey(target: LinkTarget): string {
  return `${target.entity_type}:${target.entity_id}`;
}

function playerRef(id: string | null, names: Map<string, string>): IssuePlayerRef | null {
  if (!id) return null;
  return { id, name: names.get(id) ?? id };
}

/** Live-bus and API view of an issue row. */
export function serializeIssue(
  row: IssueRow,
  labels: IssueLabelView[],
  names: Map<string, string>,
): IssueLiveView {
  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    body: row.body,
    state: row.state as IssueLiveView['state'],
    author_player_id: row.authorPlayerId,
    assignee_player_id: row.assigneePlayerId,
    author: playerRef(row.authorPlayerId, names),
    assignee: playerRef(row.assigneePlayerId, names),
    labels,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

/** Live-bus and API view of an issue comment. */
export function serializeComment(
  row: { id: string; authorPlayerId: string; body: string; createdAt: Date },
  issueId: string,
  names: Map<string, string>,
): IssueCommentLiveView {
  return {
    id: row.id,
    issue_id: issueId,
    author_player_id: row.authorPlayerId,
    author: playerRef(row.authorPlayerId, names),
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
}
