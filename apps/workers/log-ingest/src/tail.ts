import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';
import { createLineSplitter } from './line-splitter.js';

export type TailStopReason = 'aborted' | 'stream-end' | 'stream-error';

/**
 * Follows `docker logs -f` of one container through the host bridge and feeds
 * every complete stdout line to `onLine`.
 *
 * The bridge only stops a follow (and kills its `docker logs -f` child) when
 * the connection carrying it closes; the protocol has no per-call cancel. The
 * tail therefore opens its own client with `openBridge` and closes it both
 * when stopped and when the stream ends, so a stopped tail leaves no pending
 * call in a shared client and no follow running on the host.
 *
 * @param params.openBridge creates the tail's dedicated, not-yet-shared client.
 * @returns a stop function; calling it more than once is harmless.
 */
export function tailContainerLogs(params: {
  openBridge: () => BridgeClient;
  name: string;
  log: Logger;
  onLine: (line: string) => void;
  onStarted?: () => void;
  onStopped?: (info: { reason: TailStopReason; error?: string }) => void;
}): () => void {
  const { openBridge, name, log, onLine, onStarted, onStopped } = params;
  const bridge = openBridge();
  const closeBridge = () => {
    bridge.close().catch(() => undefined);
  };
  let aborted = false;
  let bytesThisMinute = 0;
  let linesThisMinute = 0;
  const splitLines = createLineSplitter(
    (line) => {
      linesThisMinute++;
      onLine(line);
    },
    () => log.warn({ container: name }, 'tail line exceeded limit, discarded'),
  );

  log.info({ container: name }, `tail start container=${name}`);

  const reportTimer = setInterval(() => {
    if (aborted) return;
    log.debug(
      { container: name, bytesPerMin: bytesThisMinute, linesPerMin: linesThisMinute },
      `tail bytes/min=${bytesThisMinute} lines/min=${linesThisMinute}`,
    );
    bytesThisMinute = 0;
    linesThisMinute = 0;
  }, 60_000);

  (async () => {
    onStarted?.();
    try {
      await bridge.containerLogsFollow({ name, tail: 100 }, (frame) => {
        if (aborted) return;
        if (frame.stream !== 'stdout') return;
        const text = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
        bytesThisMinute += text.length;
        splitLines(text);
      });
      if (!aborted) {
        log.warn({ container: name }, 'tail dropped → restart');
        onStopped?.({ reason: 'stream-end' });
      } else {
        onStopped?.({ reason: 'aborted' });
      }
    } catch (err) {
      const errorMessage = (err as Error).message;
      if (!aborted) {
        log.warn({ container: name, err: errorMessage }, 'tail dropped → restart');
        onStopped?.({ reason: 'stream-error', error: errorMessage });
      } else {
        onStopped?.({ reason: 'aborted', error: errorMessage });
      }
    } finally {
      clearInterval(reportTimer);
      closeBridge();
    }
  })();

  return () => {
    aborted = true;
    clearInterval(reportTimer);
    closeBridge();
  };
}
