import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';

/**
 * Subscribe to the panel-host-bridge journalctl_follow stream for a
 * specific squad-server-{uuid} systemd unit and invoke `onLine` for
 * every line received on stdout. Returns a function to abort the tail.
 */
export function tailJournal(params: {
  bridge: BridgeClient;
  unit: string;
  log: Logger;
  onLine: (line: string) => void;
}): () => void {
  const { bridge, unit, log, onLine } = params;
  let buffer = '';
  let aborted = false;

  (async () => {
    try {
      await bridge.journalctlFollow({ unit, lines: 100 }, (frame) => {
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
        log.error({ err: (err as Error).message, unit }, 'journalctl_follow ended');
      }
    }
  })();

  return () => {
    aborted = true;
  };
}
