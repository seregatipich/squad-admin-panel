import { describe, expect, it } from 'vitest';
import {
  computeProgress,
  formatMegabytes,
  formatSpeed,
  isAcceptedUploadType,
  uploadErrorMessage,
} from './upload-progress';

describe('formatMegabytes', () => {
  it('renders whole and fractional megabytes with one decimal', () => {
    expect(formatMegabytes(0)).toBe('0.0 МБ');
    expect(formatMegabytes(1024 * 1024)).toBe('1.0 МБ');
    expect(formatMegabytes(1024 * 1024 * 1.5)).toBe('1.5 МБ');
  });

  it('clamps negative input to zero', () => {
    expect(formatMegabytes(-10)).toBe('0.0 МБ');
  });
});

describe('formatSpeed', () => {
  it('renders megabytes per second', () => {
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 МБ/с');
  });

  it('renders a dash when the speed is not yet measurable', () => {
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(Number.NaN)).toBe('—');
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('computeProgress', () => {
  it('derives percent, transferred size and speed from a progress tick', () => {
    const progress = computeProgress(1024 * 1024, 4 * 1024 * 1024, 1000);
    expect(progress.percent).toBe(25);
    expect(progress.loaded).toBe('1.0 МБ');
    expect(progress.total).toBe('4.0 МБ');
    expect(progress.speed).toBe('1.0 МБ/с');
  });

  it('reports zero percent when the total size is unknown', () => {
    expect(computeProgress(500, 0, 1000).percent).toBe(0);
  });

  it('clamps percent into 0..100', () => {
    expect(computeProgress(-5, 100, 1000).percent).toBe(0);
    expect(computeProgress(500, 100, 1000).percent).toBe(100);
  });

  it('reports an unmeasurable speed before any time has elapsed', () => {
    expect(computeProgress(1024, 2048, 0).speed).toBe('—');
  });
});

describe('isAcceptedUploadType', () => {
  it('accepts the four allowlisted media types', () => {
    expect(isAcceptedUploadType('image/png')).toBe(true);
    expect(isAcceptedUploadType('image/jpeg')).toBe(true);
    expect(isAcceptedUploadType('video/mp4')).toBe(true);
    expect(isAcceptedUploadType('video/webm')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAcceptedUploadType('application/pdf')).toBe(false);
    expect(isAcceptedUploadType('')).toBe(false);
  });
});

describe('uploadErrorMessage', () => {
  it('explains a spent or expired link', () => {
    expect(uploadErrorMessage(410)).toContain('ссылк');
  });

  it('explains an oversized file', () => {
    expect(uploadErrorMessage(413)).toContain('слишком большой');
  });

  it('explains an unsupported format', () => {
    expect(uploadErrorMessage(415)).toContain('формат');
  });

  it('explains a rate limit', () => {
    expect(uploadErrorMessage(429)).toContain('Слишком много');
  });

  it('explains a rejected file body', () => {
    expect(uploadErrorMessage(400)).toContain('не удалось');
  });

  it('falls back to a generic message with the status code', () => {
    expect(uploadErrorMessage(500)).toContain('500');
  });
});
