-- CLAN-2: add can_manage_clans role flag (Owner backfilled).

ALTER TABLE roles ADD COLUMN can_manage_clans boolean DEFAULT false NOT NULL;
UPDATE roles SET can_manage_clans = true WHERE name = 'Owner';
