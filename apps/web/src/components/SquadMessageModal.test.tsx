// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Окно подтверждения отправки — второй, вложенный диалог. */
function confirmDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Отправить сообщение отряду' });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
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
      expect(
        screen.getByRole('dialog', { name: 'Сообщение отряду «Команда 1 · Отряд 2»' }),
      ).toBeInTheDocument();
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
      const send = screen.getByRole('button', { name: 'Отправить' });
      expect(send).toBeDisabled();

      fireEvent.change(textarea, { target: { value: 'a' } });
      expect(send).toBeDisabled();

      fireEvent.change(textarea, { target: { value: 'go go go' } });
      expect(send).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks for confirmation in a dialog and posts to the squad-message route with team_id',
    async () => {
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Push the flag' } });
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      const dialog = confirmDialog();
      expect(within(dialog).getByText(/Push the flag/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отправить сообщение' }));

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
    'does not send when the confirmation is cancelled',
    async () => {
      render(<SquadMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Push the flag' } });
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      const dialog = confirmDialog();
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0] as HTMLElement);

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', { name: 'Отправить сообщение отряду' }),
        ).not.toBeInTheDocument();
      });
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
      fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
    TEST_TIMEOUT_MS,
  );

  // Escape над окном с набранным текстом стирал бы работу оператора без вопроса.
  it(
    'refuses to dismiss itself on Escape once something is typed',
    async () => {
      const onOpenChange = vi.fn();
      render(<SquadMessageModal target={TARGET} onOpenChange={onOpenChange} />);
      const dialog = screen.getByRole('dialog', { name: /Сообщение отряду/ });
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onOpenChange).toHaveBeenCalledWith(false);

      onOpenChange.mockClear();
      fireEvent.change(textarea, { target: { value: 'Push the flag' } });
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});
