import type { DatabaseClient } from '@squad/db';
import { issueLabels } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';

export const SYSTEM_ISSUE_LABELS = [
  { name: 'bug', color: '#dc2626' },
  { name: 'suggestion', color: '#2563eb' },
  { name: 'question', color: '#7c3aed' },
] as const;

export async function ensureSystemIssueLabels(db: DatabaseClient): Promise<void> {
  await db
    .insert(issueLabels)
    .values(
      SYSTEM_ISSUE_LABELS.map((label) => ({
        id: uuidv7(),
        name: label.name,
        color: label.color,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: issueLabels.name });
}
