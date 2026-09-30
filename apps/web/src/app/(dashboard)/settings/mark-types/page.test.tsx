// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkTypesPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const MARK_TYPE = {
  id: 1,
  slug: 'ghost_peek',
  label_en: 'Ghost peek',
  label_ru: 'Гост-пик',
  icon: '👀',
  severity: 3,
  is_active: true,
  sort_order: 1,
};

function mockFetch(opts: { permissions?: string[]; types?: unknown[] } = {}) {
  const permissions = opts.permissions ?? ['role:edit'];
  const types = opts.types ?? [MARK_TYPE];
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
    }
    if (url.includes('/api/v1/mark-types')) {
      return Promise.resolve(new Response(JSON.stringify(types), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MarkTypesPage', () => {
  it('is a valid React component', () => {
    expect(MarkTypesPage).toBeDefined();
    expect(typeof MarkTypesPage).toBe('function');
  });

  it(
    'renders the taxonomy table and the create form for an editor',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<MarkTypesPage />);
      expect(await screen.findByRole('heading', { name: 'Типы меток' })).toBeInTheDocument();
      expect(await screen.findByText('ghost_peek')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Идентификатор' })).toBeInTheDocument();
      expect(screen.getByLabelText('Идентификатор (лат.)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Деактивировать' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the empty state and hides mutating controls without role:edit',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ permissions: [], types: [] }));
      render(<MarkTypesPage />);
      expect(await screen.findByText('Типов пока нет')).toBeInTheDocument();
      expect(screen.queryByLabelText('Идентификатор (лат.)')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  describe('operator feedback and reordering', () => {
    const SECOND_TYPE = { ...MARK_TYPE, id: 2, slug: 'aim_assist', label_ru: 'Аим', sort_order: 2 };

    /** Mock router whose mutating calls can be failed or delayed per test. */
    function mockEditableFetch(handlers: {
      reorder?: () => Promise<Response>;
      typesAfterFirstLoad?: () => Promise<Response>;
      create?: () => Promise<Response>;
    }) {
      let typeLoads = 0;
      return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/v1/me')) {
          return Promise.resolve(
            new Response(JSON.stringify({ permissions: ['role:edit'] }), { status: 200 }),
          );
        }
        if (url.endsWith('/mark-types/reorder') && method === 'PATCH') {
          return handlers.reorder
            ? handlers.reorder()
            : Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (url.endsWith('/api/v1/mark-types') && method === 'POST') {
          return handlers.create
            ? handlers.create()
            : Promise.resolve(new Response('{}', { status: 201 }));
        }
        if (url.includes('/api/v1/mark-types')) {
          typeLoads += 1;
          if (typeLoads > 1 && handlers.typesAfterFirstLoad) return handlers.typesAfterFirstLoad();
          return Promise.resolve(
            new Response(JSON.stringify([MARK_TYPE, SECOND_TYPE]), { status: 200 }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });
    }

    it(
      'shows local validation errors without a reload button (#719)',
      async () => {
        vi.stubGlobal('fetch', mockEditableFetch({}));
        render(<MarkTypesPage />);
        await screen.findByText('ghost_peek');
        fireEvent.click(screen.getByRole('button', { name: 'Создать тип' }));

        expect(await screen.findByText(/Идентификатор: 2–40 символов/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
        expect(screen.queryByText('Не удалось выполнить запрос')).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'reports server failures in Russian without HTTP jargon as the only text (#719)',
      async () => {
        vi.stubGlobal(
          'fetch',
          mockEditableFetch({ create: () => Promise.resolve(new Response('{}', { status: 400 })) }),
        );
        render(<MarkTypesPage />);
        await screen.findByText('ghost_peek');
        fireEvent.change(screen.getByLabelText('Идентификатор (лат.)'), {
          target: { value: 'new_type' },
        });
        fireEvent.change(screen.getByLabelText('Название (EN)'), { target: { value: 'New' } });
        fireEvent.change(screen.getByLabelText('Название (RU)'), { target: { value: 'Новый' } });
        fireEvent.click(screen.getByRole('button', { name: 'Создать тип' }));

        expect(await screen.findByText('Запрос не выполнен (HTTP 400).')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'keeps the success message when only the list reload fails after a mutation (#714)',
      async () => {
        vi.stubGlobal(
          'fetch',
          mockEditableFetch({
            typesAfterFirstLoad: () => Promise.reject(new TypeError('offline')),
          }),
        );
        render(<MarkTypesPage />);
        await screen.findByText('ghost_peek');
        fireEvent.change(screen.getByLabelText('Идентификатор (лат.)'), {
          target: { value: 'new_type' },
        });
        fireEvent.change(screen.getByLabelText('Название (EN)'), { target: { value: 'New' } });
        fireEvent.change(screen.getByLabelText('Название (RU)'), { target: { value: 'Новый' } });
        fireEvent.click(screen.getByRole('button', { name: 'Создать тип' }));

        expect(
          await screen.findByText(/Тип метки создан.*Список не удалось обновить/),
        ).toBeInTheDocument();
        expect(screen.queryByText('Не удалось выполнить запрос')).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'moves a type with the keyboard-accessible Ниже button (#720)',
      async () => {
        const fetchMock = mockEditableFetch({});
        vi.stubGlobal('fetch', fetchMock);
        render(<MarkTypesPage />);
        await screen.findByText('ghost_peek');
        expect(screen.getAllByRole('button', { name: 'Выше' })[0]).toBeDisabled();

        fireEvent.click(screen.getAllByRole('button', { name: 'Ниже' })[0] as HTMLElement);

        await waitFor(() => {
          const reorderCall = fetchMock.mock.calls.find((call) =>
            String(call[0]).endsWith('/mark-types/reorder'),
          );
          expect(JSON.parse(String(reorderCall?.[1]?.body))).toEqual({ ordered_ids: [2, 1] });
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ignores a second drop while the order is being saved (#716)',
      async () => {
        let release: (r: Response) => void = () => {};
        const fetchMock = mockEditableFetch({
          reorder: () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        });
        vi.stubGlobal('fetch', fetchMock);
        render(<MarkTypesPage />);
        await screen.findByText('ghost_peek');
        const rows = screen.getAllByRole('row').slice(1);

        fireEvent.dragStart(rows[0] as HTMLElement);
        fireEvent.drop(rows[1] as HTMLElement);
        await waitFor(() => expect(rows[0]).toHaveAttribute('draggable', 'false'));
        fireEvent.dragStart(rows[1] as HTMLElement);
        fireEvent.drop(rows[0] as HTMLElement);
        release(new Response('{}', { status: 200 }));

        await waitFor(() =>
          expect(
            fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/mark-types/reorder')),
          ).toHaveLength(1),
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
});
