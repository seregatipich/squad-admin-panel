import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';

describe('bridge-client index re-exports', () => {
  it('exports the BridgeClient class', () => {
    expect(typeof root.BridgeClient).toBe('function');
  });

  it('exports the framing helpers', () => {
    expect(typeof root.encodeFrame).toBe('function');
    expect(typeof root.decodeFrames).toBe('function');
    expect(typeof root.FrameTooLargeError).toBe('function');
  });

  it('exports BridgeError + the error code union via the type module', () => {
    expect(typeof root.BridgeError).toBe('function');
    const err = new root.BridgeError('forbidden', 'nope');
    expect(err.code).toBe('forbidden');
    expect(err.name).toBe('BridgeError');
  });
});
