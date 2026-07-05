/**
 * Squad combat event parsing (COMBAT-1).
 *
 * Extends the log-ingest parser with the four player-combat events Squad writes
 * to `SquadGame.log`: damage (`LogSquad ActualDamage`), wound
 * (`LogSquadTrace ASQSoldier::Wound`), death (`LogSquadTrace ASQSoldier::Die`)
 * and revive (`LogSquad … has revived …`). The wire grammar is pinned in
 * `ai_docs/research/combat-log-format.md`, cross-checked against the SquadJS
 * log-parser (`Team-Silver-Sphere/SquadJS`, `squad-server/log-parser/`) — the
 * single verified signature reference. Live tailing against a real host is
 * env-gated, so the regex constants below are the one place to adjust once
 * validated; everything downstream (store, teamkill index) is format
 * independent.
 *
 * The pure functions here are deterministic and unit-tested with synthetic
 * fixtures, including suicide (attacker == victim), environmental/no-attacker
 * damage and bot/nil actors.
 */
import type { LogLine } from './patterns.js';

export const COMBAT_DAMAGE_CATEGORY = 'LogSquad';
export const COMBAT_TRACE_CATEGORY = 'LogSquadTrace';

export type CombatKind = 'combat_damage' | 'combat_wound' | 'combat_death' | 'combat_revive';

export interface CombatIdentity {
  eosId: string | null;
  steamId64: string | null;
  name: string;
}

export interface ParsedCombat {
  kind: CombatKind;
  ts: string;
  tick: number;
  attacker: CombatIdentity | null;
  victim: CombatIdentity;
  weapon: string | null;
  damage: number | null;
  isSuicide: boolean;
  attackerVehicle: string | null;
}

export type VehicleEventKind = 'vehicle_destroyed' | 'vehicle_damage';

export interface ParsedVehicleEvent {
  kind: VehicleEventKind;
  ts: string;
  tick: number;
  attacker: CombatIdentity | null;
  victimVehicle: string;
  attackerVehicle: string | null;
  weapon: string | null;
  damage: number | null;
}

export interface ParsedPossess {
  identity: CombatIdentity;
  vehicle: string | null;
}

const COMBAT_IDS = /EOS:\s*(?<eos>[0-9a-f]{32})(?:\s+steam:\s*(?<steam>\d{17}))?/i;

const DAMAGE =
  /^Player:(?<victim>.+?) ActualDamage=(?<damage>[0-9.]+) from (?<attacker>.+?)(?: \(Online IDs:(?<ids>[^)]*)\))? caused by (?<weapon>[A-Za-z0-9_.-]+)_C/;

const WOUND =
  /^\[DedicatedServer\](?:ASQSoldier::)?Wound\(\): Player:(?<victim>.+?) KillingDamage=-?(?<damage>[0-9.]+) from (?<attacker>.+?)(?: \(Online IDs:(?<ids>[^)]*)\))? caused by (?<weapon>[A-Za-z0-9_.-]+)_C/;

const DEATH =
  /^\[DedicatedServer\](?:ASQSoldier::)?Die\(\): Player:(?<victim>.+?) KillingDamage=-?(?<damage>[0-9.]+) from (?<attacker>.+?)(?: \(Online IDs:(?<ids>[^)]*)\))? caused by (?<weapon>[A-Za-z0-9_.-]+)_C/;

const REVIVE =
  /^(?<medic>.+?) \(Online IDs:(?<medicIds>[^)]*)\) has revived (?<revived>.+?) \(Online IDs:(?<revivedIds>[^)]*)\)/;

const VEHICLE_DAMAGE =
  /^Vehicle:(?<victim>[A-Za-z0-9_.-]+?)(?:_C)?(?:_\d+)? ActualDamage=(?<damage>[0-9.]+) from (?<attacker>.+?)(?: \(Online IDs:(?<ids>[^)]*)\))? caused by (?<weapon>[A-Za-z0-9_.-]+)_C/;

const VEHICLE_DESTROY =
  /^\[DedicatedServer\](?:ASQVehicle::)?Die\(\): Vehicle:(?<victim>[A-Za-z0-9_.-]+?)(?:_C)?(?:_\d+)? KillingDamage=-?(?<damage>[0-9.]+) from (?<attacker>.+?)(?: \(Online IDs:(?<ids>[^)]*)\))? caused by (?<weapon>[A-Za-z0-9_.-]+)_C/;

const POSSESS =
  /^OnPossess\(\): PC=(?<name>.+?) \(Online IDs:(?<ids>[^)]*)\) Pawn=(?<pawn>[A-Za-z0-9_.-]+?)(?:_C)?(?:_\d+)?$/;

