// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: () => null,
  DiffEditor: () => null,
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

describe('monaco loader origin', () => {
  /**
   * Regression guard for the editor hanging on "Loading..." forever: the AMD
   * loader used to point at cdn.jsdelivr.net, so any client whose network
   * could not reach the CDN never got an editor — the request simply never
   * resolved, and `@monaco-editor/react` has no timeout to surface it. The
   * bundle is vendored into `public/monaco/vs` by `scripts/sync-monaco.mjs`,
   * so the path must stay same-origin and CDN-free.
   */
  it('loads monaco from our own origin, never a third-party CDN', async () => {
    const { loader } = await import('@monaco-editor/react');
    await import('./page');

    expect(loader.config).toHaveBeenCalledWith({ paths: { vs: '/monaco/vs' } });

    const configured = vi.mocked(loader.config).mock.calls[0]?.[0]?.paths?.vs ?? '';
    expect(configured).not.toMatch(/^https?:\/\//);
  });
});
