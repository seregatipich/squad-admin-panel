// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DirectMessageButton,
  DirectMessageModal,
  type DirectMessageTarget,
} from './DirectMessageModal';

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

const PLAYER_ID = '019e2000-0000-7000-8000-0000000000aa';

const TARGET: DirectMessageTarget = {
  serverId: 'srv-1',
  playerId: PLAYER_ID,
  playerName: 'TargetNick',
};

function mockFetch(overrides: { message?: () => Promise<Response> } = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/message-templates') && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify(TEMPLATES), { status: 200 }));
    }
    if (url.endsWith('/api/v1/servers') && (!init || init.method === undefined)) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ id: 'srv-1', display_name: 'Server One' }] }), {
          status: 200,
        }),
      );
    }
    if (url.includes(`/players/${PLAYER_ID}/message`)) {
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

describe('DirectMessageButton', () => {
  it('renders nothing without the chat permission', () => {
    const { container } = render(
      <DirectMessageButton playerId={PLAYER_ID} name="TargetNick" canChat={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the message button with the chat permission', () => {
    render(<DirectMessageButton playerId={PLAYER_ID} name="TargetNick" canChat={true} />);
    expect(
      screen.getByRole('button', { name: 'Сообщение игроку: TargetNick' }),
    ).toBeInTheDocument();
  });

  it('renders nothing when there is no target', () => {
    const { container } = render(
      <DirectMessageButton playerId={null} name="TargetNick" canChat={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DirectMessageModal', () => {
  it(
    'disables send while the message is shorter than 2 characters',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
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
    'caps the textarea at 300 characters and shows the counter',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      expect(textarea).toHaveAttribute('maxLength', '300');
      expect(screen.getByText('0/300')).toBeInTheDocument();

      fireEvent.change(textarea, { target: { value: 'hello' } });
      expect(screen.getByText('5/300')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'substitutes {player} with the target nickname when a template is picked',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
      await screen.findByText(/TargetNick/);
      fireEvent.click(await screen.findByText('Тимчат-варн'));

      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      expect(textarea).toHaveValue('TargetNick, соблюдай тимчат!');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'posts message and log_to_card to the direct-message route',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });
      fireEvent.click(screen.getByLabelText(/записать в карточку/i));
      fireEvent.click(screen.getByRole('button', { name: /отправить/i }));

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Stop teamkilling'));
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          `/api/v1/servers/srv-1/players/${PLAYER_ID}/message`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ message: 'Stop teamkilling', log_to_card: true }),
          }),
        );
      });
      await screen.findByText(/сообщение отправлено/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a server select and blocks send until a server is chosen when serverId is null',
    async () => {
      render(
        <DirectMessageModal
          target={{ ...TARGET, serverId: null }}
          onOpenChange={() => undefined}
        />,
      );
      const select = await screen.findByLabelText(/сервер/i);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });

      const send = screen.getByRole('button', { name: /отправить/i });
      expect(send).toBeDisabled();

      await screen.findByRole('option', { name: 'Server One' });
      fireEvent.change(select, { target: { value: 'srv-1' } });
      expect(send).toBeEnabled();

      fireEvent.click(send);
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          `/api/v1/servers/srv-1/players/${PLAYER_ID}/message`,
          expect.objectContaining({ method: 'POST' }),
        );
      });
    },
    TEST_TIMEOUT_MS,
  );
});
