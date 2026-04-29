import type { DiagEvent } from '@squad/diag';
import { describe, expect, it, vi } from 'vitest';
import { runPartitionTick } from '../src/index.js';

function makeFakeSql() {
  const queries: string[] = [];
  const sql = Object.assign(
    ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('pg_inherits') || text.includes('pg_class')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as never,
    {
      unsafe: vi.fn(async (text: string) => {
        queries.push(text);
      }),
    },
  ) as never;
  return { sql, queries };
}

describe('event-partition diag lifecycle', () => {
  it('emits event_partition.run_ok on a successful tick', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    const { sql } = makeFakeSql();
    await runPartitionTick({ sql, diag });
    const ok = captured.find((e) => e.kind === 'event_partition.run_ok');
    expect(ok).toBeDefined();
    expect(ok?.component).toBe('worker-event-partition');
    expect(ok?.severity).toBe('info');
  });

  it('emits event_partition.run_failed when ensureDiagPartitions throws', async () => {
    const captured: DiagEvent[] = [];
    const diag = {
      async emit(ev: DiagEvent) {
        captured.push(ev);
      },
    };
    const failingSql = Object.assign(
      ((_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve([])) as never,
      {
        unsafe: vi.fn(async (_text: string) => {
          throw new Error('partition DDL refused');
        }),
      },
    ) as never;
    await runPartitionTick({ sql: failingSql, diag });
    const failed = captured.find((e) => e.kind === 'event_partition.run_failed');
    expect(failed).toBeDefined();
    expect(failed?.severity).toBe('error');
    expect(failed?.payload).toBeDefined();
  });
});
