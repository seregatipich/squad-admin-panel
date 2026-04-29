import type { DiagEvent } from '@squad/diag';
import { describe, expect, it } from 'vitest';
import { emitStarted, emitStopped } from '../src/lifecycle.js';

describe('metrics-sampler diag lifecycle', () => {
  it('emitStarted emits metrics_sampler.started with severity info', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    await emitStarted(diag);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('metrics_sampler.started');
    expect(captured[0]?.component).toBe('worker-metrics-sampler');
    expect(captured[0]?.severity).toBe('info');
  });

  it('emitStopped emits metrics_sampler.stopped with the signal in payload', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    await emitStopped(diag, 'SIGTERM');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('metrics_sampler.stopped');
    expect(captured[0]?.severity).toBe('info');
    expect(captured[0]?.payload).toEqual({ sig: 'SIGTERM' });
  });
});
