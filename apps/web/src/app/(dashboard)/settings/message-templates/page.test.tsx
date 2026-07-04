import { describe, expect, it } from 'vitest';
import MessageTemplatesPage from './page';

describe('MessageTemplatesPage', () => {
  it('is a valid React component', () => {
    expect(MessageTemplatesPage).toBeDefined();
    expect(typeof MessageTemplatesPage).toBe('function');
  });
});
