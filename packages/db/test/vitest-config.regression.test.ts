// regression: shared DB tests race when Vitest runs files in parallel
// Fix: fileParallelism: false + sequence.concurrent: false in vitest.config.ts
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

describe('vitest config invariants', () => {
  it('fileParallelism is false for shared DB tests', () => {
    const cfg = (vitestConfig as { test?: { fileParallelism?: boolean } }).test;
    expect(cfg?.fileParallelism).toBe(false);
  });

  it('sequence.concurrent is false', () => {
    const cfg = (vitestConfig as { test?: { sequence?: { concurrent?: boolean } } }).test;
    expect(cfg?.sequence?.concurrent).toBe(false);
  });
});
