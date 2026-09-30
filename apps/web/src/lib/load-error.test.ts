import { describe, expect, it } from 'vitest';
import { describeLoadError } from './load-error';

describe('describeLoadError', () => {
  it('turns an HTTP status into Russian text', () => {
    expect(describeLoadError(new Error('HTTP 500'))).toBe('Сервер вернул ошибку (код 500).');
  });

  it('falls back to a connection message for network failures and non-Error rejections', () => {
    expect(describeLoadError(new TypeError('Failed to fetch'))).toMatch(/связаться с сервером/);
    expect(describeLoadError(undefined)).toMatch(/связаться с сервером/);
  });
});
