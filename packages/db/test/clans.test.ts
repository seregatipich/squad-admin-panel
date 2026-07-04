import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSTRAINTS_SQL = readFileSync(
  path.resolve(__dirname, '../sql/clans-constraints.sql'),
  'utf-8',
);

const PLAYER_IDS = Array.from({ length: 8 }, (_, i) => {
  const n = (i + 1).toString(16).padStart(2, '0');
  return `000000${n}-0000-4000-8000-000000000000`;
});

let sql: ReturnType<typeof postgres>;

async function newClan(overrides: {
  name?: string;
  tags?: string[];
  maxPrioritySlots?: number;
}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO clans (id, name, tags, max_priority_slots)
    VALUES (
      ${id},
      ${overrides.name ?? `clan-${id.slice(0, 8)}`},
      ${overrides.tags ?? []},
      ${overrides.maxPrioritySlots ?? 10}
    )
  `;
  return id;
}

async function addMember(
  clanId: string,
  playerId: string,
  role: 'leader' | 'deputy' | 'member',
  hasPriority = false,
): Promise<void> {
  await sql`
    INSERT INTO clan_members (clan_id, player_id, member_role, has_priority)
    VALUES (${clanId}, ${playerId}, ${role}, ${hasPriority})
  `;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(CONSTRAINTS_SQL);
  for (const id of PLAYER_IDS) {
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized)
      VALUES (${id}, ${`P-${id.slice(0, 8)}`}, ${`p-${id.slice(0, 8)}`})
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

afterAll(async () => {
  if (!sql) return;
  await sql`TRUNCATE clan_members, clans CASCADE`;
  await sql`DELETE FROM players WHERE id = ANY(${PLAYER_IDS})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE clan_members, clans CASCADE`;
});

describeIfDb('clan model constraints', () => {
  it('rejects adding a player to a second clan (one clan per player)', async () => {
    const clanA = await newClan({ name: 'Alpha' });
    const clanB = await newClan({ name: 'Bravo' });
    await addMember(clanA, PLAYER_IDS[0], 'leader');
    await expect(addMember(clanB, PLAYER_IDS[0], 'leader')).rejects.toThrow(
      /clan_members_player_unique_idx/,
    );
  });

  it('rejects a tag already owned by another active clan', async () => {
    await newClan({ name: 'Alpha', tags: ['ALPHA', 'A'] });
    await expect(newClan({ name: 'Bravo', tags: ['ALPHA'] })).rejects.toThrow(
      /tag "ALPHA" already belongs to another clan/,
    );
  });

  it('rejects taking a taken tag via update', async () => {
    await newClan({ name: 'Alpha', tags: ['ALPHA'] });
    const clanB = await newClan({ name: 'Bravo', tags: ['BRAVO'] });
    await expect(sql`UPDATE clans SET tags = ${['ALPHA']} WHERE id = ${clanB}`).rejects.toThrow(
      /tag "ALPHA" already belongs to another clan/,
    );
  });

  it('frees a tag once the owning clan is soft-deleted', async () => {
    const clanA = await newClan({ name: 'Alpha', tags: ['ALPHA'] });
    await sql`UPDATE clans SET deleted_at = now() WHERE id = ${clanA}`;
    await expect(newClan({ name: 'Bravo', tags: ['ALPHA'] })).resolves.toBeTypeOf('string');
  });

  it('allows the same tag set on the same clan (self-update is not a conflict)', async () => {
    const clanA = await newClan({ name: 'Alpha', tags: ['ALPHA'] });
    await expect(
      sql`UPDATE clans SET description = 'x', tags = ${['ALPHA']} WHERE id = ${clanA}`,
    ).resolves.toBeDefined();
  });

  it('rejects adding a priority member beyond max_priority_slots', async () => {
    const clan = await newClan({ name: 'Alpha', maxPrioritySlots: 2 });
    await addMember(clan, PLAYER_IDS[0], 'leader', true);
    await addMember(clan, PLAYER_IDS[1], 'member', true);
    await expect(addMember(clan, PLAYER_IDS[2], 'member', true)).rejects.toThrow(
      /priority slots exhausted: 3 assigned exceeds limit of 2/,
    );
  });

  it('allows priority members up to max_priority_slots', async () => {
    const clan = await newClan({ name: 'Alpha', maxPrioritySlots: 3 });
    await addMember(clan, PLAYER_IDS[0], 'leader', true);
    await addMember(clan, PLAYER_IDS[1], 'member', true);
    await expect(addMember(clan, PLAYER_IDS[2], 'member', true)).resolves.toBeUndefined();
  });

  it('rejects lowering max_priority_slots below the current priority count', async () => {
    const clan = await newClan({ name: 'Alpha', maxPrioritySlots: 10 });
    await addMember(clan, PLAYER_IDS[0], 'leader', true);
    await addMember(clan, PLAYER_IDS[1], 'member', true);
    await addMember(clan, PLAYER_IDS[2], 'member', true);
    await expect(sql`UPDATE clans SET max_priority_slots = 2 WHERE id = ${clan}`).rejects.toThrow(
      /cannot lower max_priority_slots to 2 .* 3 priority members are already assigned/,
    );
  });

  it('allows lowering max_priority_slots down to the current priority count', async () => {
    const clan = await newClan({ name: 'Alpha', maxPrioritySlots: 10 });
    await addMember(clan, PLAYER_IDS[0], 'leader', true);
    await addMember(clan, PLAYER_IDS[1], 'member', true);
    await expect(
      sql`UPDATE clans SET max_priority_slots = 2 WHERE id = ${clan}`,
    ).resolves.toBeDefined();
  });

  it('rejects a second leader in the same clan', async () => {
    const clan = await newClan({ name: 'Alpha' });
    await addMember(clan, PLAYER_IDS[0], 'leader');
    await expect(addMember(clan, PLAYER_IDS[1], 'leader')).rejects.toThrow(
      /must have exactly one leader, found 2/,
    );
  });

  it('rejects a clan that has members but no leader', async () => {
    const clan = await newClan({ name: 'Alpha' });
    await expect(addMember(clan, PLAYER_IDS[0], 'member')).rejects.toThrow(
      /must have exactly one leader, found 0/,
    );
  });

  it('allows leadership transfer within a single transaction (deferred check)', async () => {
    const clan = await newClan({ name: 'Alpha' });
    await addMember(clan, PLAYER_IDS[0], 'leader');
    await addMember(clan, PLAYER_IDS[1], 'member');
    await sql.begin(async (tx) => {
      await tx`UPDATE clan_members SET member_role = 'deputy' WHERE clan_id = ${clan} AND player_id = ${PLAYER_IDS[0]}`;
      await tx`UPDATE clan_members SET member_role = 'leader' WHERE clan_id = ${clan} AND player_id = ${PLAYER_IDS[1]}`;
    });
    const leaders = await sql`
      SELECT player_id FROM clan_members WHERE clan_id = ${clan} AND member_role = 'leader'
    `;
    expect(leaders.length).toBe(1);
    expect(leaders[0].player_id).toBe(PLAYER_IDS[1]);
  });

  it('enforces a unique clan name among active clans and frees it after soft-delete', async () => {
    const clanA = await newClan({ name: 'Duplicate' });
    await expect(newClan({ name: 'Duplicate' })).rejects.toThrow(/clans_name_active_key/);
    await sql`UPDATE clans SET deleted_at = now() WHERE id = ${clanA}`;
    await expect(newClan({ name: 'Duplicate' })).resolves.toBeTypeOf('string');
  });

  it('rejects a clan name longer than 32 characters', async () => {
    await expect(newClan({ name: 'x'.repeat(33) })).rejects.toThrow(/clans_name_length/);
  });

  it('cascades member deletion when a clan is hard-deleted', async () => {
    const clan = await newClan({ name: 'Alpha' });
    await addMember(clan, PLAYER_IDS[0], 'leader');
    await sql`DELETE FROM clans WHERE id = ${clan}`;
    const rows = await sql`SELECT 1 FROM clan_members WHERE player_id = ${PLAYER_IDS[0]}`;
    expect(rows.length).toBe(0);
  });

  it('is idempotent: re-applying the constraint DDL does not error', async () => {
    await expect(sql.unsafe(CONSTRAINTS_SQL)).resolves.toBeDefined();
  });
});
