import { describe, expect, it } from 'vitest';
import ChatFlagsPage from './page';

describe('ChatFlagsPage', () => {
  it('is a valid React component', () => {
    expect(ChatFlagsPage).toBeDefined();
    expect(typeof ChatFlagsPage).toBe('function');
  });
});
