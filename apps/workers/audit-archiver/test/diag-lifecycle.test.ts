import type { DiagEvent } from '@squad/diag';
import { describe, expect, it } from 'vitest';
import { runArchiverCycle } from '../src/index.js';

describe('audit-archiver diag lifecycle', () => {
  it('emits audit_archiver.run_ok per scheduled cycle', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    await runArchiverCycle({ diag });
    expect(captured.some((e) => e.kind === 'audit_archiver.run_ok')).toBe(true);
    const ok = captured.find((e) => e.kind === 'audit_archiver.run_ok');
    expect(ok?.component).toBe('worker-audit-archiver');
    expect(ok?.severity).toBe('info');
  });
});
