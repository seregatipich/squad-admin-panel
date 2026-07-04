import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { messageTemplates } from '../src/schema/message-templates.js';

describe('message_templates schema', () => {
  it('is exported from the schema barrel', () => {
    expect(schema).toHaveProperty('messageTemplates');
  });

  it('maps to the message_templates table', () => {
    expect(getTableName(messageTemplates)).toBe('message_templates');
  });

  it('declares the required columns with the right nullability and defaults', () => {
    const cols = getTableColumns(messageTemplates);
    expect(cols.id.notNull).toBe(true);
    expect(cols.id.primary).toBe(true);
    expect(cols.title.notNull).toBe(true);
    expect(cols.body.notNull).toBe(true);
    expect(cols.category.notNull).toBe(true);
    expect(cols.locale.notNull).toBe(true);
    expect(cols.sortOrder.notNull).toBe(true);
    expect(cols.sortOrder.hasDefault).toBe(true);
    expect(cols.isEnabled.notNull).toBe(true);
    expect(cols.isEnabled.hasDefault).toBe(true);
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.updatedAt.notNull).toBe(true);
  });

  it('keeps created_by nullable for ON DELETE SET NULL semantics', () => {
    const cols = getTableColumns(messageTemplates);
    expect(cols.createdBy.notNull).toBe(false);
  });
});
