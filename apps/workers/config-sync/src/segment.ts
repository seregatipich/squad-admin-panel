import { createHash } from 'node:crypto';
import type {
  AdminEntry,
  ClanPriorityEntry,
  ManagedSegmentBody,
  RoleEntry,
  SegmentInputs,
} from '@squad/shared-config/admins-config';
import {
  BEGIN_MARKER,
  buildManagedSegmentBody,
  CLAN_PRIORITY_GROUP_NAME,
  END_MARKER,
  findManagedSegment,
  spliceManagedSegment,
} from '@squad/shared-config/admins-config';

export {
  BEGIN_MARKER,
  buildManagedSegmentBody,
  CLAN_PRIORITY_GROUP_NAME,
  END_MARKER,
  findManagedSegment,
  spliceManagedSegment,
};
export type { AdminEntry, ClanPriorityEntry, ManagedSegmentBody, RoleEntry, SegmentInputs };

export interface ManagedSegment extends ManagedSegmentBody {
  hash: string;
}

/** sha256 of a segment body, used only for the idempotency / drift check. */
export function hashSegment(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Build the managed segment plus its sha256 idempotency hash. The body is
 * produced entirely by the shared `buildManagedSegmentBody` generator, so the
 * bytes written to Admins.cfg here are identical to the web panel's preview
 * rendered from the same shared function.
 */
export function buildManagedSegment(inputs: SegmentInputs): ManagedSegment {
  const segment = buildManagedSegmentBody(inputs);
  return { ...segment, hash: hashSegment(segment.body) };
}
