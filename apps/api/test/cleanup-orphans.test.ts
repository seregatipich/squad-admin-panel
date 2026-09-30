import { PANEL_CONFIGS_ROOT, PANEL_SAVED_ROOT } from '@squad/shared-config';
import { describe, expect, it, vi } from 'vitest';
import { type CleanupContext, cleanupOrphans } from '../src/lib/cleanup-orphans.js';

const KNOWN_UUID = 'aaaaaaaa-1111-1111-1111-111111111111';
const ORPHAN_UUID = 'bbbbbbbb-2222-2222-2222-222222222222';
const NOT_UUID = 'not-a-valid-uuid-string';

function makeDb(knownIds: string[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockResolvedValue(knownIds.map((id) => ({ id }))),
    })),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  };
}

function makeBridge(
  overrides: {
    configs?: string[];
    saved?: string[];
    containers?: string[];
    sidecarDirs?: string[];
    sidecarContainers?: string[];
    directoryDeleteResult?: { removed: boolean };
    directoryDeleteError?: Error;
    containerRmError?: Error;
  } = {},
) {
  return {
    listPanelDirs: vi.fn().mockResolvedValue({
      configs: overrides.configs ?? [],
      saved: overrides.saved ?? [],
      sidecars: overrides.sidecarDirs ?? [],
    }),
    listSquadContainers: vi.fn().mockResolvedValue({
      containers: (overrides.containers ?? []).map((id) => `squad-${id}`),
      sidecars: (overrides.sidecarContainers ?? []).map((id) => `rnsquadjs-${id}`),
    }),
    directoryDelete: vi.fn(async () => {
      if (overrides.directoryDeleteError) throw overrides.directoryDeleteError;
      return overrides.directoryDeleteResult ?? { removed: true };
    }),
    containerStop: vi.fn().mockResolvedValue({ exit_code: 0 }),
    containerRm: vi.fn(async () => {
      if (overrides.containerRmError) throw overrides.containerRmError;
      return { removed: true };
    }),
  };
}

function makeCtx(
  db: ReturnType<typeof makeDb>,
  bridge: ReturnType<typeof makeBridge>,
  extra: Partial<CleanupContext> = {},
): CleanupContext {
  return {
    db: db as unknown as CleanupContext['db'],
    bridge: bridge as unknown as CleanupContext['bridge'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    actorPlayerId: null,
    actorIp: null,
    ...extra,
  };
}

describe('cleanupOrphans — dryRun=true', () => {
  it('identifies orphan configs, saved, and containers without removing anything', async () => {
    const db = makeDb([KNOWN_UUID]);
    const bridge = makeBridge({
      configs: [KNOWN_UUID, ORPHAN_UUID],
      saved: [ORPHAN_UUID],
      containers: [ORPHAN_UUID],
    });
    const ctx = makeCtx(db, bridge, { dryRun: true });

    const result = await cleanupOrphans(ctx);

    expect(result.orphans_configs).toEqual([ORPHAN_UUID]);
    expect(result.orphans_saved).toEqual([ORPHAN_UUID]);
    expect(result.orphans_containers).toEqual([ORPHAN_UUID]);
    expect(result.removed_configs).toEqual([]);
    expect(result.removed_saved).toEqual([]);
    expect(result.removed_containers).toEqual([]);
    expect(bridge.directoryDelete).not.toHaveBeenCalled();
    expect(bridge.containerRm).not.toHaveBeenCalled();
  });

  it('skips non-UUID directory names', async () => {
    const db = makeDb([]);
    const bridge = makeBridge({ configs: [NOT_UUID, ORPHAN_UUID], saved: [NOT_UUID] });
    const ctx = makeCtx(db, bridge, { dryRun: true });

    const result = await cleanupOrphans(ctx);

    expect(result.orphans_configs).toEqual([ORPHAN_UUID]);
    expect(result.orphans_saved).toEqual([]);
  });
});

describe('cleanupOrphans — dryRun=false', () => {
  it('calls directoryDelete for orphan configs and saved dirs', async () => {
    const db = makeDb([KNOWN_UUID]);
    const bridge = makeBridge({
      configs: [KNOWN_UUID, ORPHAN_UUID],
      saved: [ORPHAN_UUID],
    });
    const ctx = makeCtx(db, bridge);

    const result = await cleanupOrphans(ctx);

    expect(bridge.directoryDelete).toHaveBeenCalledWith({
      path: `${PANEL_CONFIGS_ROOT}/${ORPHAN_UUID}`,
    });
    expect(bridge.directoryDelete).toHaveBeenCalledWith({
      path: `${PANEL_SAVED_ROOT}/${ORPHAN_UUID}`,
    });
    expect(result.removed_configs).toEqual([ORPHAN_UUID]);
    expect(result.removed_saved).toEqual([ORPHAN_UUID]);
  });

  it('calls containerStop then containerRm for orphan containers', async () => {
    const db = makeDb([]);
    const bridge = makeBridge({ containers: [ORPHAN_UUID] });
    const ctx = makeCtx(db, bridge);

    const result = await cleanupOrphans(ctx);

    expect(bridge.containerStop).toHaveBeenCalledWith({
      name: `squad-${ORPHAN_UUID}`,
      timeout_sec: 10,
    });
    expect(bridge.containerRm).toHaveBeenCalledWith({ name: `squad-${ORPHAN_UUID}` });
    expect(result.removed_containers).toEqual([ORPHAN_UUID]);
  });

  it('treats "not found" containerRm errors as success', async () => {
    const db = makeDb([]);
    const bridge = makeBridge({
      containers: [ORPHAN_UUID],
      containerRmError: new Error('no such container'),
    });
    const ctx = makeCtx(db, bridge);

    const result = await cleanupOrphans(ctx);

    expect(result.removed_containers).toEqual([ORPHAN_UUID]);
    expect(result.errors).toEqual([]);
  });

  it('records errors when directoryDelete fails', async () => {
    const db = makeDb([]);
    const bridge = makeBridge({
      configs: [ORPHAN_UUID],
      directoryDeleteError: new Error('permission denied'),
    });
    const ctx = makeCtx(db, bridge);

    const result = await cleanupOrphans(ctx);

    expect(result.removed_configs).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      kind: 'configs',
      uuid: ORPHAN_UUID,
      error: 'permission denied',
    });
  });

  it('returns empty result when all dirs and containers are known', async () => {
    const db = makeDb([KNOWN_UUID]);
    const bridge = makeBridge({
      configs: [KNOWN_UUID],
      saved: [KNOWN_UUID],
      containers: [KNOWN_UUID],
    });
    const ctx = makeCtx(db, bridge);

    const result = await cleanupOrphans(ctx);

    expect(result.orphans_configs).toEqual([]);
    expect(result.orphans_saved).toEqual([]);
    expect(result.orphans_containers).toEqual([]);
    expect(result.removed_configs).toEqual([]);
    expect(bridge.directoryDelete).not.toHaveBeenCalled();
  });
});

