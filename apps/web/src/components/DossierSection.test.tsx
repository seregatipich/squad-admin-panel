// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DossierSection } from './DossierSection';
import {
  DAMAGE_UNAVAILABLE_HINT,
  type DossierResponse,
  LIFETIME_ONLY_NOTE,
  RNSQUADJS_UNAVAILABLE,
  VEHICLE_UNCATALOGUED_HINT,
} from './dossier';

// The donut/bar chunk is reached through `next/dynamic`; recharts itself has
// no bearing on the behaviour under test and never renders in jsdom.
vi.mock('./DossierSkillChart', () => ({ default: () => null }));

const TEST_TIMEOUT_MS = 15_000;
const PLAYER_ID = 'b1e2c3d4-0000-0000-0000-000000000001';
const SERVERS = [
  { id: '11111111-1111-1111-1111-111111111111', display_name: 'Main #1' },
  { id: '22222222-2222-2222-2222-222222222222', display_name: 'Seed #2' },
];

const FULL: DossierResponse = {
  skill: {
    kills: 1200,
    deaths: 600,
    kd: 2,
    teamkills: 4,
    revives: 37,
    damage_dealt: null,
    online_seconds: 1_414_980,
    matches: 90,
    wins: 50,
    losses: 30,
    draws: 10,
    winrate: 0.625,
  },
  kd_trend: [
    { month: '2026-05-01', kills: 300, deaths: 150 },
    { month: '2026-07-01', kills: 400, deaths: 200 },
  ],
  weapons: [
    {
      weapon: 'BP_AK74',
      kills: 300,
      teamkills: 2,
      damage: 45000,
      shots_events: 900,
      last_used_at: '2026-07-20T10:00:00.000Z',
    },
    {
      weapon: 'BP_M4A1',
      kills: 120,
      teamkills: 1,
      damage: null,
      shots_events: 700,
      last_used_at: null,
    },
    {
      weapon: 'BP_RPG7',
      kills: 80,
      teamkills: 0,
      damage: 99000,
      shots_events: 100,
      last_used_at: '2026-07-01T10:00:00.000Z',
    },
  ],
  weapons_total: 137,
  vehicles: [
    {
      vehicle_asset_id: 'BP_MRAP_C',
      name_en: 'MRAP',
      name_ru: 'МРАП',
      vehicle_class: 'Truck',
      unlocalized: false,
      kills: 12,
      damage: 3400,
    },
  ],
  vehicle_kills: [
    {
      victim_vehicle_asset_id: 'BP_BTR82A',
      name_en: 'BTR-82A',
      name_ru: 'БТР-82А',
      vehicle_class: 'IFV',
      unlocalized: false,
      weapon: 'BP_RPG7',
      destroyed_count: 5,
    },
  ],
  kits: [
    { kit: 'Medic', seconds: 3661, last_played_at: '2026-07-21T18:30:00.000Z' },
    { kit: 'Rifleman', seconds: 7200, last_played_at: null },
  ],
  period: 'all',
  server_id: null,
};

const EMPTY: DossierResponse = {
  skill: {
    kills: 0,
    deaths: 0,
    kd: 0,
    teamkills: 0,
    revives: 0,
    damage_dealt: null,
    online_seconds: 0,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winrate: null,
  },
  kd_trend: [],
  weapons: [],
  weapons_total: 0,
  vehicles: [],
  vehicle_kills: [],
  kits: [],
  period: 'all',
  server_id: null,
};

function payload(overrides: Partial<DossierResponse> = {}): DossierResponse {
  return { ...FULL, ...overrides };
}

