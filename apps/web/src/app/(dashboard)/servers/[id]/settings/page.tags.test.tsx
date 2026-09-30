// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'srv-1' })) };
});
vi.mock('@/components/TagInput', () => ({
  TagInput: ({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) => (
    <div>
      <output data-testid="tags">{tags.join(',')}</output>
      <button type="button" onClick={() => onChange([...tags, 'new'])}>
        add tag
      </button>
    </div>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: vi.fn(() => ({ push: vi.fn() })) }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import SettingsPage from './page';

const settings = {
  server_id: 'srv-1',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 100,
  tickrate: 50,
  multihome: null,
  extra_args: '',
  cpu_affinity: null,
  cpu_weight: null,
  niceness: null,
  memory_high_mb: null,
  memory_max_mb: null,
  io_weight: null,
  seed_live_at: 60,
  seed_hysteresis: 5,
  chat_commands_enabled: true,
  rules_text: null,
  archive_logs_to_backup: false,
};

function stubFetch(patchStatus: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/servers/srv-1' && init?.method === 'PATCH') {
        return new Response('{}', { status: patchStatus });
      }
      if (url === '/api/v1/servers/srv-1') {
        return new Response(
          JSON.stringify({
            server: {
              status: 'running',
              display_name: 'RAAS #1',
              tags: ['old'],
              runtime: 'container',
              license: null,
            },
            settings,
            container: null,
            host: null,
            connection: null,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/me') {
        return new Response(JSON.stringify({ squad_permissions: [] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage tags', () => {
  it('keeps the new tag when the server accepts it', async () => {
    stubFetch(200);
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);
    await waitFor(() => expect(screen.getByTestId('tags')).toHaveTextContent('old'));

    fireEvent.click(screen.getByRole('button', { name: 'add tag' }));

    await waitFor(() => expect(screen.getByTestId('tags')).toHaveTextContent('old,new'));
    expect(screen.queryByText('Не удалось сохранить теги')).not.toBeInTheDocument();
  });

  it('rolls the tags back and reports an error when the save is rejected', async () => {
    stubFetch(400);
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);
    await waitFor(() => expect(screen.getByTestId('tags')).toHaveTextContent('old'));

    fireEvent.click(screen.getByRole('button', { name: 'add tag' }));

    expect(await screen.findByText('Не удалось сохранить теги')).toBeInTheDocument();
    expect(screen.getByTestId('tags').textContent).toBe('old');
  });
});
