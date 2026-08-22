// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportPlayerSection } from './ReportPlayerSection';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а окно жалобы построено на примитиве `Modal`. Полифилл повторяет ровно то,
 * на что опирается примитив: атрибут `open`, фокус внутрь окна и цепочку
 * Escape → отменяемое `cancel` → `close`.
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

const SERVERS = {
  items: [
    { id: 'srv-1', display_name: 'EU Server 1', slug: 'eu-1' },
    { id: 'srv-2', display_name: 'EU Server 2', slug: 'eu-2' },
  ],
};

function mockFetch(serversStatus = 200) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/servers')) {
      if (serversStatus !== 200) {
        return Promise.resolve(new Response(null, { status: serversStatus }));
      }
      return Promise.resolve(new Response(JSON.stringify(SERVERS), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportPlayerSection', () => {
  it(
    'renders the «Пожаловаться» button once the server list loads',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<ReportPlayerSection playerId="player-1" />);
      const button = await screen.findByRole('button', { name: /пожаловаться/i });
      expect(button).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'opens a modal with the required fields on click',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<ReportPlayerSection playerId="player-1" />);
      const button = await screen.findByRole('button', { name: /пожаловаться/i });
      fireEvent.click(button);

      expect(await screen.findByLabelText(/^сервер$/i)).toBeInTheDocument();
      expect(screen.getByText(/текст жалобы/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /отправить жалобу/i })).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the servers fetch is unauthorized (401)',
    async () => {
      vi.stubGlobal('fetch', mockFetch(401));
      const { container } = render(<ReportPlayerSection playerId="player-1" />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the servers fetch is forbidden (403)',
    async () => {
      vi.stubGlobal('fetch', mockFetch(403));
      const { container } = render(<ReportPlayerSection playerId="player-1" />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );
});
