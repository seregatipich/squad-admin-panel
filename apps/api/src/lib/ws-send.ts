/**
 * Backpressure-aware sending for the API's push WebSockets (`/ws/live`,
 * server logs, depot progress).
 *
 * `ws` queues every frame a client has not read yet in the API process with
 * no upper bound, so a client that stops reading (a sleeping tab, a bad
 * network, or a client that answers pings but never drains the socket) would
 * otherwise grow the API's memory with every event of the stream.
 */

/** Queued bytes above which a client counts as stalled and is dropped. */
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** The slice of a `ws` WebSocket this module needs. */
export interface BufferedSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

/**
 * Sends one text frame unless the client has fallen too far behind.
 *
 * A stalled client is terminated rather than closed: a close frame would
 * queue behind the data it is not reading. The browser sees an abnormal close
 * and reconnects, receiving a fresh stream.
 *
 * @param socket - The client socket.
 * @param data - The already serialised frame.
 * @param maxBufferedBytes - Queued-byte limit; defaults to {@link WS_MAX_BUFFERED_BYTES}.
 * @returns Whether the frame was queued (false when the client was dropped).
 */
export function sendUnlessStalled(
  socket: BufferedSocket,
  data: string,
  maxBufferedBytes: number = WS_MAX_BUFFERED_BYTES,
): boolean {
  if (socket.bufferedAmount > maxBufferedBytes) {
    socket.terminate();
    return false;
  }
  socket.send(data);
  return true;
}

const serialised = new WeakMap<object, string>();

/**
 * JSON-encodes a fanned-out event once, however many sockets receive it: the
 * live bus hands the same object to every subscriber, so the encoding is
 * cached per object and dropped with it.
 *
 * @param event - The event object shared by all subscribers.
 * @returns Its JSON text.
 */
export function serialiseOnce(event: object): string {
  const cached = serialised.get(event);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(event);
  serialised.set(event, text);
  return text;
}
