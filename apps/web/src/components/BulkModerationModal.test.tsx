// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkModerationModal, type BulkModerationTarget } from './BulkModerationModal';

const TARGETS: BulkModerationTarget[] = [
  { playerId: '019e2000-0000-7000-8000-0000000000a1', name: 'Alpha' },
  { playerId: '019e2000-0000-7000-8000-0000000000a2', name: 'Bravo' },
  { playerId: '019e2000-0000-7000-8000-0000000000a3', name: 'Charlie' },
];

const ALL_PERMS = ['mod:warn', 'mod:kick', 'mod:ban_temp', 'mod:ban_perm'];

function bulkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(bulkResponse({}))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BulkModerationModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <BulkModerationModal
        serverId="srv-1"
        targets={null}
        permissions={ALL_PERMS}
        onOpenChange={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers only the action types the catalog keys allow', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={['mod:kick']}
        onOpenChange={() => undefined}
      />,
    );
    const select = screen.getByLabelText('Действие') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['kick']);
  });

  it('drops the permanent ban length without mod:ban_perm', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={['mod:ban_temp']}
        onOpenChange={() => undefined}
      />,
    );
    const lengths = screen.getByLabelText('Срок бана') as HTMLSelectElement;
    expect(Array.from(lengths.options).map((o) => o.value)).not.toContain('0');
  });

  it('keeps «Далее» disabled until a reason is typed', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={ALL_PERMS}
        onOpenChange={() => undefined}
      />,
    );
    const next = screen.getByRole('button', { name: 'Далее' });
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Читы' } });
    expect(next).toBeEnabled();
  });

  it('blocks the ban confirmation until the target count is typed back', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={ALL_PERMS}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Действие'), { target: { value: 'ban' } });
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Читы' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));

    expect(screen.getByText('Подтвердите массовое действие')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Подтвердить' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Введите количество целей'), {
      target: { value: '2' },
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Введите количество целей'), {
      target: { value: '3' },
    });
    expect(confirm).toBeEnabled();
  });

  it('confirms a kick without the count challenge but still behind a second step', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={['mod:kick']}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Мешает' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.queryByLabelText('Введите количество целей')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
  });

  it('posts the bulk body and renders the applied/failed summary with per-target reasons', async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        bulkResponse({
          bulk_group: '019e2000-0000-7000-8000-00000000bbbb',
          action_type: 'ban',
          server_id: 'srv-1',
          requested: 3,
          applied: 2,
          failed: 1,
          results: [
            { player_id: TARGETS[0].playerId, status: 'applied' },
            { player_id: TARGETS[1].playerId, status: 'applied' },
            { player_id: TARGETS[2].playerId, status: 'failed', error: 'target_offline' },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApplied = vi.fn();

    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={ALL_PERMS}
        onOpenChange={() => undefined}
        onApplied={onApplied}
      />,
    );
    fireEvent.change(screen.getByLabelText('Действие'), { target: { value: 'ban' } });
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Читы' } });
    fireEvent.change(screen.getByLabelText('Срок бана'), { target: { value: '7d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.change(screen.getByLabelText('Введите количество целей'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));

    await screen.findByText('Применено: 2 · Ошибок: 1');
    expect(screen.getByText(/Charlie/)).toBeInTheDocument();
    expect(screen.getByText(/Игрок не в сети/)).toBeInTheDocument();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/moderation-actions/bulk');
    expect(JSON.parse(init.body as string)).toEqual({
      server_id: 'srv-1',
      action_type: 'ban',
      player_ids: TARGETS.map((t) => t.playerId),
      reason: 'Читы',
      ban_length: '7d',
      confirm_bulk: true,
    });
  });

  it('shows the server error code when the request is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(bulkResponse({ error: 'forbidden' }, 403))),
    );
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={['mod:kick']}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Мешает' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByText('forbidden')).toBeInTheDocument();
  });

  it('closes on Отмена', () => {
    const onOpenChange = vi.fn();
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={ALL_PERMS}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('returns to the form from the confirmation step', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={ALL_PERMS}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'Читы' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByLabelText('Причина')).toBeInTheDocument();
  });

  it('renders no action form when the user holds no moderation key', () => {
    render(
      <BulkModerationModal
        serverId="srv-1"
        targets={TARGETS}
        permissions={[]}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getByText('Нет прав на массовые действия модерации.')).toBeInTheDocument();
  });
});
