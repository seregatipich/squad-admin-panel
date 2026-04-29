import type { Diag } from '@squad/diag';

export const COMPONENT = 'worker-metrics-sampler';

export async function emitStarted(diag: Diag): Promise<void> {
  await diag.emit({
    component: COMPONENT,
    kind: 'metrics_sampler.started',
    severity: 'info',
    message: 'metrics-sampler started',
    payload: { pid: process.pid },
  });
}

export async function emitStopped(diag: Diag, sig: NodeJS.Signals): Promise<void> {
  await diag.emit({
    component: COMPONENT,
    kind: 'metrics_sampler.stopped',
    severity: 'info',
    message: `metrics-sampler received ${sig}`,
    payload: { sig },
  });
}
