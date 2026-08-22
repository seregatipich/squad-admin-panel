// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SetupPage from './page';

const TEST_TIMEOUT_MS = 15_000;

/** Ни один сценарий здесь не доводит до `window.location`: jsdom туда не умеет. */
function stubStatus(status: { setup_completed: boolean; first_owner_claimed: boolean }) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(status), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetupPage', () => {
  it(
    'asks for the organization name once the first owner is claimed',
    async () => {
      stubStatus({ setup_completed: false, first_owner_claimed: true });
      render(<SetupPage />);

      const field = await screen.findByLabelText(/Название организации/);
      const submit = screen.getByRole('button', { name: 'Завершить настройку' });
      expect(submit).toBeDisabled();

      fireEvent.change(field, { target: { value: 'Мой Squad-сервер' } });
      expect(submit).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers the Steam sign-in while nobody has claimed ownership',
    async () => {
      stubStatus({ setup_completed: false, first_owner_claimed: false });
      render(<SetupPage />);

      const link = await screen.findByRole('link', { name: 'Войти через Steam' });
      // Полная навигация документа, а не маршрутизатор: это начало OpenID-обмена.
      expect(link).toHaveAttribute('href', '/api/v1/auth/steam/login');
      expect(screen.queryByRole('button', { name: 'Завершить настройку' })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed status request and retries it on demand',
    async () => {
      const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
      vi.stubGlobal('fetch', fetchMock);
      render(<SetupPage />);

      expect(await screen.findByText('Не удалось загрузить статус.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/v1/setup/status',
        expect.objectContaining({ cache: 'no-store' }),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
