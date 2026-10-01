// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportListItem } from '@/lib/live-bus';
import { ReportCard } from './ReportCard';
import { ReportGroupBlock } from './ReportGroupBlock';

const TARGET_ID = 'b1e2c3d4-0000-0000-0000-000000000001';

function makeReport(id: string, overrides: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id,
    server_id: 'server-1',
    reporter_player_id: 'reporter-1',
    target_player_id: TARGET_ID,
    target_raw: null,
    body: 'Cheating',
    source: 'ui',
    status: 'pending',
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
    ...overrides,
  };
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Answers by `METHOD path`; an unrouted request fails the test loudly. */
function stubApi(routes: Record<string, Route>) {
  const calls: Array<{ key: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      calls.push({ key, init });
      const route = routes[key];
      if (!route) return Promise.reject(new Error(`unexpected fetch: ${key}`));
      return Promise.resolve(route(init));
    }),
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportCard', () => {
  it('notifies the reporter with the chosen template and reports success', async () => {
    const calls = stubApi({
      'POST /api/v1/reports/r1/notify-reporter': () => json({ ok: true }),
    });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Шаблон уведомления'), {
      target: { value: 'resolved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Уведомить репортёра' }));

    expect(await screen.findByText('Уведомление отправлено.')).toBeInTheDocument();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ template: 'resolved' });
  });

  it('says the reporter is offline on a 409 and shows the API code on other failures', async () => {
    stubApi({ 'POST /api/v1/reports/r1/notify-reporter': () => json({ error: 'x' }, 409) });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Уведомить репортёра' }));
    expect(await screen.findByText('Репортёр не в сети')).toBeInTheDocument();

    cleanup();
    stubApi({
      'POST /api/v1/reports/r1/notify-reporter': () => json({ error: 'rcon_unavailable' }, 502),
    });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Уведомить репортёра' }));
    expect(await screen.findByText('HTTP 502: rcon_unavailable')).toBeInTheDocument();
  });

  it('loads linked actions once when the list is opened and treats a failure as empty', async () => {
    const calls = stubApi({
      'GET /api/v1/reports/r1/actions': () =>
        json({
          actions: [
            {
              id: 'a1',
              action_type: 'warn',
              reason: 'Спам в чате',
              context: {},
              report_id: 'r1',
              created_at: '2026-07-02T00:00:00.000Z',
              reverted_at: null,
              server: null,
              author: { kind: 'system', label: 'Система' },
            },
          ],
        }),
    });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: 'Связанные действия' });
    fireEvent.click(toggle);
    expect(await screen.findByText('Спам в чате')).toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(calls).toHaveLength(1);

    cleanup();
    stubApi({ 'GET /api/v1/reports/r2/actions': () => json({ error: 'boom' }, 500) });
    render(<ReportCard report={makeReport('r2')} canHandle onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Связанные действия' }));
    expect(await screen.findByText('Связанных действий пока нет.')).toBeInTheDocument();
  });

  it('refreshes an open linked-actions list after a moderation action is accepted', async () => {
    let listed = 0;
    stubApi({
      'GET /api/v1/reports/r1/actions': () => {
        listed += 1;
        return json({ actions: [] });
      },
      'POST /api/v1/reports/r1/actions': () => json({ ok: true }),
    });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Связанные действия' }));
    await waitFor(() => expect(listed).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Предупредить' }));
    const submit = screen.getAllByRole('button', { name: 'Предупредить' }).at(-1);
    if (!submit) throw new Error('warn submit button not found');
    fireEvent.click(submit);

    await waitFor(() => expect(listed).toBe(2));
    expect(screen.queryByText('Действие не выполнено')).not.toBeInTheDocument();
  });

  it('keeps the action modal open and shows the API code when the action is refused', async () => {
    stubApi({
      'POST /api/v1/reports/r1/actions': () => json({ error: 'forbidden' }, 403),
    });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Кикнуть' }));
    const submit = screen.getAllByRole('button', { name: 'Кикнуть' }).at(-1);
    if (!submit) throw new Error('kick submit button not found');
    fireEvent.click(submit);

    expect(await screen.findByText('HTTP 403: forbidden')).toBeInTheDocument();
    expect(screen.getByText('Действие не выполнено')).toBeInTheDocument();
  });

  it('rejects an empty reason before any request is sent', async () => {
    const calls = stubApi({});
    render(<ReportCard report={makeReport('r1', { body: '' })} canHandle onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Предупредить' }));
    const submit = screen.getAllByRole('button', { name: 'Предупредить' }).at(-1);
    if (!submit) throw new Error('warn submit button not found');
    fireEvent.click(submit);

    expect(await screen.findByText('Укажите причину.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('patches only the changed fields and tells the parent to reload', async () => {
    const onSaved = vi.fn();
    const calls = stubApi({ 'PATCH /api/v1/reports/r1': () => json({ ok: true }) });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Обработать' }));
    fireEvent.change(screen.getByLabelText('Статус жалобы'), { target: { value: 'resolved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ status: 'resolved' });
  });

  it('closes the editor without a request when nothing changed', async () => {
    const onSaved = vi.fn();
    const calls = stubApi({});
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Обработать' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(screen.queryByLabelText('Статус жалобы')).not.toBeInTheDocument());
    expect(calls).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows the API code in the editor when saving fails', async () => {
    const onSaved = vi.fn();
    stubApi({ 'PATCH /api/v1/reports/r1': () => json({ error: 'forbidden' }, 403) });
    render(<ReportCard report={makeReport('r1')} canHandle onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Обработать' }));
    fireEvent.change(screen.getByLabelText('Статус жалобы'), { target: { value: 'rejected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('HTTP 403: forbidden')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows no handling controls without the handle permission', () => {
    render(<ReportCard report={makeReport('r1')} canHandle={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Обработать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Забанить' })).not.toBeInTheDocument();
  });
});

describe('ReportGroupBlock', () => {
  const group = {
    target_player_id: TARGET_ID,
    target_name: 'Target',
    reports: [makeReport('r1'), makeReport('r2')],
  };

  it('asks for a note before resolving the whole group', async () => {
    const calls = stubApi({});
    render(<ReportGroupBlock group={group} canHandle onSaved={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть группу' })[0] as HTMLElement);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Закрыть группу' }).at(-1) as HTMLElement,
    );

    expect(await screen.findByText('Нужна заметка для закрытия группы.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('posts one bulk-resolve request with the trimmed note and reloads the queue', async () => {
    const onSaved = vi.fn();
    const calls = stubApi({ 'POST /api/v1/reports/bulk-resolve': () => json({ resolved: 2 }) });
    render(<ReportGroupBlock group={group} canHandle onSaved={onSaved} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть группу' })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText(/Заметка для закрытия группы/), {
      target: { value: '  дубликаты  ' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Закрыть группу' }).at(-1) as HTMLElement,
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      target_player_id: TARGET_ID,
      status: 'resolved',
      resolution_note: 'дубликаты',
    });
  });

  it('shows the API code when the group cannot be closed', async () => {
    const onSaved = vi.fn();
    stubApi({ 'POST /api/v1/reports/bulk-resolve': () => json({ error: 'forbidden' }, 403) });
    render(<ReportGroupBlock group={group} canHandle onSaved={onSaved} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть группу' })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText(/Заметка для закрытия группы/), {
      target: { value: 'дубликаты' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Закрыть группу' }).at(-1) as HTMLElement,
    );

    expect(await screen.findByText('HTTP 403: forbidden')).toBeInTheDocument();
    expect(screen.getByText('Группа не закрыта')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
