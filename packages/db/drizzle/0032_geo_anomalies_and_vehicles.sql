-- INT-2 (#77): geo-anomaly thresholds on geoip_settings
ALTER TABLE geoip_settings ADD COLUMN IF NOT EXISTS country_switch_window_hours integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE geoip_settings ADD COLUMN IF NOT EXISTS multi_country_threshold integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
-- DOSSIER-1 (#188): vehicle events in combat_events + localization catalog
ALTER TABLE combat_events ALTER COLUMN victim_player_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE combat_events DROP CONSTRAINT IF EXISTS combat_events_event_type_chk;
--> statement-breakpoint
ALTER TABLE combat_events ADD CONSTRAINT combat_events_event_type_chk CHECK (event_type IN ('death','damage','wound','revive','vehicle_destroyed'));
--> statement-breakpoint
ALTER TABLE combat_events ADD COLUMN IF NOT EXISTS victim_vehicle text;
--> statement-breakpoint
ALTER TABLE combat_events ADD COLUMN IF NOT EXISTS attacker_vehicle text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vehicle_catalog (
  asset_id      text PRIMARY KEY,
  name_en       text NOT NULL,
  name_ru       text NOT NULL,
  vehicle_class text NOT NULL,
  icon          text
);
--> statement-breakpoint
INSERT INTO vehicle_catalog (asset_id, name_en, name_ru, vehicle_class) VALUES
  ('BTR82A', 'BTR-82A', 'БТР-82А', 'IFV'),
  ('BTR80', 'BTR-80', 'БТР-80', 'APC'),
  ('MTLB_VMK', 'MT-LB VMK', 'МТ-ЛБ ВМК', 'APC'),
  ('Tigr_RWS', 'GAZ Tigr (RWS)', 'ГАЗ Тигр (БМДУ)', 'Recon'),
  ('T72B3', 'T-72B3', 'Т-72Б3', 'MBT'),
  ('T62', 'T-62', 'Т-62', 'MBT'),
  ('BMP1', 'BMP-1', 'БМП-1', 'IFV'),
  ('BMP2', 'BMP-2', 'БМП-2', 'IFV'),
  ('M1A2', 'M1A2 Abrams', 'M1A2 «Абрамс»', 'MBT'),
  ('M2A3', 'M2A3 Bradley', 'M2A3 «Брэдли»', 'IFV'),
  ('LAV25', 'LAV-25', 'LAV-25', 'IFV'),
  ('M1126_CROWS_M2', 'M1126 Stryker (CROWS)', 'M1126 «Страйкер» (CROWS)', 'APC'),
  ('MRAP_M2', 'M-ATV (M2)', 'M-ATV (M2)', 'Recon'),
  ('FV4034', 'FV4034 Challenger 2', 'FV4034 «Челленджер 2»', 'MBT'),
  ('FV510', 'FV510 Warrior', 'FV510 «Уорриор»', 'IFV'),
  ('FV107', 'FV107 Scimitar', 'FV107 «Симитэр»', 'Recon'),
  ('Coyote', 'Coyote', '«Койот»', 'Recon'),
  ('Ural375', 'Ural-375D', 'Урал-375Д', 'Logi'),
  ('Logi_Truck', 'Logistics Truck', 'Грузовик снабжения', 'Logi'),
  ('Technical_DShK', 'Technical (DShK)', 'Технический (ДШК)', 'Transport'),
  ('MI8', 'Mi-8', 'Ми-8', 'Heli'),
  ('UH60', 'UH-60 Black Hawk', 'UH-60 «Блэк Хок»', 'Heli'),
  ('RHIB', 'RHIB', 'РИБ (лодка)', 'Boat')
ON CONFLICT (asset_id) DO NOTHING;
