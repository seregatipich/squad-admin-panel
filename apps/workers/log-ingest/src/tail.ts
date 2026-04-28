import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';

export type TailStopReason = 'aborted' | 'stream-end' | 'stream-error';

export function tailContainerLogs(params: {
  bridge: BridgeClient;
  name: string;
  log: Logger;
  onLine: (line: string) => void;
  onStarted?: () => void;
  onStopped?: (info: { reason: TailStopReason; error?: string }) => void;
}): () => void {
  const { bridge, name, log, onLine, onStarted, onStopped } = params;
  let buffer = '';
  let aborted = false;
  let bytesThisMinute = 0;
  let linesThisMinute = 0;

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
        buffer += text;
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.length === 0) continue;
          linesThisMinute++;
          onLine(part);
        }
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
    }
  })();

  return () => {
    aborted = true;
    clearInterval(reportTimer);
  };
}
