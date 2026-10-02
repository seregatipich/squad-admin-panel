import { describe, expect, it } from 'vitest';
import { resolveServerId } from '../src/panelBridge';

const UUID = '0197aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('resolveServerId', () => {
  it('prefers SERVER_ID over upstream state.id, which is the numeric config key', () => {
    expect(resolveServerId({ id: 1 }, { SERVER_ID: UUID })).toBe(UUID);
    expect(resolveServerId({ id: 'other' }, { SERVER_ID: UUID })).toBe(UUID);
  });

  it('falls back to a string state.id when SERVER_ID is unset', () => {
    expect(resolveServerId({ id: UUID }, {})).toBe(UUID);
  });

  it('never turns the numeric upstream config key into the panel server id', () => {
    expect(() => resolveServerId({ id: 1 }, {})).toThrow(/cannot resolve serverId/);
    expect(() => resolveServerId({ id: undefined }, { SERVER_ID: '' })).toThrow(
      /cannot resolve serverId/,
    );
  });
});
