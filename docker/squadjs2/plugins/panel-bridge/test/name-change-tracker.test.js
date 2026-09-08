import { describe, expect, it } from 'vitest';
import { NameChangeTracker } from '../src/panel-bridge/name-change-tracker.js';

const alpha = (name) => ({ eosID: 'a'.repeat(32), steamID: '76561199000000001', name });
const bravo = (name) => ({ eosID: 'b'.repeat(32), steamID: '76561199000000002', name });

describe('NameChangeTracker', () => {
  it('emits nothing for the first snapshot of a player', () => {
    const tracker = new NameChangeTracker();
    expect(tracker.diff([alpha('PanelAlpha')])).toEqual([]);
  });

  it('emits nothing when the name is unchanged', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([alpha('PanelAlpha')]);
    expect(tracker.diff([alpha('PanelAlpha')])).toEqual([]);
  });

  it('emits one change per renamed player, keyed by steam id', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([alpha('PanelAlpha'), bravo('PanelBravo')]);

    const changes = tracker.diff([alpha('PanelAlpha'), bravo('RenamedBravo')]);

    expect(changes).toEqual([
      {
        steam_id64: '76561199000000002',
        eos_id: 'b'.repeat(32),
        name: 'RenamedBravo',
        old_name: 'PanelBravo',
        new_name: 'RenamedBravo',
      },
    ]);
  });

  it('carries the new name forward so one rename is reported once', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([bravo('PanelBravo')]);
    tracker.diff([bravo('RenamedBravo')]);
    expect(tracker.diff([bravo('RenamedBravo')])).toEqual([]);
  });

  it('forgets a player on disconnect so a rejoin is a first snapshot again', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([bravo('PanelBravo')]);
    tracker.forget(bravo('PanelBravo'));
    expect(tracker.diff([bravo('RenamedBravo')])).toEqual([]);
  });

  it('ignores players with no usable identity', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([{ name: 'Ghost' }, { eosID: null, steamID: null, name: 'Ghost2' }]);
    expect(tracker.diff([{ name: 'GhostRenamed' }])).toEqual([]);
  });

  it('falls back to the eos id when a player has no steam id', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([{ eosID: 'c'.repeat(32), steamID: null, name: 'EosOnly' }]);

    const changes = tracker.diff([{ eosID: 'c'.repeat(32), steamID: null, name: 'EosRenamed' }]);

    expect(changes).toEqual([
      {
        steam_id64: null,
        eos_id: 'c'.repeat(32),
        name: 'EosRenamed',
        old_name: 'EosOnly',
        new_name: 'EosRenamed',
      },
    ]);
  });

  it('drops players that left the snapshot so state stays bounded', () => {
    const tracker = new NameChangeTracker();
    tracker.diff([alpha('PanelAlpha'), bravo('PanelBravo')]);
    tracker.diff([alpha('PanelAlpha')]);
    expect(tracker.size).toBe(1);
    // Bravo comes back renamed: without retained state this is a first snapshot.
    expect(tracker.diff([alpha('PanelAlpha'), bravo('RenamedBravo')])).toEqual([]);
  });

  it('tolerates a missing or empty player list', () => {
    const tracker = new NameChangeTracker();
    expect(tracker.diff(undefined)).toEqual([]);
    expect(tracker.diff([])).toEqual([]);
  });
});
