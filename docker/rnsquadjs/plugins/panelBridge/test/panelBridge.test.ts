import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelBridgeContext } from '../src/index.js';

const started = vi.hoisted(() => ({ contexts: [] as PanelBridgeContext[] }));

vi.mock('../src/index', () => ({
  startPanelBridge: vi.fn(async (ctx: PanelBridgeContext) => {
    started.contexts.push(ctx);
    return { stop: async () => undefined };
  }),
}));

const { panelBridge } = await import('../src/panelBridge.js');

const STEAM_ID = '76561198000000001';
const EOS_ID = '0002a10186d9414496bf20d22d3860ba';

describe('panelBridge player lookup (#33)', () => {
  afterEach(() => {
    started.contexts.length = 0;
  });

  it('resolves players from the live state.players array, including arrays swapped in later', () => {
    const state = {
      id: 'lookup-server-1',
      listener: new EventEmitter(),
      execute: vi.fn(async () => ''),
      logger: { log: vi.fn() },
      players: undefined as
        | Array<{ name: string; eosID: string; steamID: string; teamID: string }>
        | undefined,
    };

    panelBridge(state, {});
    const findPlayer = started.contexts[0]?.findPlayer;
    expect(findPlayer).toBeTypeOf('function');
    expect(findPlayer?.(EOS_ID)).toBeUndefined();

    // RNSquadJS replaces state.players wholesale on every ListPlayers poll.
    state.players = [
      { name: 'Sergei', eosID: EOS_ID.toUpperCase(), steamID: STEAM_ID, teamID: '1' },
    ];
    expect(findPlayer?.(EOS_ID)).toEqual({ steamID: STEAM_ID, name: 'Sergei' });
    expect(findPlayer?.('0002ffffffffffffffffffffffffffff')).toBeUndefined();
  });
});
