import type { BridgeClient } from '@squad/bridge-client';
import type { Diag } from '@squad/diag';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';

const PROFILE_APPLY_HOUR = 4;

/** A profile row joined with the server timezone for local-time scheduling. */
export interface RotationProfileEntry {
  id: string;
  serverId: string;
  serverTimezone: string;
  name: string;
  weekday: number | null;
  layers: string[];
  lastAppliedAt: Date | null;
}

export interface RotationProfileAuditEntry {
  actor: { kind: 'system'; label: 'rotation-scheduler' };
  actionType: 'rotation.profile_applied';
  targetType: 'rotation_profile';
  targetId: string;
  context: Record<string, unknown>;
}

export interface RotationProfileTickDeps {
  now?: Date;
  /** Local server hour at which the selected profile may first be applied. */
  applyHour?: number;
  loadProfiles(): Promise<RotationProfileEntry[]>;
  bridge: Pick<BridgeClient, 'fileRead' | 'fileAtomicWrite'>;
  setLastAppliedAt(profileId: string, appliedAt: Date): Promise<void>;
  writeAuditEntry(entry: RotationProfileAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface RotationProfileTickResult {
  applied: number;
  skipped: number;
}

interface LocalClock {
  date: string;
  hour: number;
  weekday: number;
}

function localClock(now: Date, timezone: string): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(now);
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday') ?? '');
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour') ?? 0),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

function profilePath(serverId: string): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/LayerRotation.cfg`;
}

function buildManagedSegment(layers: readonly string[]): string {
  return ['//SQUAD-PANEL BEGIN — не редактировать вручную', ...layers, '//SQUAD-PANEL END'].join(
    '\r\n',
  );
}

function spliceManagedSegment(content: string, body: string): string {
  const begin = content.indexOf('//SQUAD-PANEL BEGIN');
  const endMarker = '//SQUAD-PANEL END';
  if (begin < 0) {
    if (content.length === 0) return `${body}\r\n`;
    return `${body}\r\n\r\n${content}`;
  }
  const end = content.indexOf(endMarker, begin);
  if (end < 0) return content;
  const after = end + endMarker.length;
  return `${content.slice(0, begin)}${body}${content.slice(after)}`;
}

function shouldApply(profile: RotationProfileEntry, clock: LocalClock, applyHour: number): boolean {
  if (clock.hour < applyHour) return false;
  if (!profile.lastAppliedAt) return true;
  return localClock(profile.lastAppliedAt, profile.serverTimezone).date !== clock.date;
}

function chooseProfile(
  profiles: RotationProfileEntry[],
  clock: LocalClock,
): RotationProfileEntry | null {
  return (
    profiles.find((profile) => profile.weekday === clock.weekday) ??
    profiles.find((profile) => profile.weekday === null) ??
    null
  );
}

/** Applies the selected weekday/default managed profile once per local server day. */
export async function runRotationProfileTick(
  deps: RotationProfileTickDeps,
): Promise<RotationProfileTickResult> {
  const now = deps.now ?? new Date();
  const applyHour = deps.applyHour ?? PROFILE_APPLY_HOUR;
  const byServer = new Map<string, RotationProfileEntry[]>();
  for (const profile of await deps.loadProfiles()) {
    const group = byServer.get(profile.serverId) ?? [];
    group.push(profile);
    byServer.set(profile.serverId, group);
  }
  let applied = 0;
  let skipped = 0;

  for (const profiles of byServer.values()) {
    const first = profiles[0];
    if (!first) continue;
    const clock = localClock(now, first.serverTimezone);
    const profile = chooseProfile(profiles, clock);
    if (!profile || !shouldApply(profile, clock, applyHour)) continue;
    const path = profilePath(profile.serverId);
    try {
      const current = await deps.bridge.fileRead({ path });
      const body = buildManagedSegment(profile.layers);
      const next = spliceManagedSegment(current.content, body);
      const wrote = next !== current.content;
      if (wrote) await deps.bridge.fileAtomicWrite({ path, content: next });
      await deps.setLastAppliedAt(profile.id, now);
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'rotation-scheduler' },
        actionType: 'rotation.profile_applied',
        targetType: 'rotation_profile',
        targetId: profile.id,
        context: {
          server_id: profile.serverId,
          profile_name: profile.name,
          weekday: clock.weekday,
          local_date: clock.date,
          wrote,
          layer_count: profile.layers.length,
        },
      });
      applied++;
    } catch (error) {
      skipped++;
      await deps.diag.emit({
        component: 'worker-scheduler',
        kind: 'rotation_profile.apply_failed',
        severity: 'error',
        message: `rotation profile ${profile.id} failed: ${String(error)}`,
        payload: { profile_id: profile.id, server_id: profile.serverId },
      });
    }
  }

  return { applied, skipped };
}
