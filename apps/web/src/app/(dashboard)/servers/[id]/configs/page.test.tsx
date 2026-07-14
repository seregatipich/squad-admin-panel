// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/configs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: { options?: { readOnly?: boolean } }) => (
    <div data-testid="monaco-stub" data-readonly={String(Boolean(props.options?.readOnly))} />
  ),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import ConfigsPage from './page';

const MANAGED_ROTATION_CONTENT = [
  '// operator header',
  '//SQUAD-PANEL BEGIN — не редактировать вручную',
  'Yehorivka RAAS v11',
  '//SQUAD-PANEL END',
].join('\r\n');

const PLAIN_CONFIG_CONTENT = '[SquadName]\nName=Test Server\n';

function mockFetch(fileName: string, content: string, behavior: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/configs')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                { name: fileName, size: content.length, sha256: 'abc', behavior, exists: true },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith(`/configs/${fileName}`)) {
        return Promise.resolve(
          new Response(JSON.stringify({ name: fileName, content, sha256: 'abc', behavior }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ConfigsPage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

describe('ConfigsPage', () => {
  it('is a valid React component', () => {
    expect(ConfigsPage).toBeDefined();
    expect(typeof ConfigsPage).toBe('function');
  });

  it('renders LayerRotation.cfg read-only with a managed-segment banner when it contains the markers', async () => {
    mockFetch('LayerRotation.cfg', MANAGED_ROTATION_CONTENT, 'rotation');
    await renderPage();
    const fileButton = await screen.findByText('LayerRotation.cfg');
    await act(async () => {
      fileButton.click();
    });
    await screen.findByTestId('monaco-stub');
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByText(/управляется панелью/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '«Ротация»' })).toHaveAttribute(
      'href',
      '/servers/abc/rotation',
    );
  });

  it('keeps a plain config file editable with no banner', async () => {
    mockFetch('Server.cfg', PLAIN_CONFIG_CONTENT, 'requires_restart');
    await renderPage();
    const fileButton = await screen.findByText('Server.cfg');
    await act(async () => {
      fileButton.click();
    });
    await screen.findByTestId('monaco-stub');
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');
    expect(screen.queryByText(/управляется панелью/)).not.toBeInTheDocument();
  });
});
