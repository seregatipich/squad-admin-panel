// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GeoipIntegrationPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function settings(overrides: Record<string, unknown> = {}) {
  return {
    account_id: '123456',
    license_key_configured: true,
    license_key_mask: '••••1234',
    enabled: true,
    db_present: true,
    last_refreshed_at: '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(JSON.stringify(settings(overrides)), { status: 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GeoipIntegrationPage', () => {
  it(
    'shows the stored key and database state',
    async () => {
      stubFetch();
      render(<GeoipIntegrationPage />);

      expect(await screen.findByText('Настроен')).toBeInTheDocument();
      expect(screen.getByText('Загружена')).toBeInTheDocument();
      expect(screen.getByLabelText('Account ID')).toHaveValue('123456');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed load with a retry action',
    async () => {
      const fn = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
      vi.stubGlobal('fetch', fn);
      render(<GeoipIntegrationPage />);

      await screen.findByText('Не удалось загрузить настройки GeoIP');
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
      await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the key when the delete confirmation is cancelled',
    async () => {
      const calls = stubFetch();
      render(<GeoipIntegrationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить ключ' }));
      const dialog = await screen.findByRole('dialog', { name: 'Удалить ключ MaxMind' });
      // «Отмена» носят и крестик окна, и кнопка подвала — нужна вторая.
      const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
      fireEvent.click(cancels[cancels.length - 1] as HTMLElement);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls.filter((call) => call.init?.method === 'PUT')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'clears the key only after the confirmation dialog is confirmed',
    async () => {
      const calls = stubFetch();
      render(<GeoipIntegrationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить ключ' }));
      const dialog = await screen.findByRole('dialog', { name: 'Удалить ключ MaxMind' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить ключ' }));

      await waitFor(() => {
        const puts = calls.filter((call) => call.init?.method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(JSON.parse(String(puts[0]?.init?.body))).toEqual({
          license_key: null,
          enabled: false,
        });
      });
      expect(await screen.findByText('Ключ удалён.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'omits the license key from the payload when the field is left empty',
    async () => {
      const calls = stubFetch();
      render(<GeoipIntegrationPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }));

      await waitFor(() => {
        const puts = calls.filter((call) => call.init?.method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(JSON.parse(String(puts[0]?.init?.body))).toEqual({
          account_id: '123456',
          enabled: true,
        });
      });
    },
    TEST_TIMEOUT_MS,
  );
});
