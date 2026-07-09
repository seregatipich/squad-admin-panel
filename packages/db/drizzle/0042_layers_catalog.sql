-- ROT-1 (#144): layer catalog for the rotation editor (ROT-2), current/next-map
-- widget (ROT-3), and rotation calendar (ROT-4). `name` is the exact RCON
-- layer identifier (AdminChangeLayer / AdminSetNextLayer); there is no
-- separate slug. Seeded below from a static fallback dataset for the current
-- Squad version (depot_version) so GET /api/v1/layers works without a live
-- depot sync — see ai_docs/adr/2026-07-09-map-rotation-managed-vs-native.md
-- for the depot-sync upsert/deprecate follow-up.
CREATE TABLE IF NOT EXISTS layers (
  id            uuid PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  map           text NOT NULL,
  gamemode      text NOT NULL,
  version       text NOT NULL,
  is_seed       boolean NOT NULL DEFAULT false,
  teams         jsonb NOT NULL DEFAULT '{}'::jsonb,
  depot_version text,
  deprecated    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO layers (id, name, map, gamemode, version, is_seed, teams, depot_version) VALUES
  ('019f46a1-4333-72e9-ba7a-f6bf02a339e1', 'Sumari Bala AAS v1', 'Sumari Bala', 'AAS', 'v1', false, '{"team1":{"faction":"RGF"},"team2":{"faction":"MEA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4341-7112-935f-520c0ea4458f', 'Fool''s Road AAS v1', 'Fool''s Road', 'AAS', 'v1', false, '{"team1":{"faction":"USA"},"team2":{"faction":"RGF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4341-7112-935f-54e66547a166', 'Gorodok RAAS v1', 'Gorodok', 'RAAS', 'v1', false, '{"team1":{"faction":"RGF"},"team2":{"faction":"USA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f2-fa7e6814c808', 'Yehorivka RAAS v11', 'Yehorivka', 'RAAS', 'v11', false, '{"team1":{"faction":"RGF"},"team2":{"faction":"USA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f2-fc5f4fd3b00c', 'Al Basrah Invasion v3', 'Al Basrah', 'Invasion', 'v3', false, '{"team1":{"faction":"MEA"},"team2":{"faction":"INS"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-029a451474b5', 'Belaya Pass RAAS v1', 'Belaya Pass', 'RAAS', 'v1', false, '{"team1":{"faction":"RGF"},"team2":{"faction":"BAF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-046582b42ae7', 'Mestia RAAS v1', 'Mestia', 'RAAS', 'v1', false, '{"team1":{"faction":"TLF"},"team2":{"faction":"ADF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-09d1639119f3', 'Narva Skirmish v1', 'Narva', 'Skirmish', 'v1', false, '{"team1":{"faction":"BAF"},"team2":{"faction":"RGF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-0f748b5536be', 'Tallil Outskirts Destruction v1', 'Tallil Outskirts', 'Destruction', 'v1', false, '{"team1":{"faction":"USA"},"team2":{"faction":"MEA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-12fa1a80cb31', 'Mutaha TC v1', 'Mutaha', 'TC', 'v1', false, '{"team1":{"faction":"USMC"},"team2":{"faction":"INS"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-1494d82f61f2', 'Kohat Toi RAAS v2', 'Kohat Toi', 'RAAS', 'v2', false, '{"team1":{"faction":"USA"},"team2":{"faction":"IMF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-190c0490740e', 'Black Coast RAAS v2', 'Black Coast', 'RAAS', 'v2', false, '{"team1":{"faction":"PLA"},"team2":{"faction":"ADF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-1de5f7e7a0d2', 'Harju Skirmish v1', 'Harju', 'Skirmish', 'v1', false, '{"team1":{"faction":"USA"},"team2":{"faction":"RGF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-22b07c8bb4cc', 'Chora RAAS v1', 'Chora', 'RAAS', 'v1', false, '{"team1":{"faction":"CAF"},"team2":{"faction":"INS"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-2490d7c43d37', 'Anvil RAAS v1', 'Anvil', 'RAAS', 'v1', false, '{"team1":{"faction":"WPMC"},"team2":{"faction":"VDV"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-295a40c6efe2', 'Manicouagan RAAS v1', 'Manicouagan', 'RAAS', 'v1', false, '{"team1":{"faction":"CAF"},"team2":{"faction":"RGF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-2da6daa84561', 'Lashkar Valley Insurgency v1', 'Lashkar Valley', 'Insurgency', 'v1', false, '{"team1":{"faction":"USA"},"team2":{"faction":"INS"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-31bfe9f90b67', 'Kamdesh Highlands RAAS v1', 'Kamdesh Highlands', 'RAAS', 'v1', false, '{"team1":{"faction":"USA"},"team2":{"faction":"IMF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-34f6cf2b7401', 'Sumari Seed v1', 'Sumari Bala', 'Seed', 'v1', true, '{"team1":{"faction":"RGF"},"team2":{"faction":"MEA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-3badc46bb03c', 'Narva Seed v1', 'Narva', 'Seed', 'v1', true, '{"team1":{"faction":"BAF"},"team2":{"faction":"RGF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-3ed945506ee0', 'Belaya Seed v1', 'Belaya Pass', 'Seed', 'v1', true, '{"team1":{"faction":"RGF"},"team2":{"faction":"BAF"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-40cb40d7fae6', 'Gorodok Seed v1', 'Gorodok', 'Seed', 'v1', true, '{"team1":{"faction":"RGF"},"team2":{"faction":"USA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-46cadff1169c', 'Yehorivka Seed v1', 'Yehorivka', 'Seed', 'v1', true, '{"team1":{"faction":"RGF"},"team2":{"faction":"USA"}}'::jsonb, 'v7.5'),
  ('019f46a1-4342-729b-95f3-493b060be389', 'Mutaha Seed v1', 'Mutaha', 'Seed', 'v1', true, '{"team1":{"faction":"USMC"},"team2":{"faction":"INS"}}'::jsonb, 'v7.5')
ON CONFLICT (name) DO NOTHING;
