// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Regression for the dashboard hydration mismatch: the analytics/votes CSV export
// links must not embed a render-time `new Date()` value. Reading the clock during
// render made the server HTML and the first client render disagree — React reported
// a hydration mismatch (server `to=…375Z` vs client `to=…958Z`). The server render
// must be deterministic: the range is resolved after mount, so the SSR markup's CSV
// href carries only `?format=csv` (no `from`/`to`) until the client fills it in.
describe('dashboard CSV export href is hydration-safe', () => {
  it('AnalyticsPanel server render omits the clock-derived from/to', async () => {
    const { AnalyticsPanel } = await import('./analytics-panel');
    const html = renderToStaticMarkup(<AnalyticsPanel servers={[]} />);
    expect(html).toContain('/api/v1/analytics/dashboard?format=csv');
    expect(html).not.toContain('from=');
  });

  it('VoteAnalyticsPanel server render omits the clock-derived from/to', async () => {
    const { VoteAnalyticsPanel } = await import('./vote-analytics-panel');
    const html = renderToStaticMarkup(<VoteAnalyticsPanel servers={[]} />);
    expect(html).toContain('/api/v1/analytics/votes?format=csv');
    expect(html).not.toContain('from=');
  });
});
