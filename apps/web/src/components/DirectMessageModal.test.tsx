// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DirectMessageButton,
  DirectMessageModal,
  type DirectMessageTarget,
} from './DirectMessageModal';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а окно и подтверждение построены на примитивах `Modal` и `AlertDialog`.
 * Полифилл повторяет ровно то, на что они опираются: атрибут `open`, фокус
 * внутрь окна и цепочку Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

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

/** Окно подтверждения отправки — второй, вложенный диалог. */
function confirmDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Отправить сообщение игроку' });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
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

  it('opens the modal from the trigger, whoever styles the trigger', () => {
    render(
      <DirectMessageButton
        playerId={PLAYER_ID}
        name="TargetNick"
        canChat={true}
        className="h-6 px-1.5"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сообщение игроку: TargetNick' }));
    expect(
      screen.getByRole('dialog', { name: 'Сообщение игроку «TargetNick»' }),
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
      expect(
        screen.getByRole('dialog', { name: 'Сообщение игроку «TargetNick»' }),
      ).toBeInTheDocument();
      fireEvent.click(await screen.findByText('Тимчат-варн'));

      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      expect(textarea).toHaveValue('TargetNick, соблюдай тимчат!');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'confirms in a dialog, then posts message and log_to_card to the direct-message route',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });
      fireEvent.click(screen.getByLabelText(/записать в карточку/i));
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      const dialog = confirmDialog();
      expect(within(dialog).getByText(/Stop teamkilling/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отправить сообщение' }));

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
    'does not send when the confirmation is cancelled',
    async () => {
      render(<DirectMessageModal target={TARGET} onOpenChange={() => undefined} />);
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      const dialog = confirmDialog();
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0] as HTMLElement);

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', { name: 'Отправить сообщение игроку' }),
        ).not.toBeInTheDocument();
      });
      expect(fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/message'),
        expect.objectContaining({ method: 'POST' }),
      );
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
      const select = await screen.findByLabelText('Сервер');
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });

      const send = screen.getByRole('button', { name: 'Отправить' });
      expect(send).toBeDisabled();

      await screen.findByRole('option', { name: 'Server One' });
      fireEvent.change(select, { target: { value: 'srv-1' } });
      expect(send).toBeEnabled();

      fireEvent.click(send);
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Отправить сообщение' }));
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          `/api/v1/servers/srv-1/players/${PLAYER_ID}/message`,
          expect.objectContaining({ method: 'POST' }),
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  // Клик мимо панели и Escape над набранным текстом стирали бы работу оператора.
  it(
    'refuses to dismiss itself on Escape once something is typed',
    async () => {
      const onOpenChange = vi.fn();
      render(<DirectMessageModal target={TARGET} onOpenChange={onOpenChange} />);
      const dialog = screen.getByRole('dialog', { name: 'Сообщение игроку «TargetNick»' });
      const textarea = await screen.findByPlaceholderText(/текст сообщения/i);

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onOpenChange).toHaveBeenCalledWith(false);

      onOpenChange.mockClear();
      fireEvent.change(textarea, { target: { value: 'Stop teamkilling' } });
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});
