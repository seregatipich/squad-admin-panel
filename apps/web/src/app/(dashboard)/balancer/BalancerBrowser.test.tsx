// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BalancerBrowser } from './BalancerBrowser';

const SETTINGS = {
  enabled: true,
  win_streak_threshold: 3,
  ticket_diff_threshold: 150,
  one_sided_rounds_threshold: 2,
  quorum: 5,
  pass_threshold_pct: 60,
  require_moderator_veto: false,
  prefer_squad_grouping: true,
  player_level_enabled: false,
};

const IMBALANCE_ITEM = {
  id: '019e0083-0000-7000-8000-0000000000d1',
  source_snapshot_id: 'snap-imbalance',
  server_id: '019e0083-0000-7000-8000-0000000000a1',
  layer: 'Yehorivka_RAAS_v1',
  gamemode: 'RAAS',
  mode: 'squad',
  status: 'open',
  generated_at: '2026-07-27T08:55:00.000Z',
  signals: { win_streak: 4, ticket_diff: -320, one_sided_rounds: 3 },
  proposal: [
    {
      subject_type: 'squad',
      subject_id: 'sq-alpha',
      label: 'Alpha',
      current_team: 1,
      target_team: 2,
      state: 'should_move',
    },
    {
      subject_type: 'squad',
      subject_id: 'sq-bravo',
      label: 'Bravo',
      current_team: 2,
      target_team: 2,
      state: 'on_target',
    },
    {
      subject_type: 'squad',
      subject_id: 'sq-charlie',
      label: 'Charlie',
      current_team: 1,
      target_team: 1,
      state: 'no_change',
    },
  ],
  evaluation: {
    triggered: true,
    reasons: [
      { kind: 'win_streak', observed: 4, threshold: 3 },
      { kind: 'ticket_diff', observed: 320, threshold: 150 },
    ],
  },
};

const HEALTHY_ITEM = {
  ...IMBALANCE_ITEM,
  id: '019e0083-0000-7000-8000-0000000000d2',
  source_snapshot_id: 'snap-healthy',
  evaluation: { triggered: false, reasons: [] },
};

/**
 * Routes the component's three endpoints to canned payloads. Returns the spy so
 * a test can assert the exact request the component made.
 */
function mockApi(options: {
  items?: unknown[];
  settings?: typeof SETTINGS;
  detail?: unknown;
  decisionStatus?: number;
  decisionBody?: unknown;
  proposalsFails?: boolean;
}) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/balancer/settings')) {
      return new Response(JSON.stringify({ settings: options.settings ?? SETTINGS }), {
        status: 200,
      });
    }
    if (url.includes('/decision')) {
      return new Response(JSON.stringify(options.decisionBody ?? { decision: 'acknowledge' }), {
        status: options.decisionStatus ?? 201,
      });
    }
    if (/\/api\/v1\/balancer\/proposals\/[^?]+$/.test(url) && method === 'GET') {
      return new Response(JSON.stringify(options.detail ?? { ...IMBALANCE_ITEM, decisions: [] }), {
        status: 200,
      });
    }
    if (options.proposalsFails) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ items: options.items ?? [], next_cursor: null }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BalancerBrowser empty state', () => {
  it('renders the "no upstream snapshot" state without breaking the page', async () => {
    mockApi({ items: [] });

    render(<BalancerBrowser canEdit />);

    expect(screen.getByRole('heading', { name: 'Балансировщик команд' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Снимков от экспортёра ещё не поступало/)).toBeInTheDocument();
    });
    expect(screen.getByText('Нет снимков по фильтру')).toBeInTheDocument();
  });
});

describe('BalancerBrowser healthy state', () => {
  it('reports "no imbalance" when a snapshot exists but no signal triggered', async () => {
    mockApi({ items: [HEALTHY_ITEM] });

    render(<BalancerBrowser canEdit />);

    await waitFor(() => {
      expect(screen.getByText(/Признаков дисбаланса нет/)).toBeInTheDocument();
    });
    expect(screen.getByText('В норме')).toBeInTheDocument();
    expect(screen.getByText('snap-healthy')).toBeInTheDocument();
  });
});

