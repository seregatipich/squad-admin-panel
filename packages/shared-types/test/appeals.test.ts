import { describe, expect, it } from 'vitest';
import { appealErrorResponseSchema, appealListResponseSchema } from '../src/appeals.js';

const validItem = {
  id: 'a1',
  number: 7,
  status: 'pending',
  steam_id64: '76561198000000001',
  body: 'unban me',
  contact: null,
  decision_note: null,
  internal_note: null,
  created_at: '2026-07-19T10:00:00.000Z',
  updated_at: '2026-07-19T10:00:00.000Z',
  decided_at: null,
  player: null,
  moderation_action: null,
  handler: null,
};

describe('appealListResponseSchema', () => {
  it('accepts a well-formed list response', () => {
    const parsed = appealListResponseSchema.safeParse({
      items: [validItem],
      total: 1,
      page: 1,
      page_size: 20,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown status and a missing total', () => {
    expect(
      appealListResponseSchema.safeParse({
        items: [{ ...validItem, status: 'weird' }],
        total: 1,
        page: 1,
        page_size: 20,
      }).success,
    ).toBe(false);
    expect(appealListResponseSchema.safeParse({ items: [], page: 1, page_size: 20 }).success).toBe(
      false,
    );
  });
});

describe('appealErrorResponseSchema', () => {
  it('rejects a non-string error so it is never rendered as [object Object]', () => {
    expect(appealErrorResponseSchema.safeParse({ error: { a: 1 } }).success).toBe(false);
    expect(appealErrorResponseSchema.safeParse({ error: 'invalid_transition' }).success).toBe(true);
  });
});
