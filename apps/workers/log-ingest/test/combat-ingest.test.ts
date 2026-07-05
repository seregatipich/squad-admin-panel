import { describe, expect, it } from 'vitest';
import type { CombatRecordCommand } from '../src/parser/combat.js';
import { LogIngestor } from '../src/parser/ingest.js';

const SERVER_ID = '00000000-0000-7000-8000-000000000abc';
const ALICE_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const ALICE_STEAM = '76561198000000001';

function ingestorWithCombat() {
  const commands: CombatRecordCommand[] = [];
  const ingestor = new LogIngestor({
    serverId: SERVER_ID,
    beaconPort: 15000,
    onCombat: (command) => commands.push(command),
  });
  return { ingestor, commands };
}

describe('LogIngestor combat wiring', () => {
  it('dispatches a death line to onCombat with the server id attached', () => {
    const { ingestor, commands } = ingestorWithCombat();
    ingestor.ingest(
      `[2026.07.05-12.00.02:000][102]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_AK74_C`,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].serverId).toBe(SERVER_ID);
    expect(commands[0].kind).toBe('combat_death');
    expect(commands[0].attacker?.eosId).toBe(ALICE_EOS);
  });

  it('dispatches a revive line to onCombat', () => {
    const { ingestor, commands } = ingestorWithCombat();
    ingestor.ingest(
      `[2026.07.05-12.00.03:000][103]LogSquad: MedicCarol (Online IDs: EOS: 0002cccc0002cccc0002cccc0002cccc steam: 76561198000000003) has revived RevivedDave (Online IDs: EOS: 0002dddd0002dddd0002dddd0002dddd steam: 76561198000000004).`,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].kind).toBe('combat_revive');
  });

  it('leaves onCombat untouched for non-combat lines', () => {
    const { ingestor, commands } = ingestorWithCombat();
    ingestor.ingest('[2026.07.05-12.14.00:000][304]LogNet: Join succeeded: SomePlayer');
    expect(commands).toHaveLength(0);
  });

  it('does not throw when no onCombat handler is registered', () => {
    const ingestor = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    expect(() =>
      ingestor.ingest(
        `[2026.07.05-12.00.02:000][102]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS}) caused by BP_AK74_C`,
      ),
    ).not.toThrow();
  });
});
