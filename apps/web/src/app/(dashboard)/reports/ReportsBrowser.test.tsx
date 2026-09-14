// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а окно действия по жалобе построено на примитиве `Modal`. Полифилл повторяет
 * ровно то, на что опирается примитив: атрибут `open`, фокус внутрь окна и
 * цепочку Escape → отменяемое `cancel` → `close`.
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

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/reports'),
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));
vi.mock('./ReportsAnalytics', () => ({ ReportsAnalytics: () => null }));

import { ReportsBrowser } from './ReportsBrowser';

const TARGET_ID = 'b1e2c3d4-0000-0000-0000-000000000001';
const ALT_ID = 'b1e2c3d4-0000-0000-0000-000000000002';

const WARNING_REPORT = {
  id: 'report-warning',
  server_id: 'server-1',
  reporter_player_id: 'reporter-1',
  target_player_id: TARGET_ID,
  target_raw: null,
  body: 'Suspicious activity',
  source: 'ui' as const,
  status: 'pending' as const,
  handler_player_id: null,
  resolution_note: null,
  created_at: '2026-07-01T00:00:00.000Z',
  claimed_at: null,
  resolved_at: null,
  server_name: 'Test server',
  server_slug: 'test-server',
  reporter_name: 'Reporter',
  target_name: 'Target',
  handler_name: null,
  evidence: [],
  evidence_count: 0,
  reporter_trusted: false,
  reporter_spam_flagged: false,
  target_report_count_90d: 0,
};

function stubWarningFetch(warning: object, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me')
        return Promise.resolve(new Response(JSON.stringify({ can_handle_reports: true })));
      if (url.startsWith('/api/v1/reports?')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [WARNING_REPORT], total: 1 })));
      }
      if (url === `/api/v1/players/${TARGET_ID}/ban-alt-warning`) {
        return Promise.resolve(new Response(JSON.stringify(warning), { status }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportsBrowser ALT-7 ban warning', () => {
  it('loads the warning when opening ban and submits selected confirmed alts', async () => {
    const report = {
      id: 'report-1',
      server_id: 'server-1',
      reporter_player_id: 'reporter-1',
      target_player_id: TARGET_ID,
      target_raw: null,
      body: 'Cheating',
      source: 'ui' as const,
      status: 'pending' as const,
      handler_player_id: null,
      resolution_note: null,
      created_at: '2026-07-01T00:00:00.000Z',
      claimed_at: null,
      resolved_at: null,
      server_name: 'Test server',
      server_slug: 'test-server',
      reporter_name: 'Reporter',
      target_name: 'Target',
      handler_name: null,
      evidence: [],
      evidence_count: 0,
      reporter_trusted: false,
      reporter_spam_flagged: false,
      target_report_count_90d: 0,
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === '/api/v1/me') {
          return Promise.resolve(new Response(JSON.stringify({ can_handle_reports: true })));
        }
        if (url.startsWith('/api/v1/reports?')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [report], total: 1 })));
        }
        if (url === `/api/v1/players/${TARGET_ID}/ban-alt-warning`) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                can_view_ips: true,
                confirmed_count: 1,
                candidate_count: 0,
                confirmed: [
                  {
                    player_id: ALT_ID,
                    name: 'Confirmed alt',
                    link_type: 'alt',
                    status: 'confirmed',
                    online: false,
                    has_active_ban: true,
                  },
                  {
                    player_id: 'confirmed-alt-2',
                    name: 'Online confirmed alt',
                    online: true,
                    has_active_ban: false,
                  },
                ],
                candidates: [],
              }),
            ),
          );
        }
        if (url === '/api/v1/reports/report-1/actions' && init?.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    render(<ReportsBrowser />);
    fireEvent.click(await screen.findByRole('button', { name: 'Забанить' }));
    expect(await screen.findByText('У игрока есть связанные аккаунты')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Confirmed alt/));
    const modalButtons = screen.getAllByRole('button', { name: 'Забанить' });
    const submitButton = modalButtons[modalButtons.length - 1];
    if (!submitButton) throw new Error('ban submit button not found');
    fireEvent.click(submitButton);

    await waitFor(() => {
      const actionCall = calls.find(
        (call) => call.url === '/api/v1/reports/report-1/actions' && call.init?.method === 'POST',
      );
      expect(actionCall).toBeDefined();
      expect(JSON.parse(String(actionCall?.init?.body))).toMatchObject({
        action_type: 'ban',
        also_player_ids: [ALT_ID],
      });
    });
  });

  it('shows the permission-safe warning when IP details are unavailable', async () => {
    stubWarningFetch({
      can_view_ips: false,
      confirmed_count: 2,
      candidate_count: 0,
      confirmed: [],
      candidates: [],
    });
    render(<ReportsBrowser />);
    fireEvent.click(await screen.findByRole('button', { name: 'Забанить' }));
    expect(
      await screen.findByText('У игрока есть 2 подтверждённых связанных аккаунтов.'),
    ).toBeInTheDocument();
  });

  it('renders high-confidence candidates and warning request errors', async () => {
    stubWarningFetch({
      can_view_ips: true,
      confirmed_count: 0,
      candidate_count: 1,
      confirmed: [],
      candidates: [
        {
          player_id: ALT_ID,
          name: 'Candidate alt',
          online: true,
          has_active_ban: true,
        },
        {
          player_id: 'candidate-alt-2',
          name: 'Offline candidate',
          online: false,
          has_active_ban: false,
        },
      ],
    });
    render(<ReportsBrowser />);
    fireEvent.click(await screen.findByRole('button', { name: 'Забанить' }));
    expect(await screen.findByText('Кандидаты с высокой уверенностью')).toBeInTheDocument();
    expect(screen.getByText('Candidate alt')).toBeInTheDocument();
    expect(screen.getByText('онлайн')).toBeInTheDocument();
    expect(screen.getByText('активный бан')).toBeInTheDocument();

    cleanup();
    stubWarningFetch(
      {
        can_view_ips: true,
        confirmed_count: 0,
        candidate_count: 0,
        confirmed: [],
        candidates: [],
      },
      503,
    );
    render(<ReportsBrowser />);
    fireEvent.click(await screen.findByRole('button', { name: 'Забанить' }));
    expect(
      await screen.findByText('Проверка альтов недоступна (HTTP 503). Бан можно продолжить.'),
    ).toBeInTheDocument();
  });
});
