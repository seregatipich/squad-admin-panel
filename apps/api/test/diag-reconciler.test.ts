import { servers } from '@squad/db/schema';
import type { DiagEvent } from '@squad/diag';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const RUNNING_SLUG_BASE = 'diag-reconciler';

let h: IntegrationHarness;
let captured: DiagEvent[];
let counter = 0;

beforeEach(async () => {
  h = await buildIntegrationApp({
    bridge: makeFakeBridge(),
    withStatusReconciler: true,
  });
  captured = [];
  h.app.diag.emit = async (ev) => {
    captured.push(ev);
  };
  counter += 1;
});

afterEach(async () => {
  await h.cleanup();
});

async function seedRunningServer(): Promise<string> {
  const id = uuidv7();
  const slug = `${RUNNING_SLUG_BASE}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  await h.db.insert(servers).values({
    id,
    displayName: 'Diag Reconciler',
    slug,
    status: 'running',
  });
  return id;
}

describe('reconciler emits container.exited / container.unexpected_exit', () => {
  it('emits container.exited with exit_code/oom_killed/signal when the stop fence is set', async () => {
    const id = await seedRunningServer();
    await h.redis.set(`stop:requested:${id}`, '1', 'EX', 300);

    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '2026-04-28T10:00:00Z',
      finished_at: '2026-04-28T10:42:18Z',
      exit_code: 137,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
      oom_killed: true,
      error: 'signal: killed',
    });

    await h.app.statusReconciler.tickNow();

    const exited = captured.find((e) => e.kind === 'container.exited');
    expect(exited).toBeDefined();
    expect(exited?.component).toBe('reconciler');
    expect(exited?.severity).toBe('error');
    expect(exited?.serverId).toBe(id);
    expect(exited?.payload).toMatchObject({
      exit_code: 137,
      oom_killed: true,
      signal: 'signal: killed',
      finished_at: '2026-04-28T10:42:18Z',
      started_at: '2026-04-28T10:00:00Z',
    });

    const confirmed = captured.find((e) => e.kind === 'server.stop.reconciler_confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed?.component).toBe('reconciler');
    expect(confirmed?.severity).toBe('info');
    expect(confirmed?.serverId).toBe(id);
    expect(confirmed?.payload).toMatchObject({ exit_code: 137 });
  });

  it('emits container.unexpected_exit when no fence is set', async () => {
    const id = await seedRunningServer();
    await h.redis.del(`stop:requested:${id}`);

    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '2026-04-28T10:00:00Z',
      finished_at: '2026-04-28T10:42:18Z',
      exit_code: 137,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
      oom_killed: false,
      error: '',
    });

    await h.app.statusReconciler.tickNow();

    const unexpected = captured.find((e) => e.kind === 'container.unexpected_exit');
    expect(unexpected).toBeDefined();
    expect(unexpected?.component).toBe('reconciler');
    expect(unexpected?.severity).toBe('error');
    expect(unexpected?.serverId).toBe(id);
    expect(unexpected?.payload).toMatchObject({
      exit_code: 137,
      oom_killed: false,
      signal: null,
    });

    const confirmed = captured.find((e) => e.kind === 'server.stop.reconciler_confirmed');
    expect(confirmed).toBeUndefined();
  });

  it('emits container.exited with severity=info when exit_code is 0', async () => {
    const id = await seedRunningServer();
    await h.redis.set(`stop:requested:${id}`, '1', 'EX', 300);

    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '2026-04-28T10:00:00Z',
      finished_at: '2026-04-28T10:42:18Z',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
      oom_killed: false,
      error: '',
    });

    await h.app.statusReconciler.tickNow();

    const exited = captured.find((e) => e.kind === 'container.exited');
    expect(exited).toBeDefined();
    expect(exited?.severity).toBe('info');
    expect(exited?.payload).toMatchObject({ exit_code: 0, oom_killed: false, signal: null });
    expect(exited?.message).toBe('container exited (code=0)');

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });

  it('does not emit anything when the running→stopped transition does not happen', async () => {
    const id = await seedRunningServer();
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'running',
      running: true,
      pid: 12345,
      started_at: '2026-04-28T10:00:00Z',
      finished_at: '',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    expect(
      captured.find(
        (e) =>
          e.kind === 'container.exited' ||
          e.kind === 'container.unexpected_exit' ||
          e.kind === 'server.stop.reconciler_confirmed',
      ),
    ).toBeUndefined();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('running');
  });
});
