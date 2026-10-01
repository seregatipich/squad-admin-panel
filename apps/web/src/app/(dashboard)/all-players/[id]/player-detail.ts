import type { RoleColor } from '@squad/shared-config/role-colors';
import type { PlayerClan } from './ClanWidget';
import type { SteamSnapshot } from './SteamProfileSection';

export interface Player extends SteamSnapshot {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

export interface NameHistory {
  name: string;
  name_normalized: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

export interface IpHistory {
  ip: string;
  country_code: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  timezone_offset: string | null;
  latitude: number | null;
  longitude: number | null;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

export interface CountryLocation {
  country_code: string;
  country_name: string | null;
  last_seen_at: string;
}

export interface PlayerResponse {
  player: Player;
  clan: PlayerClan | null;
  names: NameHistory[];
  ips: IpHistory[];
  locations: CountryLocation[];
  ips_visible: boolean;
  geo_configured: boolean;
}

export interface SingleRole {
  id: string;
  name: string;
  color: RoleColor;
  is_system_role: boolean;
  role_expires_at: string | null;
  role_comment: string | null;
}

export interface Me {
  player_id: string;
  permissions: string[];
  squad_permissions?: string[];
  can_manage_economy?: boolean;
}
