import type { DiagEvent } from '@squad/diag';
import { describe, expect, it } from 'vitest';
import { emitStarted, emitStopped } from '../src/index.js';

describe('diag-flush diag lifecycle', () => {
  it('emitStarted emits diag_flush.started with severity info', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    await emitStarted(diag);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('diag_flush.started');
    expect(captured[0]?.component).toBe('worker-diag-flush');
    expect(captured[0]?.severity).toBe('info');
  });

  it('emitStopped emits diag_flush.stopped with the signal in payload', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    await emitStopped(diag, 'SIGTERM');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('diag_flush.stopped');
    expect(captured[0]?.severity).toBe('info');
    expect(captured[0]?.payload).toEqual({ sig: 'SIGTERM' });
  });
});
