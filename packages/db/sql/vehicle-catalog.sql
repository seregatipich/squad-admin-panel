-- vehicle_catalog (DOSSIER-1): localization catalog for Squad vehicle asset-IDs.
--
-- combat_events.victim_vehicle / attacker_vehicle store the raw asset-ID as it
-- appears in SquadGame.log. This table maps that ID to EN/RU display names and a
-- vehicle class. There is deliberately NO foreign key from combat_events to this
-- table: an unknown asset-ID must never block writing the combat event (the UI
-- falls back to the raw ID with a "нет локализации" note). Admins fill gaps via
-- the GET/PUT /api/v1/vehicle-catalog CRUD. Idempotent for re-application.

CREATE TABLE IF NOT EXISTS vehicle_catalog (
  asset_id      text PRIMARY KEY,
  name_en       text NOT NULL,
  name_ru       text NOT NULL,
  vehicle_class text NOT NULL,
  icon          text
);
