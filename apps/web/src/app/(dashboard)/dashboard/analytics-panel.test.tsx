import { describe, expect, it } from 'vitest';
import { AnalyticsPanel } from './analytics-panel';

describe('AnalyticsPanel', () => {
  it('is a valid React component', () => {
    expect(AnalyticsPanel).toBeDefined();
    expect(typeof AnalyticsPanel).toBe('function');
  });
});