const UNPOSSESS = /^OnUnPossess\(\): PC=(?<name>.+?) \(Online IDs:(?<ids>[^)]*)\)/;

const SOLDIER_PAWN = /soldier/i;

const NON_HUMAN_ACTOR = new Set(['nullptr', 'null', 'none', '']);

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractIds(segment: string | undefined): {
  eosId: string | null;
  steamId64: string | null;
} {
  if (!segment) return { eosId: null, steamId64: null };
  const ids = COMBAT_IDS.exec(segment);
  if (!ids?.groups) return { eosId: null, steamId64: null };
  return {
    eosId: ids.groups.eos ? ids.groups.eos.toLowerCase() : null,
    steamId64: ids.groups.steam ?? null,
  };
}

function buildIdentity(name: string, idSegment: string | undefined): CombatIdentity {
  const { eosId, steamId64 } = extractIds(idSegment);
  return { eosId, steamId64, name: name.trim() };
}

function resolveAttacker(rawName: string, idSegment: string | undefined): CombatIdentity | null {
  const trimmed = rawName.trim();
  const lowered = trimmed.toLowerCase();
  const { eosId, steamId64 } = extractIds(idSegment);
  if (!eosId && !steamId64 && (NON_HUMAN_ACTOR.has(lowered) || lowered.startsWith('nullptr'))) {
    return null;
  }
  return { eosId, steamId64, name: trimmed };
}

function isSuicide(attacker: CombatIdentity | null, victim: CombatIdentity): boolean {
  if (!attacker) return false;
  if (attacker.eosId && victim.eosId) return attacker.eosId === victim.eosId;
  if (attacker.steamId64 && victim.steamId64) return attacker.steamId64 === victim.steamId64;
  return normalizeName(attacker.name) === normalizeName(victim.name);
}

function parseDamageLike(kind: CombatKind, regex: RegExp, parsed: LogLine): ParsedCombat | null {
  const match = regex.exec(parsed.message);
  if (!match?.groups) return null;
  const victim = buildIdentity(match.groups.victim ?? '', undefined);
  const attacker = resolveAttacker(match.groups.attacker ?? '', match.groups.ids);
  const damageValue = Number(match.groups.damage);
  return {
    kind,
    ts: parsed.ts.toISOString(),
    tick: parsed.tick,
    attacker,
    victim,
    weapon: match.groups.weapon ?? null,
    damage: Number.isFinite(damageValue) ? damageValue : null,
    isSuicide: isSuicide(attacker, victim),
    attackerVehicle: null,
  };
}

export function parseCombatDamage(parsed: LogLine): ParsedCombat | null {
  if (parsed.category !== COMBAT_DAMAGE_CATEGORY) return null;
  return parseDamageLike('combat_damage', DAMAGE, parsed);
}

export function parseCombatWound(parsed: LogLine): ParsedCombat | null {
  if (parsed.category !== COMBAT_TRACE_CATEGORY) return null;
  return parseDamageLike('combat_wound', WOUND, parsed);
}

export function parseCombatDeath(parsed: LogLine): ParsedCombat | null {
  if (parsed.category !== COMBAT_TRACE_CATEGORY) return null;
  return parseDamageLike('combat_death', DEATH, parsed);
}

export function parseCombatRevive(parsed: LogLine): ParsedCombat | null {
  if (parsed.category !== COMBAT_DAMAGE_CATEGORY) return null;
  const match = REVIVE.exec(parsed.message);
  if (!match?.groups) return null;
  const medic = buildIdentity(match.groups.medic ?? '', match.groups.medicIds);
  const revived = buildIdentity(match.groups.revived ?? '', match.groups.revivedIds);
  return {
    kind: 'combat_revive',
    ts: parsed.ts.toISOString(),
    tick: parsed.tick,
    attacker: medic,
    victim: revived,
    weapon: null,
    damage: null,
    isSuicide: false,
    attackerVehicle: null,
  };
}

export function parseCombat(parsed: LogLine): ParsedCombat | null {
  if (parsed.category === COMBAT_TRACE_CATEGORY) {
    return parseCombatWound(parsed) ?? parseCombatDeath(parsed);
  }
  if (parsed.category === COMBAT_DAMAGE_CATEGORY) {
    return parseCombatDamage(parsed) ?? parseCombatRevive(parsed);
  }
  return null;
}