describe('cleanupOrphans — RNSquadJS sidecars (#66)', () => {
  it('reports orphan sidecar containers and config dirs in a dry run', async () => {
    const db = makeDb([KNOWN_UUID]);
    const bridge = makeBridge({
      sidecarDirs: [KNOWN_UUID, ORPHAN_UUID, NOT_UUID],
      sidecarContainers: [KNOWN_UUID, ORPHAN_UUID],
    });

    const result = await cleanupOrphans(makeCtx(db, bridge, { dryRun: true }));

    expect(result.orphans_sidecar_dirs).toEqual([ORPHAN_UUID]);
    expect(result.orphans_sidecar_containers).toEqual([ORPHAN_UUID]);
    expect(bridge.containerRm).not.toHaveBeenCalled();
    expect(bridge.directoryDelete).not.toHaveBeenCalled();
  });

  it('stops and removes an orphan sidecar and deletes its RCON-password config dir', async () => {
    const db = makeDb([KNOWN_UUID]);
    const bridge = makeBridge({ sidecarDirs: [ORPHAN_UUID], sidecarContainers: [ORPHAN_UUID] });

    const result = await cleanupOrphans(makeCtx(db, bridge));

    expect(bridge.containerStop).toHaveBeenCalledWith({
      name: `rnsquadjs-${ORPHAN_UUID}`,
      timeout_sec: 10,
    });
    expect(bridge.containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${ORPHAN_UUID}` });
    expect(bridge.directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/rnsquadjs/${ORPHAN_UUID}`,
    });
    expect(result.removed_sidecar_containers).toEqual([ORPHAN_UUID]);
    expect(result.removed_sidecar_dirs).toEqual([ORPHAN_UUID]);
  });

  it('treats a bridge that predates sidecar listing as having no sidecars', async () => {
    const db = makeDb([]);
    const bridge = makeBridge();
    bridge.listPanelDirs.mockResolvedValue({ configs: [], saved: [] } as never);
    bridge.listSquadContainers.mockResolvedValue({ containers: [] } as never);

    const result = await cleanupOrphans(makeCtx(db, bridge));

    expect(result.orphans_sidecar_dirs).toEqual([]);
    expect(result.orphans_sidecar_containers).toEqual([]);
  });
});