describe('BalancerBrowser imbalance state', () => {
  it('lists every triggered signal with its observed value and threshold', async () => {
    mockApi({ items: [IMBALANCE_ITEM] });

    render(<BalancerBrowser canEdit />);

    await waitFor(() => {
      expect(screen.getByText(/Есть снимки с превышением порогов/)).toBeInTheDocument();
    });
    expect(screen.getByText('Серия побед: 4 (порог 3)')).toBeInTheDocument();
    expect(screen.getByText('Разница тикетов: 320 (порог 150)')).toBeInTheDocument();
    // "Новое" is also a status-filter option; assert the row's own status cell.
    const row = screen.getByText('snap-imbalance').closest('tr');
    expect(within(row as HTMLElement).getByText('Новое')).toBeInTheDocument();
  });

  it('colours the diff rows purely from the payload state enum', async () => {
    mockApi({ items: [IMBALANCE_ITEM] });

    render(<BalancerBrowser canEdit />);
    await waitFor(() => expect(screen.getByText('snap-imbalance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать' }));

    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const rowOf = (label: string) => screen.getByText(label).closest('tr');
    expect(rowOf('Alpha')?.className).toContain('red');
    expect(rowOf('Bravo')?.className).toContain('emerald');
    expect(rowOf('Charlie')?.className).toContain('neutral');
    expect(screen.getByText('Предлагается перевод')).toBeInTheDocument();
    expect(screen.getByText('На нужной стороне')).toBeInTheDocument();
    expect(screen.getByText('Без изменений')).toBeInTheDocument();
  });
});

describe('BalancerBrowser error state', () => {
  it('surfaces a failed proposals fetch instead of rendering a misleading empty state', async () => {
    mockApi({ proposalsFails: true });

    render(<BalancerBrowser canEdit />);

    await waitFor(() => {
      expect(screen.getByText(/Ошибка загрузки: HTTP 500/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Снимков от экспортёра ещё не поступало/)).not.toBeInTheDocument();
  });
});

describe('BalancerBrowser proposal mode toggle', () => {
  it('disables the player-level mode while player_level_enabled is off', async () => {
    mockApi({ items: [] });

    render(<BalancerBrowser canEdit />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'По игрокам' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'По отрядам' })).toBeEnabled();
  });

  it('requests mode=player once the rules allow the player-level mode', async () => {
    const spy = mockApi({
      items: [],
      settings: { ...SETTINGS, player_level_enabled: true },
    });

    render(<BalancerBrowser canEdit />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'По игрокам' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'По игрокам' }));

    await waitFor(() => {
      expect(spy.mock.calls.some(([url]) => String(url).includes('mode=player'))).toBe(true);
    });
  });
});

describe('BalancerBrowser decisions', () => {
  it('posts an acknowledgement for the opened snapshot and reports the new status', async () => {
    const spy = mockApi({
      items: [IMBALANCE_ITEM],
      decisionBody: { decision: 'acknowledge', status: 'reviewed' },
    });

    render(<BalancerBrowser canEdit />);
    await waitFor(() => expect(screen.getByText('snap-imbalance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать' }));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Принять к сведению' }));

    await waitFor(() => {
      expect(screen.getByText('Решение сохранено: Принято к сведению')).toBeInTheDocument();
    });
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(decisionCall?.[1]?.body)).decision).toBe('acknowledge');
  });

  it('surfaces the API veto_reason_required rejection verbatim', async () => {
    mockApi({
      items: [IMBALANCE_ITEM],
      decisionStatus: 400,
      decisionBody: { error: 'veto_reason_required' },
    });

    render(<BalancerBrowser canEdit />);
    await waitFor(() => expect(screen.getByText('snap-imbalance')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать' }));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Вето' }));

    await waitFor(() => {
      expect(screen.getByText('veto_reason_required')).toBeInTheDocument();
    });
  });

  it('locks every write control for a viewer without balancer:edit', async () => {
    mockApi({ items: [IMBALANCE_ITEM] });

    render(<BalancerBrowser canEdit={false} />);

    await waitFor(() => expect(screen.getByText('snap-imbalance')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Сохранить правила' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать' }));
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Принять к сведению' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Вето' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeDisabled();
  });
});

describe('BalancerBrowser rules form', () => {
  it('PUTs the edited thresholds and confirms the save', async () => {
    const spy = mockApi({ items: [] });

    render(<BalancerBrowser canEdit />);
    await waitFor(() => expect(screen.getByLabelText(/Серия побед/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Серия побед/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить правила' }));

    await waitFor(() => expect(screen.getByText('Правила сохранены')).toBeInTheDocument());
    const putCall = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body)).win_streak_threshold).toBe(7);
  });
});