function parseVehicleLike(
  kind: VehicleEventKind,
  regex: RegExp,
  parsed: LogLine,
): ParsedVehicleEvent | null {
  const match = regex.exec(parsed.message);
  if (!match?.groups) return null;
  const attacker = resolveAttacker(match.groups.attacker ?? '', match.groups.ids);
  const damageValue = Number(match.groups.damage);
  return {
    kind,
    ts: parsed.ts.toISOString(),
    tick: parsed.tick,
    attacker,
    victimVehicle: match.groups.victim ?? '',
    attackerVehicle: null,
    weapon: match.groups.weapon ?? null,
    damage: Number.isFinite(damageValue) ? damageValue : null,
  };
}

export function parseVehicleDamage(parsed: LogLine): ParsedVehicleEvent | null {
  if (parsed.category !== COMBAT_DAMAGE_CATEGORY) return null;
  return parseVehicleLike('vehicle_damage', VEHICLE_DAMAGE, parsed);
}

export function parseVehicleDestroy(parsed: LogLine): ParsedVehicleEvent | null {
  if (parsed.category !== COMBAT_TRACE_CATEGORY) return null;
  return parseVehicleLike('vehicle_destroyed', VEHICLE_DESTROY, parsed);
}

export function parseCombatVehicle(parsed: LogLine): ParsedVehicleEvent | null {
  if (parsed.category === COMBAT_TRACE_CATEGORY) return parseVehicleDestroy(parsed);
  if (parsed.category === COMBAT_DAMAGE_CATEGORY) return parseVehicleDamage(parsed);
  return null;
}

export function parsePossess(parsed: LogLine): ParsedPossess | null {
  if (parsed.category !== COMBAT_DAMAGE_CATEGORY) return null;
  const enter = POSSESS.exec(parsed.message);
  if (enter?.groups) {
    const pawn = enter.groups.pawn ?? '';
    const isSoldier = SOLDIER_PAWN.test(pawn);
    return {
      identity: buildIdentity(enter.groups.name ?? '', enter.groups.ids),
      vehicle: isSoldier || !pawn ? null : pawn,
    };
  }
  const leave = UNPOSSESS.exec(parsed.message);
  if (leave?.groups) {
    return { identity: buildIdentity(leave.groups.name ?? '', leave.groups.ids), vehicle: null };
  }
  return null;
}

export function identityKey(identity: CombatIdentity): string {
  if (identity.eosId) return `eos:${identity.eosId}`;
  if (identity.steamId64) return `steam:${identity.steamId64}`;
  return `name:${normalizeName(identity.name)}`;
}

export interface CombatRecordCommand extends ParsedCombat {
  serverId: string;
}

export interface VehicleRecordCommand extends ParsedVehicleEvent {
  serverId: string;
}

export interface RosterTeamMember {
  eos_id?: string | null;
  steam_id64?: string | null;
  name?: string | null;
  team_id?: number | null;
}

export interface TeamIndex {
  byEos: Map<string, number>;
  bySteam: Map<string, number>;
  byName: Map<string, number>;
}

export function buildTeamIndex(members: RosterTeamMember[]): TeamIndex {
  const index: TeamIndex = { byEos: new Map(), bySteam: new Map(), byName: new Map() };
  for (const member of members) {
    if (member.team_id === null || member.team_id === undefined) continue;
    if (member.eos_id) index.byEos.set(member.eos_id.toLowerCase(), member.team_id);
    if (member.steam_id64) index.bySteam.set(String(member.steam_id64), member.team_id);
    if (member.name) index.byName.set(normalizeName(member.name), member.team_id);
  }
  return index;
}

export function resolveTeam(identity: CombatIdentity | null, index: TeamIndex): number | null {
  if (!identity) return null;
  if (identity.eosId && index.byEos.has(identity.eosId)) {
    return index.byEos.get(identity.eosId) ?? null;
  }
  if (identity.steamId64 && index.bySteam.has(identity.steamId64)) {
    return index.bySteam.get(identity.steamId64) ?? null;
  }
  const normalized = normalizeName(identity.name);
  if (normalized && index.byName.has(normalized)) {
    return index.byName.get(normalized) ?? null;
  }
  return null;
}

export function detectTeamkill(command: ParsedCombat, index: TeamIndex): boolean {
  if (command.kind === 'combat_revive') return false;
  if (!command.attacker || command.isSuicide) return false;
  const attackerTeam = resolveTeam(command.attacker, index);
  const victimTeam = resolveTeam(command.victim, index);
  if (attackerTeam === null || victimTeam === null) return false;
  return attackerTeam === victimTeam;
}
