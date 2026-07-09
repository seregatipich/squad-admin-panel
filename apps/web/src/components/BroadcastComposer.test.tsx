// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastComposer } from './BroadcastComposer';

const TEST_TIMEOUT_MS = 15_000;

const TEMPLATES = [
  {
    id: 't1',
    title: 'Разминка',
    body: 'Всем привет, разминка через 5 минут',
    category: 'info',
    locale: 'ru',
    sort_order: 0,
    is_enabled: true,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

function mockFetch(overrides: { broadcast?: () => Promise<Response> } = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/message-templates') && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify(TEMPLATES), { status: 200 }));
    }
    if (url.includes('/broadcast')) {
      return overrides.broadcast
        ? overrides.broadcast()
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

describe('BroadcastComposer', () => {
  it('renders nothing without the chat permission', () => {
    const { container } = render(<BroadcastComposer serverId="srv-1" canChat={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });

  it(
    'disables send while the message is shorter than 2 characters',
    async () => {
      render(<BroadcastComposer serverId="srv-1" canChat={true} />);
      const input = await screen.findByPlaceholderText(/текст объявления/i);
      const send = screen.getByRole('button', { name: /отправить/i });
      expect(send).toBeDisabled();

      fireEvent.change(input, { target: { value: 'a' } });
      expect(send).toBeDisabled();

      fireEvent.change(input, { target: { value: 'ab' } });
      expect(send).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks for confirmation and posts the broadcast on send',
    async () => {
      render(<BroadcastComposer serverId="srv-1" canChat={true} />);
      const input = await screen.findByPlaceholderText(/текст объявления/i);
      fireEvent.change(input, { target: { value: 'Server restarting soon' } });
      fireEvent.click(screen.getByRole('button', { name: /отправить/i }));

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Server restarting soon'));
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          '/api/v1/servers/srv-1/broadcast',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ message: 'Server restarting soon' }),
          }),
        );
      });
      await screen.findByText(/отправлено/i);
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
      render(<BroadcastComposer serverId="srv-1" canChat={true} />);
      const input = await screen.findByPlaceholderText(/текст объявления/i);
      fireEvent.change(input, { target: { value: 'Server restarting soon' } });
      fireEvent.click(screen.getByRole('button', { name: /отправить/i }));

      expect(confirm).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalledWith('/api/v1/servers/srv-1/broadcast', expect.anything());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets the operator pick a template to fill the message',
    async () => {
      render(<BroadcastComposer serverId="srv-1" canChat={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /шаблоны/i }));
      fireEvent.click(await screen.findByText('Разминка'));

      const input = await screen.findByPlaceholderText(/текст объявления/i);
      expect(input).toHaveValue('Всем привет, разминка через 5 минут');
    },
    TEST_TIMEOUT_MS,
  );
});
