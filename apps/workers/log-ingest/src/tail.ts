import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';

/**
 * Subscribe to `docker logs -f` for the Squad server container via the
 * panel-host-bridge. `name` is the container name (squad-{uuid}). Each
 * complete line is delivered to `onLine`. Returns a function to abort.
 */
export function tailContainerLogs(params: {
  bridge: BridgeClient;
  name: string;
  log: Logger;
  onLine: (line: string) => void;
}): () => void {
  const { bridge, name, log, onLine } = params;
  let buffer = '';
  let aborted = false;

  (async () => {
    try {
      await bridge.containerLogsFollow({ name, tail: 100 }, (frame) => {
        if (aborted) return;
        if (frame.stream !== 'stdout') return;
        const text = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
        buffer += text;
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.length === 0) continue;
          onLine(part);
        }
      });
    } catch (err) {
      if (!aborted) {
        log.error({ err: (err as Error).message, name }, 'container_logs_follow ended');
      }
    }
  })();

  return () => {
    aborted = true;
  };
}