/** Routes the stubbed `fetch` by URL; anything unexpected rejects loudly. */
function stubFetch(options: {
  dossier?: DossierResponse;
  status?: number;
  servers?: { id: string; display_name: string }[];
  serversStatus?: number;
  serversReject?: boolean;
}) {
  const {
    dossier = FULL,
    status = 200,
    servers = SERVERS,
    serversStatus = 200,
    serversReject = false,
  } = options;
  const impl = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/dossier')) {
      return Promise.resolve(new Response(JSON.stringify(dossier), { status }));
    }
    if (url.startsWith('/api/v1/servers')) {
      if (serversReject) return Promise.reject(new Error('network down'));
      return Promise.resolve(
        new Response(JSON.stringify({ items: servers }), { status: serversStatus }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const TAB_LABELS = {
  skill: 'Скилл',
  weapons: 'Оружие',
  vehicles: 'Техника',
  kits: 'Киты',
} as const;

/** Вкладки досье — сегментированный переключатель; ищем их так же, как скринридер. */
function dossierTabs(): HTMLElement {
  return screen.getByRole('tablist', { name: 'Раздел досье' });
}

function clickTab(tab: keyof typeof TAB_LABELS) {
  fireEvent.click(within(dossierTabs()).getByRole('tab', { name: TAB_LABELS[tab] }));
}

/** First column of every body row of `table`, in render order. */
function firstColumn(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DossierSection', () => {
  it(
    'renders the four tabs with Скилл active on first render',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      expect(screen.getByRole('heading', { name: 'Досье' })).toBeInTheDocument();
      expect(
        within(dossierTabs())
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Скилл', 'Оружие', 'Техника', 'Киты']);
      // Активная вкладка объявлена состоянием, а не оформлением подчёркивания.
      expect(within(dossierTabs()).getByRole('tab', { name: 'Скилл' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(dossierTabs()).getByRole('tab', { name: 'Оружие' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(screen.getByText('Винрейт')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'switching through all four tabs issues no additional fetch',
    async () => {
      const fetchMock = stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      await waitFor(() => expect(screen.getByLabelText('Сервер')).toBeInTheDocument());
      const afterMount = fetchMock.mock.calls.length;

      clickTab('weapons');
      await screen.findByText('Показано 3 из 137');
      clickTab('vehicles');
      await screen.findByText('На технике');
      clickTab('kits');
      await screen.findByText('Кит');

      expect(fetchMock.mock.calls.length).toBe(afterMount);
      const dossierCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/dossier'),
      );
      expect(dossierCalls).toHaveLength(1);
      expect(String(dossierCalls[0]?.[0])).toBe(
        `/api/v1/players/${PLAYER_ID}/dossier?serverId=all&weaponsLimit=20`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the dossier route answers 403',
    async () => {
      stubFetch({ dossier: EMPTY, status: 403 });
      const { container } = render(<DossierSection playerId={PLAYER_ID} />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByRole('heading', { name: 'Досье' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the dossier route answers 401',
    async () => {
      stubFetch({ dossier: EMPTY, status: 401 });
      const { container } = render(<DossierSection playerId={PLAYER_ID} />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByRole('heading', { name: 'Досье' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'skill tab renders the KPI grid and «—» for the permanently null damage',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      for (const label of [
        'K/D',
        'Винрейт',
        'Матчи',
        'Победы',
        'Поражения',
        'Ничьи',
        'Убийства',
        'Смерти',
        'Поднятия',
        'Тимкиллы',
        'Урон',
        'Онлайн',
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getByText('2.00')).toBeInTheDocument();
      expect(screen.getByText('63%')).toBeInTheDocument();
      expect(screen.getByText('90')).toBeInTheDocument();
      expect(screen.getByText('1200')).toBeInTheDocument();
      expect(screen.getByText('393ч 3м')).toBeInTheDocument();

      // Причина прочерка написана словами под значением, а не спрятана в подсказке.
      const damageTile = screen.getByText('Урон').closest('div');
      expect(damageTile).not.toBeNull();
      expect(within(damageTile as HTMLElement).getByText('—')).toBeInTheDocument();
      expect(
        within(damageTile as HTMLElement).getByText(DAMAGE_UNAVAILABLE_HINT),
      ).toBeInTheDocument();

      for (const period of ['3 мес', '6 мес', '12 мес', 'Всё время']) {
        expect(screen.getByRole('tab', { name: period })).toBeInTheDocument();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'skill tab renders the RNSquadJS sub-section with its source note and fallback',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      expect(screen.getByRole('heading', { name: 'RNSquadJS' })).toBeInTheDocument();
      expect(
        screen.getByText('Источник: RNSquadJS, отдельный от боевых агрегатов панели'),
      ).toBeInTheDocument();
      expect(screen.getByText(RNSQUADJS_UNAVAILABLE)).toBeInTheDocument();
      // The fallback sub-section performs no request of its own.
      expect(screen.queryByText(/\/stats/)).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'weapons tab hides the damage sort control when no weapon has damage',
    async () => {
      stubFetch({
        dossier: payload({
          weapons: FULL.weapons.map((row) => ({ ...row, damage: null })),
        }),
      });
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('weapons');

      // Колонка убийств упорядочивает таблицу и объявляет это через aria-sort;
      // колонка урона без данных перестаёт быть сортируемой вовсе.
      const killsHeader = await screen.findByRole('button', { name: /Убийства/ });
      expect(killsHeader.closest('th')).toHaveAttribute('aria-sort', 'descending');
      expect(screen.queryByRole('button', { name: /Урон/ })).not.toBeInTheDocument();

      const damageCells = screen.getAllByTitle(DAMAGE_UNAVAILABLE_HINT);
      expect(damageCells).toHaveLength(3);
      for (const cell of damageCells) {
        expect(cell).toHaveTextContent('—');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'weapons tab shows the damage sort control and reorders when damage exists',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('weapons');

      const damageHeader = await screen.findByRole('button', { name: 'Урон' });
      expect(firstColumn(screen.getByRole('table'))).toEqual(['BP_AK74', 'BP_M4A1', 'BP_RPG7']);

      fireEvent.click(damageHeader);
      // Damage desc, and the null-damage weapon sinks to the end.
      expect(firstColumn(screen.getByRole('table'))).toEqual(['BP_RPG7', 'BP_AK74', 'BP_M4A1']);
      expect(screen.getByRole('button', { name: /Урон/ }).closest('th')).toHaveAttribute(
        'aria-sort',
        'descending',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'weapons tab reports how many of the total weapons are shown',
    async () => {
      const twenty = Array.from({ length: 20 }, (_, index) => ({
        weapon: `BP_WEAPON_${index}`,
        kills: 100 - index,
        teamkills: 0,
        damage: null,
        shots_events: 10,
        last_used_at: null,
      }));
      stubFetch({ dossier: payload({ weapons: twenty, weapons_total: 137 }) });
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('weapons');

      expect(await screen.findByText('Показано 20 из 137')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'vehicles tab shows the catalogue name and the raw asset id in the title',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('vehicles');

      await screen.findByText('На технике');
      expect(screen.getByText('Уничтожено', { selector: 'h3' })).toBeInTheDocument();

      const driven = screen.getByText('МРАП');
      expect(driven).toHaveAttribute('title', 'BP_MRAP_C');
      const destroyed = screen.getByText('БТР-82А');
      expect(destroyed).toHaveAttribute('title', 'BP_BTR82A');
      // formatDamage groups for ru-RU; testing-library normalises the U+00A0.
      expect(screen.getByText('3 400')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'vehicles tab shows the raw asset id for an unlocalized vehicle',
    async () => {
      stubFetch({
        dossier: payload({
          vehicles: [
            {
              vehicle_asset_id: 'BP_Mystery_X',
              name_en: null,
              name_ru: null,
              vehicle_class: null,
              unlocalized: true,
              kills: 3,
              damage: null,
            },
          ],
          vehicle_kills: [],
        }),
      });
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('vehicles');

      await screen.findByText('На технике');
      const row = screen.getByText('BP_Mystery_X');
      expect(row).toHaveAttribute('title', VEHICLE_UNCATALOGUED_HINT);
      // Only the sub-table that has rows is rendered.
      expect(screen.queryByText('Уничтожено', { selector: 'h3' })).not.toBeInTheDocument();

      cleanup();
      vi.unstubAllGlobals();
      stubFetch({ dossier: payload({ vehicles: [] }) });
      render(<DossierSection playerId={PLAYER_ID} />);
      await screen.findByText('K/D');
      clickTab('vehicles');
      await screen.findByText('Уничтожено', { selector: 'h3' });
      expect(screen.queryByText('На технике')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'vehicles and weapons tabs show the lifetime note instead of the server selector',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      await waitFor(() => expect(screen.getByLabelText('Сервер')).toBeInTheDocument());
      expect(screen.getByRole('option', { name: 'Все серверы' })).toBeInTheDocument();

      clickTab('weapons');
      await screen.findByText('Показано 3 из 137');
      expect(screen.queryByLabelText('Сервер')).not.toBeInTheDocument();
      expect(screen.getAllByText(LIFETIME_ONLY_NOTE).length).toBeGreaterThan(0);

      clickTab('vehicles');
      await screen.findByText('На технике');
      expect(screen.queryByLabelText('Сервер')).not.toBeInTheDocument();
      expect(screen.getAllByText(LIFETIME_ONLY_NOTE).length).toBeGreaterThan(0);

      clickTab('kits');
      await screen.findByText('Кит');
      expect(screen.getByLabelText('Сервер')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'kits tab renders Nч Nм sorted by time',
    async () => {
      stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      clickTab('kits');

      await screen.findByText('Кит');
      expect(firstColumn(screen.getByRole('table'))).toEqual(['Rifleman', 'Medic']);
      expect(screen.getByText('2ч 0м')).toBeInTheDocument();
      expect(screen.getByText('1ч 1м')).toBeInTheDocument();
      // A kit that was never played has no last-played date.
      expect(screen.getByText('—')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders an explanatory empty state for a player with no history',
    async () => {
      stubFetch({ dossier: EMPTY });
      const { container } = render(<DossierSection playerId={PLAYER_ID} />);

      expect(
        await screen.findByText('У этого игрока пока нет боевой статистики.'),
      ).toBeInTheDocument();

      clickTab('weapons');
      expect(await screen.findByText('Нет данных по оружию.')).toBeInTheDocument();
      expect(container.querySelector('table')).toBeNull();

      clickTab('vehicles');
      expect(await screen.findByText('Нет данных по технике.')).toBeInTheDocument();
      expect(container.querySelector('table')).toBeNull();

      clickTab('kits');
      expect(await screen.findByText('Нет данных по китам.')).toBeInTheDocument();
      expect(container.querySelector('table')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the error box when the dossier route fails with 500',
    async () => {
      stubFetch({ dossier: EMPTY, status: 500 });
      render(<DossierSection playerId={PLAYER_ID} />);

      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent('Не удалось загрузить досье');
      expect(banner).toHaveTextContent('HTTP 500');
      expect(within(banner).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
      // Шапка и вкладки остаются на месте — сбой не прячет навигацию блока.
      expect(screen.getByRole('heading', { name: 'Досье' })).toBeInTheDocument();
      expect(within(dossierTabs()).getByRole('tab', { name: 'Скилл' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the server selector when the servers route is unavailable',
    async () => {
      stubFetch({ serversStatus: 403 });
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      expect(screen.queryByLabelText('Сервер')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Досье' })).toBeInTheDocument();

      clickTab('kits');
      await screen.findByText('Кит');
      expect(screen.queryByLabelText('Сервер')).not.toBeInTheDocument();

      cleanup();
      vi.unstubAllGlobals();
      stubFetch({ serversReject: true });
      render(<DossierSection playerId={PLAYER_ID} />);
      await screen.findByText('K/D');
      expect(screen.queryByLabelText('Сервер')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Досье' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refetches with a from bound when the period changes',
    async () => {
      const fetchMock = stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      fireEvent.click(screen.getByRole('tab', { name: '3 мес' }));

      await waitFor(() => {
        const dossierCalls = fetchMock.mock.calls.filter((call) =>
          String(call[0]).includes('/dossier'),
        );
        expect(dossierCalls).toHaveLength(2);
        expect(String(dossierCalls[1]?.[0])).toMatch(
          /\/dossier\?serverId=all&weaponsLimit=20&from=\d{4}-\d{2}-01$/,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refetches when a server is selected',
    async () => {
      const fetchMock = stubFetch({});
      render(<DossierSection playerId={PLAYER_ID} />);

      await screen.findByText('K/D');
      await waitFor(() => expect(screen.getByLabelText('Сервер')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Сервер'), { target: { value: SERVERS[1].id } });

      await waitFor(() => {
        const dossierCalls = fetchMock.mock.calls.filter((call) =>
          String(call[0]).includes('/dossier'),
        );
        expect(dossierCalls).toHaveLength(2);
        expect(String(dossierCalls[1]?.[0])).toContain(`serverId=${SERVERS[1].id}`);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
