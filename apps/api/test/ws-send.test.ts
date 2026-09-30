import { describe, expect, it, vi } from 'vitest';
import { sendUnlessStalled, serialiseOnce, WS_MAX_BUFFERED_BYTES } from '../src/lib/ws-send.js';

// #1297: WebSocket sends are bounded by the client's unread backlog, and a
// fanned-out event is encoded once.
function fakeSocket(bufferedAmount: number) {
  return { bufferedAmount, send: vi.fn(), terminate: vi.fn() };
}

describe('sendUnlessStalled', () => {
  it('sends while the backlog is within the limit', () => {
    const socket = fakeSocket(WS_MAX_BUFFERED_BYTES);
    expect(sendUnlessStalled(socket, 'frame')).toBe(true);
    expect(socket.send).toHaveBeenCalledWith('frame');
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('terminates instead of sending once the backlog exceeds the limit', () => {
    const socket = fakeSocket(WS_MAX_BUFFERED_BYTES + 1);
    expect(sendUnlessStalled(socket, 'frame')).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('honours an explicit limit', () => {
    const socket = fakeSocket(11);
    expect(sendUnlessStalled(socket, 'frame', 10)).toBe(false);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
});

describe('serialiseOnce', () => {
  it('encodes the same object once and reuses the text', () => {
    const event = { type: 'chat.message', data: { id: 'a' } };
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const first = serialiseOnce(event);
      const second = serialiseOnce(event);
      expect(first).toBe('{"type":"chat.message","data":{"id":"a"}}');
      expect(second).toBe(first);
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('encodes distinct objects separately', () => {
    expect(serialiseOnce({ n: 1 })).toBe('{"n":1}');
    expect(serialiseOnce({ n: 2 })).toBe('{"n":2}');
  });
});
