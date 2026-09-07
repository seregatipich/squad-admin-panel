import type { Diag, DiagEvent } from '@squad/diag';
import { describe, expect, it, vi } from 'vitest';
import {
  type SshTailSource,
  type TailHandle,
  TailManager,
  type TailWanted,
  tailSourceKey,
} from '../src/manager.js';

function makeDiag(): Diag & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

const wantA: TailWanted = { serverId: 'srv-a', beaconPort: 15000, source: { kind: 'container' } };
const wantB: TailWanted = { serverId: 'srv-b', beaconPort: 15010, source: { kind: 'container' } };

const sshSource: SshTailSource = {
  kind: 'ssh',
  host: '203.0.113.10',
  port: 22,
  username: 'squad',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
  logPath: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
  hostKeyFingerprint: null,
  keyVersion: 1,
};
const wantSsh: TailWanted = { serverId: 'srv-ext', beaconPort: 15000, source: sshSource };

describe('TailManager.reconcile', () => {
  it('starts a tail for each new server and emits tails.changed with added/removed/total', () => {
    const diag = makeDiag();
    const factory = vi.fn((_wanted: TailWanted): TailHandle => ({ abort: vi.fn() }));
    const manager = new TailManager(factory, diag);

    const first = manager.reconcile([wantA]);
    expect(first).toEqual({ added: ['srv-a'], removed: [], replaced: [], total: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(wantA);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    const firstEv = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(firstEv.component).toBe('worker-log-ingest');
    expect(firstEv.kind).toBe('tails.changed');
    expect(firstEv.severity).toBe('info');
    expect(firstEv.payload).toEqual({ added: ['srv-a'], removed: [], replaced: [], total: 1 });
  });

  it('does not emit on unchanged reconciliation ticks', () => {
    const diag = makeDiag();
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);

    manager.reconcile([wantA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('aborts and reports removed tails', () => {
    const diag = makeDiag();
    const aborts = new Map<string, ReturnType<typeof vi.fn>>();
    const factory = vi.fn((wanted: TailWanted) => {
      const abort = vi.fn();
      aborts.set(wanted.serverId, abort);
      return { abort };
    });
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantA, wantB]);
    const initialEv = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(initialEv.payload).toEqual({
      added: ['srv-a', 'srv-b'],
      removed: [],
      replaced: [],
      total: 2,
    });

    manager.reconcile([wantB]);
    expect(aborts.get('srv-a')).toHaveBeenCalledTimes(1);
    expect(aborts.get('srv-b')).not.toHaveBeenCalled();
    const removedEv = diag.emit.mock.calls[1]?.[0] as DiagEvent;
    expect(removedEv.payload).toEqual({ added: [], removed: ['srv-a'], replaced: [], total: 1 });
  });

  it('reports a swap as one added and one removed', () => {
    const diag = makeDiag();
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory, diag);
    manager.reconcile([wantA]);
    manager.reconcile([wantB]);
    const ev = diag.emit.mock.calls[1]?.[0] as DiagEvent;
    expect(ev.payload).toEqual({ added: ['srv-b'], removed: ['srv-a'], replaced: [], total: 1 });
  });

  it('works without a diag sink', () => {
    const factory = vi.fn(() => ({ abort: vi.fn() }));
    const manager = new TailManager(factory);
    expect(() => manager.reconcile([wantA])).not.toThrow();
    expect(manager.size()).toBe(1);
  });

  it('stopAll aborts every tail and empties the set', () => {
    const aborts: ReturnType<typeof vi.fn>[] = [];
    const factory = vi.fn(() => {
      const abort = vi.fn();
      aborts.push(abort);
      return { abort };
    });
    const manager = new TailManager(factory);
    manager.reconcile([wantA, wantB]);
    manager.stopAll();
    expect(manager.size()).toBe(0);
    for (const abort of aborts) expect(abort).toHaveBeenCalledTimes(1);
  });

  it('replaces a running SSH tail when its dial parameters change, but not on a fingerprint pin', () => {
    // The operator repointed the log source (PUT /log-source) — the running
    // tail holds the old host/path/key and must be swapped, not left to
    // retry a dead endpoint until the worker restarts.
    const diag = makeDiag();
    const aborts: ReturnType<typeof vi.fn>[] = [];
    const factory = vi.fn(() => {
      const abort = vi.fn();
      aborts.push(abort);
      return { abort };
    });
    const manager = new TailManager(factory, diag);

    manager.reconcile([wantSsh]);
    expect(factory).toHaveBeenCalledTimes(1);

    // Trust-on-first-use wrote the fingerprint back: same stream, no redial.
    manager.reconcile([{ ...wantSsh, source: { ...sshSource, hostKeyFingerprint: 'SHA256:abc' } }]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(aborts[0]).not.toHaveBeenCalled();

    const moved = manager.reconcile([
      {
        ...wantSsh,
        source: { ...sshSource, logPath: '/opt/squad2/SquadGame/Saved/Logs/SquadGame.log' },
      },
    ]);
    expect(moved).toEqual({ added: [], removed: [], replaced: ['srv-ext'], total: 1 });
    expect(aborts[0]).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);

    const rotated = manager.reconcile([
      {
        ...wantSsh,
        source: {
          ...sshSource,
          logPath: '/opt/squad2/SquadGame/Saved/Logs/SquadGame.log',
          keyVersion: 2,
          privateKey: 'different material',
        },
      },
    ]);
    expect(rotated.replaced).toEqual(['srv-ext']);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('tailSourceKey never embeds the private key material', () => {
    expect(tailSourceKey(wantSsh)).not.toContain('PRIVATE');
    expect(tailSourceKey(wantSsh)).toContain('/opt/squad1/');
    expect(tailSourceKey(wantA)).toBe('container:15000');
  });
});
