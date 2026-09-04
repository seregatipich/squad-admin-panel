// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/economy'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import type { EconomySettings, VipTier } from './helpers';
import EconomySettingsPage from './page';

/**
 * jsdom знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение «Удалить тир» построено на примитиве `AlertDialog`.
 * Полифилл повторяет ровно то, на что опирается примитив: атрибут `open`,
 * фокус внутрь окна и цепочку Escape → отменяемое `cancel` → `close`.
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

/** Подтвердить удаление тира в диалоге, который открыла кнопка-корзина. */
async function confirmTierDeletion() {
  const dialog = await screen.findByRole('dialog', { name: 'Удалить VIP-тир' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить тир' }));
}

/** Отказаться от удаления тира: «Отмена» подвала, а не крестик окна. */
async function declineTierDeletion() {
  const dialog = await screen.findByRole('dialog', { name: 'Удалить VIP-тир' });
  const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
  fireEvent.click(cancels[cancels.length - 1] as HTMLElement);
}

function makeSettings(): EconomySettings {
  return {
    k_online: 1,
    k_boost: 2,
    k_seed: 3,
    seed_threshold: 40,
    economy_enabled: false,
    privilege_costs: {},
    updated_at: null,
    updated_by_player_id: null,
  };
}

function makeTier(overrides: Partial<VipTier> = {}): VipTier {
  return {
    id: overrides.id ?? 'tier-1',
    name: overrides.name ?? 'VIP Bronze',
    role_id: overrides.role_id ?? 'role-1',
    description: 'description' in overrides ? (overrides.description ?? null) : null,
    default_days: 'default_days' in overrides ? (overrides.default_days ?? null) : 30,
    sort_order: overrides.sort_order ?? 0,
    is_active: overrides.is_active ?? true,
    created_at: overrides.created_at ?? '2026-07-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-07-01T00:00:00.000Z',
  };
}

/**
 * Mock fetch serving the economy page's data endpoints and recording tier
 * mutations (POST/PUT/DELETE /api/v1/vip-tiers). `tierMutationError` makes
 * every tier mutation fail with the given response (or a thrown network
 * error), `economyPutError` does the same for PUT /api/v1/settings/economy.
 */
function stubFetch(opts: {
  tiers?: VipTier[];
  permissions?: string[];
  canManageEconomy?: boolean;
  settingsStatus?: number;
  onPost?: (body: Record<string, unknown>) => void;
  onPut?: (url: string, body: Record<string, unknown>) => void;
  onDelete?: (url: string) => void;
  tierMutationError?: { status: number; body: Record<string, unknown> } | 'network';
  economyPutError?: { status: number; body: Record<string, unknown> };
}) {
  const perms = opts.permissions ?? ['role:edit'];
  const tierMutationFailure = (): Response | null => {
    if (opts.tierMutationError === 'network') throw new Error('offline');
    if (opts.tierMutationError) {
      return new Response(JSON.stringify(opts.tierMutationError.body), {
        status: opts.tierMutationError.status,
      });
    }
    return null;
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/v1/settings/economy') && method === 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify(makeSettings()), { status: opts.settingsStatus ?? 200 }),
      );
    }
    if (url.endsWith('/api/v1/settings/economy') && method === 'PUT') {
      if (opts.economyPutError) {
        return Promise.resolve(
          new Response(JSON.stringify(opts.economyPutError.body), {
            status: opts.economyPutError.status,
          }),
        );
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ...makeSettings(), ...body, updated_at: '2026-07-05T00:00:00.000Z' }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            can_manage_economy: opts.canManageEconomy ?? true,
            permissions: perms,
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/roles') && method === 'GET') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 'role-1', name: 'VIP Role' },
            { id: 'role-2', name: 'Premium Role' },
          ]),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/vip-tiers') && method === 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify({ rows: opts.tiers ?? [] }), { status: 200 }),
      );
    }
    if (url.endsWith('/api/v1/vip-tiers') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onPost?.(body);
      const failure = tierMutationFailure();
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            makeTier({ id: 'tier-new', name: String(body.name), role_id: String(body.role_id) }),
          ),
          { status: 201 },
        ),
      );
    }
    if (url.includes('/api/v1/vip-tiers/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onPut?.(url, body);
      const failure = tierMutationFailure();
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(
        new Response(JSON.stringify(makeTier({ name: String(body.name) })), { status: 200 }),
      );
    }
    if (url.includes('/api/v1/vip-tiers/') && method === 'DELETE') {
      opts.onDelete?.(url);
      const failure = tierMutationFailure();
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EconomySettingsPage — VIP tiers section (VIPSUB-3)', () => {
  it('renders VIP tiers section with tiers from the API', async () => {
    stubFetch({
      tiers: [
        makeTier({ id: 'tier-1', name: 'VIP Bronze', default_days: 30 }),
        makeTier({ id: 'tier-2', name: 'VIP Gold', role_id: 'role-2', default_days: null }),
      ],
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);
    expect(scope.getByText('VIP Bronze')).toBeInTheDocument();
    expect(scope.getByText('VIP Gold')).toBeInTheDocument();
    // The role_id column resolves role names from /api/v1/roles.
    expect(scope.getByText('VIP Role')).toBeInTheDocument();
    expect(scope.getByText('Premium Role')).toBeInTheDocument();
    // default_days renders via formatTierDuration.
    expect(scope.getByText('30 дн.')).toBeInTheDocument();
    expect(scope.getByText('бессрочно')).toBeInTheDocument();
  });

  it('hides VIP tiers section without role:edit permission', async () => {
    stubFetch({ tiers: [makeTier()], permissions: [] });
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });
    expect(screen.queryByRole('region', { name: 'VIP-тиры' })).not.toBeInTheDocument();
    expect(screen.queryByText('VIP Bronze')).not.toBeInTheDocument();
  });

  it('creates a tier via POST /api/v1/vip-tiers', async () => {
    const posted: Record<string, unknown>[] = [];
    stubFetch({ tiers: [], onPost: (b) => posted.push(b) });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'VIP Silver' } });
    fireEvent.change(scope.getByLabelText('Роль'), { target: { value: 'role-2' } });
    fireEvent.change(scope.getByLabelText('Срок по умолчанию (дней)'), {
      target: { value: '90' },
    });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      name: 'VIP Silver',
      role_id: 'role-2',
      default_days: 90,
      is_active: true,
    });
  });

  it('delete asks for confirmation in a dialog and only then calls DELETE', async () => {
    const deleted: string[] = [];
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze' })],
      onDelete: (u) => deleted.push(u),
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    fireEvent.click(within(section).getByRole('button', { name: /удалить тир «VIP Bronze»/i }));

    // Пока диалог не подтверждён, запроса на удаление нет.
    const dialog = await screen.findByRole('dialog', { name: 'Удалить VIP-тир' });
    expect(dialog).toHaveTextContent('VIP Bronze');
    expect(deleted).toHaveLength(0);

    await confirmTierDeletion();
    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toContain('/api/v1/vip-tiers/tier-1');
  });

  it('renders inactive badge, description, and raw role_id for an unknown role', async () => {
    stubFetch({
      tiers: [
        makeTier({
          id: 'tier-1',
          name: 'VIP Bronze',
          description: 'Бронзовый пакет',
          is_active: false,
        }),
        makeTier({ id: 'tier-2', name: 'VIP Gold', role_id: 'role-missing' }),
      ],
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);
    expect(scope.getByText('Скрыт')).toBeInTheDocument();
    expect(scope.getByText('Активен')).toBeInTheDocument();
    expect(scope.getByText('Бронзовый пакет')).toBeInTheDocument();
    // role_id column falls back to the raw id when /api/v1/roles has no match.
    expect(scope.getByText('role-missing')).toBeInTheDocument();
  });

  it('edits a tier via PUT /api/v1/vip-tiers/:id', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze', default_days: null, is_active: false })],
      onPut: (url, body) => puts.push({ url, body }),
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: 'Редактировать' }));
    expect(scope.getByText('Редактирование тира')).toBeInTheDocument();
    expect(scope.getByLabelText('Название')).toHaveValue('VIP Bronze');
    expect(scope.getByLabelText('Срок по умолчанию (дней)')).toHaveValue(null);
    expect(scope.getByLabelText('Тир активен')).not.toBeChecked();
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'VIP Platinum' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toContain('/api/v1/vip-tiers/tier-1');
    expect(puts[0].body).toMatchObject({
      name: 'VIP Platinum',
      role_id: 'role-1',
      default_days: null,
      is_active: false,
    });
    // The form closes after a successful save.
    await waitFor(() => expect(scope.queryByText('Редактирование тира')).not.toBeInTheDocument());
  });

  it('cancel closes the tier form without any mutation', async () => {
    const fetchMock = stubFetch({ tiers: [] });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);
    expect(scope.getByText('Тиров пока нет')).toBeInTheDocument();

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    expect(scope.getByText('Новый тир')).toBeInTheDocument();
    fireEvent.click(scope.getByRole('button', { name: 'Отмена' }));

    expect(scope.queryByText('Новый тир')).not.toBeInTheDocument();
    expect(scope.getByRole('button', { name: /добавить тир/i })).toBeInTheDocument();
    const mutations = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET');
    expect(mutations).toHaveLength(0);
  });

  it('shows validation errors for an invalid tier form without calling the API', async () => {
    const fetchMock = stubFetch({ tiers: [] });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Описание'), {
      target: { value: 'x'.repeat(1025) },
    });
    fireEvent.change(scope.getByLabelText('Срок по умолчанию (дней)'), { target: { value: '0' } });
    fireEvent.change(scope.getByLabelText('Порядок сортировки'), { target: { value: '-1' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    expect(await scope.findByText('Исправьте выделенные поля.')).toBeInTheDocument();
    expect(scope.getByText('Введите название от 1 до 64 символов.')).toBeInTheDocument();
    expect(scope.getByText('Выберите роль.')).toBeInTheDocument();
    expect(scope.getByText('Описание не длиннее 1024 символов.')).toBeInTheDocument();
    expect(
      scope.getByText('Введите целое число от 1 до 3650 или оставьте поле пустым.'),
    ).toBeInTheDocument();
    expect(scope.getByText('Введите целое число от 0 до 100000.')).toBeInTheDocument();
    const mutations = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET');
    expect(mutations).toHaveLength(0);
  });

  it('maps vip_tier_name_taken to a friendly message and keeps the form open', async () => {
    stubFetch({
      tiers: [],
      tierMutationError: { status: 409, body: { error: 'vip_tier_name_taken' } },
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'VIP Bronze' } });
    fireEvent.change(scope.getByLabelText('Роль'), { target: { value: 'role-1' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    expect(
      await scope.findByText('Ошибка сохранения тира: Тир с таким названием уже существует.'),
    ).toBeInTheDocument();
    expect(scope.getByText('Новый тир')).toBeInTheDocument();
  });

  it('explains why the protected site VIP binding cannot become a panel tier', async () => {
    stubFetch({
      tiers: [],
      tierMutationError: { status: 409, body: { error: 'site_vip_binding_protected' } },
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'Panel duplicate' } });
    fireEvent.change(scope.getByLabelText('Роль'), { target: { value: 'role-1' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    expect(
      await scope.findByText(
        'Ошибка сохранения тира: Привязка BSS VIP защищена: её роль и тариф нельзя использовать для другого магазина.',
      ),
    ).toBeInTheDocument();
  });

  it('falls back to the raw error code for unknown tier save errors', async () => {
    stubFetch({
      tiers: [],
      tierMutationError: { status: 400, body: { error: 'weird_code' } },
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'VIP Bronze' } });
    fireEvent.change(scope.getByLabelText('Роль'), { target: { value: 'role-1' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    expect(await scope.findByText('Ошибка сохранения тира: weird_code')).toBeInTheDocument();
  });

  it('shows a network error when the tier save request fails', async () => {
    stubFetch({ tiers: [], tierMutationError: 'network' });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название'), { target: { value: 'VIP Bronze' } });
    fireEvent.change(scope.getByLabelText('Роль'), { target: { value: 'role-1' } });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    expect(await scope.findByText('Ошибка сети: offline')).toBeInTheDocument();
  });

  it('maps vip_tier_has_active_assignments on delete', async () => {
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze' })],
      tierMutationError: { status: 409, body: { error: 'vip_tier_has_active_assignments' } },
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    fireEvent.click(within(section).getByRole('button', { name: /удалить тир «VIP Bronze»/i }));
    await confirmTierDeletion();

    expect(
      await within(section).findByText(
        'Ошибка удаления тира: Нельзя удалить тир: у него есть активные назначения.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the HTTP status when a delete error has no code', async () => {
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze' })],
      tierMutationError: { status: 500, body: {} },
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    fireEvent.click(within(section).getByRole('button', { name: /удалить тир «VIP Bronze»/i }));
    await confirmTierDeletion();

    expect(await within(section).findByText('Ошибка удаления тира: 500')).toBeInTheDocument();
  });

  it('does not delete when the confirmation dialog is dismissed', async () => {
    const deleted: string[] = [];
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze' })],
      onDelete: (u) => deleted.push(u),
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    fireEvent.click(within(section).getByRole('button', { name: /удалить тир «VIP Bronze»/i }));
    await declineTierDeletion();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleted).toHaveLength(0);
  });
});

describe('EconomySettingsPage — economy settings form', () => {
  it('reports the failure and keeps the skeleton when settings fail to load', async () => {
    const fetchMock = stubFetch({ settingsStatus: 500 });
    render(<EconomySettingsPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Не удалось загрузить настройки: 500')).toBeInTheDocument();
    expect(screen.getByText('Загрузка настроек экономики')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument();
  });

  it('shows read-only notice and no save button without manage permission', async () => {
    stubFetch({ canManageEconomy: false });
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });
    expect(screen.getByText(/для изменения настроек нужно право/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Экономика включена')).toBeDisabled();
  });

  it('saves economy settings and shows a success notice', async () => {
    stubFetch({});
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });
    expect(screen.getByText('Начисления выключены')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Экономика включена'));
    expect(screen.getByText('Начисления активны')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Настройки экономики сохранены.')).toBeInTheDocument();
    // The PUT response round-trips into the form: the toggle stays on.
    expect(screen.getByText('Начисления активны')).toBeInTheDocument();
  });

  it('shows field errors when the economy form is invalid', async () => {
    stubFetch({});
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });

    fireEvent.change(screen.getByLabelText(/Коэффициент онлайна/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText(/Порог сида/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Исправьте выделенные поля.')).toBeInTheDocument();
    expect(screen.getByText('Введите число от 0 до 1000.')).toBeInTheDocument();
    expect(screen.getByText('Введите целое число от 0 до 100.')).toBeInTheDocument();
  });

  it('surfaces a server error when saving economy settings fails', async () => {
    stubFetch({ economyPutError: { status: 500, body: { error: 'boom' } } });
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('Ошибка сохранения: boom')).toBeInTheDocument();
  });
});
