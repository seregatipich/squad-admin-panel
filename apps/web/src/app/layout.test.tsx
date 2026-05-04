import { describe, expect, it } from 'vitest';
import RootLayout, { metadata } from './layout';

describe('RootLayout', () => {
  it('is a valid React component', () => {
    expect(RootLayout).toBeDefined();
    expect(typeof RootLayout).toBe('function');
  });

  it('exports metadata with title', () => {
    expect(metadata).toBeDefined();
    expect(metadata.title).toBe('Squad Admin Panel');
  });
});
