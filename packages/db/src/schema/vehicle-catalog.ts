import { pgTable, text } from 'drizzle-orm/pg-core';

export const VEHICLE_CLASSES = [
  'APC',
  'IFV',
  'MBT',
  'Recon',
  'Heli',
  'Logi',
  'Transport',
  'Boat',
  'Emplacement',
  'Other',
] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const vehicleCatalog = pgTable('vehicle_catalog', {
  assetId: text('asset_id').primaryKey(),
  nameEn: text('name_en').notNull(),
  nameRu: text('name_ru').notNull(),
  vehicleClass: text('vehicle_class').notNull(),
  icon: text('icon'),
});

export type VehicleCatalogRow = typeof vehicleCatalog.$inferSelect;
export type NewVehicleCatalog = typeof vehicleCatalog.$inferInsert;

export interface VehicleCatalogSeed {
  assetId: string;
  nameEn: string;
  nameRu: string;
  vehicleClass: VehicleClass;
}

export const VEHICLE_CATALOG_SEED: readonly VehicleCatalogSeed[] = [
  { assetId: 'BTR82A', nameEn: 'BTR-82A', nameRu: 'БТР-82А', vehicleClass: 'IFV' },
  { assetId: 'BTR80', nameEn: 'BTR-80', nameRu: 'БТР-80', vehicleClass: 'APC' },
  { assetId: 'MTLB_VMK', nameEn: 'MT-LB VMK', nameRu: 'МТ-ЛБ ВМК', vehicleClass: 'APC' },
  {
    assetId: 'Tigr_RWS',
    nameEn: 'GAZ Tigr (RWS)',
    nameRu: 'ГАЗ Тигр (БМДУ)',
    vehicleClass: 'Recon',
  },
  { assetId: 'T72B3', nameEn: 'T-72B3', nameRu: 'Т-72Б3', vehicleClass: 'MBT' },
  { assetId: 'T62', nameEn: 'T-62', nameRu: 'Т-62', vehicleClass: 'MBT' },
  { assetId: 'BMP1', nameEn: 'BMP-1', nameRu: 'БМП-1', vehicleClass: 'IFV' },
  { assetId: 'BMP2', nameEn: 'BMP-2', nameRu: 'БМП-2', vehicleClass: 'IFV' },
  { assetId: 'M1A2', nameEn: 'M1A2 Abrams', nameRu: 'M1A2 «Абрамс»', vehicleClass: 'MBT' },
  { assetId: 'M2A3', nameEn: 'M2A3 Bradley', nameRu: 'M2A3 «Брэдли»', vehicleClass: 'IFV' },
  { assetId: 'LAV25', nameEn: 'LAV-25', nameRu: 'LAV-25', vehicleClass: 'IFV' },
  {
    assetId: 'M1126_CROWS_M2',
    nameEn: 'M1126 Stryker (CROWS)',
    nameRu: 'M1126 «Страйкер» (CROWS)',
    vehicleClass: 'APC',
  },
  { assetId: 'MRAP_M2', nameEn: 'M-ATV (M2)', nameRu: 'M-ATV (M2)', vehicleClass: 'Recon' },
  {
    assetId: 'FV4034',
    nameEn: 'FV4034 Challenger 2',
    nameRu: 'FV4034 «Челленджер 2»',
    vehicleClass: 'MBT',
  },
  { assetId: 'FV510', nameEn: 'FV510 Warrior', nameRu: 'FV510 «Уорриор»', vehicleClass: 'IFV' },
  { assetId: 'FV107', nameEn: 'FV107 Scimitar', nameRu: 'FV107 «Симитэр»', vehicleClass: 'Recon' },
  { assetId: 'Coyote', nameEn: 'Coyote', nameRu: '«Койот»', vehicleClass: 'Recon' },
  { assetId: 'Ural375', nameEn: 'Ural-375D', nameRu: 'Урал-375Д', vehicleClass: 'Logi' },
  {
    assetId: 'Logi_Truck',
    nameEn: 'Logistics Truck',
    nameRu: 'Грузовик снабжения',
    vehicleClass: 'Logi',
  },
  {
    assetId: 'Technical_DShK',
    nameEn: 'Technical (DShK)',
    nameRu: 'Технический (ДШК)',
    vehicleClass: 'Transport',
  },
  { assetId: 'MI8', nameEn: 'Mi-8', nameRu: 'Ми-8', vehicleClass: 'Heli' },
  { assetId: 'UH60', nameEn: 'UH-60 Black Hawk', nameRu: 'UH-60 «Блэк Хок»', vehicleClass: 'Heli' },
  { assetId: 'RHIB', nameEn: 'RHIB', nameRu: 'РИБ (лодка)', vehicleClass: 'Boat' },
] as const;
