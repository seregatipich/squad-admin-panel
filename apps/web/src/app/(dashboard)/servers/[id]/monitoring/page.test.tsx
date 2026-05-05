import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/MetricsChart', () => ({ MetricsChart: () => null }));

import MonitoringPage from './page';

describe('MonitoringPage', () => {
  it('is a valid React component', () => {
    expect(MonitoringPage).toBeDefined();
    expect(typeof MonitoringPage).toBe('function');
  });
});
