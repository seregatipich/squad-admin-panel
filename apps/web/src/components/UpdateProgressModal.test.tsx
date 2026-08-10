// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateProgressModal } from './UpdateProgressModal';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  // biome-ignore lint/suspicious/noExplicitAny: test fixture stands in for the real WebSocket global
  vi.stubGlobal('WebSocket', FakeWebSocket as any);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('no WebSocket was constructed');
  return ws;
}

describe('UpdateProgressModal', () => {
  it('renders nothing when closed', () => {
    render(
      <UpdateProgressModal
        open={false}
        onOpenChange={() => {}}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление"
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects to wsUrl and streams lines into the log console', async () => {
    render(
      <UpdateProgressModal
        open
        onOpenChange={() => {}}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление игры"
      />,
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latestSocket().url).toBe(`ws://${window.location.host}/api/v1/depot/progress/ws`);

    act(() => latestSocket().emitOpen());
    expect(screen.getByText('Обновление…')).toBeInTheDocument();

    act(() =>
      latestSocket().emitMessage({
        ts: '2026-08-04T00:00:00.000Z',
        stream: 'stdout',
        message: 'Update state (0x5) verifying install…',
      }),
    );
    expect(screen.getByText(/verifying install/)).toBeInTheDocument();
  });

  it('ignores the backfill_complete marker as a log line', async () => {
    render(
      <UpdateProgressModal
        open
        onOpenChange={() => {}}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление"
      />,
    );
    act(() => latestSocket().emitOpen());
    act(() => latestSocket().emitMessage({ backfill_complete: true }));
    expect(screen.getByText('Ожидание первого сообщения…')).toBeInTheDocument();
  });

  it('ignores a done frame received before backfill_complete (stale/historical)', async () => {
    const onDone = vi.fn();
    render(
      <UpdateProgressModal
        open
        onOpenChange={() => {}}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление"
        onDone={onDone}
      />,
    );
    act(() => latestSocket().emitOpen());
    act(() => latestSocket().emitMessage({ done: true, final: 'done' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText('Обновление…')).toBeInTheDocument();
    expect(latestSocket().closed).toBe(false);
  });

  it('settles on a live done frame after backfill_complete, calls onDone, and closes the socket', async () => {
    const onDone = vi.fn();
    render(
      <UpdateProgressModal
        open
        onOpenChange={() => {}}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление"
        onDone={onDone}
      />,
    );
    const ws = latestSocket();
    act(() => ws.emitOpen());
    act(() => ws.emitMessage({ backfill_complete: true }));
    act(() => ws.emitMessage({ done: true, final: 'error', error: 'steamcmd exploded' }));

    expect(onDone).toHaveBeenCalledWith('error', 'steamcmd exploded');
    expect(screen.getByText('Ошибка обновления')).toBeInTheDocument();
    expect(ws.closed).toBe(true);
  });

  it('calls onOpenChange(false) when the close button is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <UpdateProgressModal
        open
        onOpenChange={onOpenChange}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
