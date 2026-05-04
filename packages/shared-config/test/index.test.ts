import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';

describe('shared-config index re-exports', () => {
  it('re-exports the bridge-methods surface', () => {
    expect(Array.isArray(root.BRIDGE_METHODS)).toBe(true);
    expect(typeof root.configFileClass).toBe('function');
  });

  it('re-exports diag, heartbeat, metrics-pack helpers', () => {
    expect(root.DIAG_STREAM_KEY).toBe('diag:queue');
    expect(typeof root.startHeartbeat).toBe('function');
    expect(typeof root.packHostMetrics).toBe('function');
    expect(typeof root.unpackHostMetrics).toBe('function');
  });

  it('re-exports log-stream + sink helpers', () => {
    expect(typeof root.encodeLogEntry).toBe('function');
    expect(typeof root.decodeLogEntry).toBe('function');
    expect(typeof root.redisSinkStream).toBe('function');
    expect(root.PANEL_LOGS_STREAM).toBe('panel:logs');
  });

  it('re-exports permissions/role-colors/squad-permissions', () => {
    expect(typeof root.PERMISSION_KEYS).toBeDefined();
    expect(typeof root.resolveRconHost).toBe('function');
  });
});
