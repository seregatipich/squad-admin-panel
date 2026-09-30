import { describe, expect, it, vi } from 'vitest';
import { restartServerContainer } from '../src/deps.js';

function makeBridge(overrides: Record<string, unknown> = {}) {
  return {
    containerStop: vi.fn().mockResolvedValue(undefined),
    containerStart: vi.fn().mockResolvedValue(undefined),
    containerInspect: vi.fn().mockResolvedValue({ state: 'exited', running: false }),
    ...overrides,
  } as never as Parameters<typeof restartServerContainer>[0];
}

describe('restartServerContainer (#1002)', () => {
  it('stops then starts the container', async () => {
    const bridge = makeBridge();
    await restartServerContainer(bridge, 'srv');
    expect(bridge.containerStop).toHaveBeenCalledWith({ name: 'squad-srv', timeout_sec: 60 });
    expect(bridge.containerStart).toHaveBeenCalledWith({ name: 'squad-srv' });
  });

  it('fails without starting when the stop failed and the container is still running', async () => {
    const bridge = makeBridge({
      containerStop: vi.fn().mockRejectedValue(new Error('rpc timeout')),
      containerInspect: vi.fn().mockResolvedValue({ state: 'running', running: true }),
    });
    await expect(restartServerContainer(bridge, 'srv')).rejects.toThrow(/rpc timeout/);
    expect(bridge.containerStart).not.toHaveBeenCalled();
  });

  it('fails when the stop failed and the container state cannot be confirmed', async () => {
    const bridge = makeBridge({
      containerStop: vi.fn().mockRejectedValue(new Error('bridge down')),
      containerInspect: vi.fn().mockRejectedValue(new Error('bridge down')),
    });
    await expect(restartServerContainer(bridge, 'srv')).rejects.toThrow(/bridge down/);
    expect(bridge.containerStart).not.toHaveBeenCalled();
  });

  it('starts anyway when the stop failed because the container was already stopped', async () => {
    const bridge = makeBridge({
      containerStop: vi.fn().mockRejectedValue(new Error('already stopped')),
    });
    await restartServerContainer(bridge, 'srv');
    expect(bridge.containerStart).toHaveBeenCalledWith({ name: 'squad-srv' });
  });
});
