import type { Diag, DiagEvent } from '@squad/diag';
import { describe, expect, it, vi } from 'vitest';
import { type TailHandle, TailManager } from '../src/manager.js';

function makeDiag(): Diag & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

const wantA = { serverId: 'srv-a', beaconPort: 15000 };
const wantB = { serverId: 'srv-b', beaconPort: 15010 };

describe('TailManager.reconcile', () => {
  it('starts a tail for each new server and emits tails.changed with added/removed/total', () => {
    const diag = makeDiag();
    const factory = vi.fn(
      (_serverId: string, _beaconPort: number): TailHandle => ({ abort: vi.fn() }),
    );
    const manager = new TailManager(factory, diag);

    const first = manager.reconcile([wantA]);
    expect(first).toEqual({ added: ['srv-a'], removed: [], total: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('srv-a', 15000);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    const firstEv = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(firstEv.component).toBe('worker-log-ingest');
    expect(firstEv.kind).toBe('tails.changed');
    expect(firstEv.severity).toBe('info');
    expect(firstEv.payload).toEqual({ added: ['srv-a'], removed: [], total: 1 });
  });

  it('does not emit on unchanged reconciliation ticks', () => {
    const diag = makeDiag();
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);

    manager.reconcile([wantA]);
    manager.reconcile([wantA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('emits tails.changed with removed list when a server leaves the wanted set', () => {
    const diag = makeDiag();
    const abortA = vi.fn();
    const abortB = vi.fn();
    const factory = vi.fn((serverId: string) => ({
      abort: serverId === 'srv-a' ? abortA : abortB,
    }));
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantA, wantB]);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    const initialEv = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(initialEv.payload).toEqual({ added: ['srv-a', 'srv-b'], removed: [], total: 2 });

    manager.reconcile([wantB]);
    expect(diag.emit).toHaveBeenCalledTimes(2);
    const removedEv = diag.emit.mock.calls[1]?.[0] as DiagEvent;
    expect(removedEv.payload).toEqual({ added: [], removed: ['srv-a'], total: 1 });
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).not.toHaveBeenCalled();
  });

  it('reports both added and removed in a single net delta', () => {
    const diag = makeDiag();
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantA]);
    diag.emit.mockClear();

    manager.reconcile([wantB]);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    const ev = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(ev.payload).toEqual({ added: ['srv-b'], removed: ['srv-a'], total: 1 });
  });

  it('omits diag emits when no diag is provided', () => {
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory);
    expect(() => manager.reconcile([wantA])).not.toThrow();
    expect(() => manager.reconcile([])).not.toThrow();
  });

  it('stopAll aborts every running tail and clears the set', () => {
    const diag = makeDiag();
    const abortA = vi.fn();
    const abortB = vi.fn();
    const factory = vi.fn((serverId: string) => ({
      abort: serverId === 'srv-a' ? abortA : abortB,
    }));
    const manager = new TailManager(factory, diag);
    manager.reconcile([wantA, wantB]);

    manager.stopAll();
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
    expect(manager.size()).toBe(0);
  });
});
