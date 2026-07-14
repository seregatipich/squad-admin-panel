import { describe, expect, it, vi } from 'vitest';
import {
  type RotationProfileEntry,
  type RotationProfileTickDeps,
  runRotationProfileTick,
} from '../src/rotation-profile-tick.js';

const SERVER_ID = '019f7800-0000-7000-8000-000000000002';

function makeProfile(overrides: Partial<RotationProfileEntry> = {}): RotationProfileEntry {
  return {
    id: '019f7800-0000-7000-8000-000000000001',
    serverId: SERVER_ID,
    serverTimezone: 'UTC',
    name: 'Понедельник',
    weekday: 1,
    layers: ['Yehorivka RAAS v11', 'Gorodok RAAS v1'],
    lastAppliedAt: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RotationProfileTickDeps> = {}): RotationProfileTickDeps {
  return {
    now: new Date('2026-07-13T05:00:00.000Z'),
    loadProfiles: vi.fn().mockResolvedValue([]),
    bridge: {
      fileRead: vi.fn().mockResolvedValue({ content: 'ManualLine\r\n' }),
      fileAtomicWrite: vi.fn().mockResolvedValue({ status: 'written' }),
    },
    setLastAppliedAt: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('runRotationProfileTick', () => {
  it('applies the weekday profile at 04:00 without changing content outside the segment', async () => {
    const profile = makeProfile();
    const deps = makeDeps({ loadProfiles: vi.fn().mockResolvedValue([profile]) });

    await expect(runRotationProfileTick(deps)).resolves.toEqual({ applied: 1, skipped: 0 });
    expect(deps.bridge.fileAtomicWrite).toHaveBeenCalledWith({
      path: `/var/lib/squad-panel/configs/${SERVER_ID}/ServerConfig/LayerRotation.cfg`,
      content:
        '//SQUAD-PANEL BEGIN — не редактировать вручную\r\n' +
        'Yehorivka RAAS v11\r\nGorodok RAAS v1\r\n//SQUAD-PANEL END\r\n\r\nManualLine\r\n',
    });
    expect(deps.setLastAppliedAt).toHaveBeenCalledWith(profile.id, deps.now);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'rotation.profile_applied' }),
    );
  });

  it('falls back to the default profile when the weekday override is absent', async () => {
    const profile = makeProfile({ weekday: null, name: 'По умолчанию' });
    const deps = makeDeps({ loadProfiles: vi.fn().mockResolvedValue([profile]) });

    await runRotationProfileTick(deps);

    expect(deps.bridge.fileAtomicWrite).toHaveBeenCalledOnce();
  });

  it('does not apply before the configured 04:00 local time or twice on one day', async () => {
    const profile = makeProfile({ lastAppliedAt: new Date('2026-07-13T04:30:00.000Z') });
    const before = makeDeps({
      now: new Date('2026-07-13T03:59:00.000Z'),
      loadProfiles: vi.fn().mockResolvedValue([makeProfile()]),
    });
    const after = makeDeps({ loadProfiles: vi.fn().mockResolvedValue([profile]) });

    await expect(runRotationProfileTick(before)).resolves.toEqual({ applied: 0, skipped: 0 });
    await expect(runRotationProfileTick(after)).resolves.toEqual({ applied: 0, skipped: 0 });
  });

  it('honors a configured local apply hour', async () => {
    const deps = makeDeps({
      now: new Date('2026-07-13T05:00:00.000Z'),
      applyHour: 6,
      loadProfiles: vi.fn().mockResolvedValue([makeProfile()]),
    });

    await expect(runRotationProfileTick(deps)).resolves.toEqual({ applied: 0, skipped: 0 });
    expect(deps.bridge.fileAtomicWrite).not.toHaveBeenCalled();
  });
});
