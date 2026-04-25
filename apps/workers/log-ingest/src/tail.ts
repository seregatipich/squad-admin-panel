import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';

export function tailContainerLogs(params: {
  bridge: BridgeClient;
  name: string;
  log: Logger;
  onLine: (line: string) => void;
}): () => void {
  const { bridge, name, log, onLine } = params;
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
      }
    } catch (err) {
      if (!aborted) {
        log.warn({ container: name, err: (err as Error).message }, 'tail dropped → restart');
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
