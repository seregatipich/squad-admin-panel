// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SquadMessageModal, type SquadMessageTarget } from './SquadMessageModal';

const TEST_TIMEOUT_MS = 15_000;

const TEMPLATES = [
  {
    id: 't1',
    title: 'Тимчат-варн',
    body: '{player}, соблюдай тимчат!',
    category: 'warn',
    locale: 'ru',
    sort_order: 0,
    is_enabled: true,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

const TARGET: SquadMessageTarget = {
  serverId: 'srv-1',
  teamId: 1,
  squadId: 2,
  label: 'Команда 1 · Отряд 2',
  leaderName: 'SquadLeaderNick',
};

function mockFetch(overrides: { message?: () => Promise<Response> } = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/message-templates') && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify(TEMPLATES), { status: 200 }));
    }
    if (url.includes('/squads/2/message')) {
      return overrides.message
        ? overrides.message()
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SquadMessageModal', () => {
  it('renders nothing when there is no target', () => {
    const { container } = render(
      <SquadMessageModal target={null} onOpenChange={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it(
    'substitutes {player} with the squad leader nickname when a template is picked',
    async () => {
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      await screen.findByText(/Команда 1 · Отряд 2/);
      fireEvent.click(await screen.findByText('Тимчат-варн'));

      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      expect(textarea).toHaveValue('SquadLeaderNick, соблюдай тимчат!');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'disables send while the message is shorter than 2 characters',
    async () => {
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      const send = screen.getByRole('button', { name: /отправить/i });
      expect(send).toBeDisabled();

      fireEvent.change(textarea, { target: { value: 'a' } });
      expect(send).toBeDisabled();

      fireEvent.change(textarea, { target: { value: 'go go go' } });
      expect(send).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks for confirmation and posts to the squad-message route with team_id',
    async () => {
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Push the flag' } });
      fireEvent.click(screen.getByRole('button', { name: /отправить/i }));

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Push the flag'));
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          '/api/v1/servers/srv-1/squads/2/message?team_id=1',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ message: 'Push the flag' }),
          }),
        );
      });
      await screen.findByText(/сообщение отправлено/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not send when the confirm dialog is cancelled',
    async () => {
      vi.stubGlobal(
        'confirm',
        vi.fn(() => false),
      );
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Push the flag' } });
      fireEvent.click(screen.getByRole('button', { name: /отправить/i }));

      expect(confirm).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/squads/2/message'),
        expect.anything(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'closes when Cancel is clicked',
    async () => {
      const onOpenChange = vi.fn();
      render(<SquadMessageModal target={TARGET} onOpenChange={onOpenChange} />);
      fireEvent.click(await screen.findByRole('button', { name: /отмена/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
    TEST_TIMEOUT_MS,
  );
});
