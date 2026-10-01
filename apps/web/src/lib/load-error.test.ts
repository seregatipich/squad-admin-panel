import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeLoadError } from './load-error';

describe('describeLoadError', () => {
  it('turns an HTTP status into Russian text', () => {
    expect(describeLoadError(new Error('HTTP 500'))).toBe('Сервер вернул ошибку (код 500).');
  });

  it('reports the status of an ApiError', () => {
    expect(describeLoadError(new ApiError('/api/v1/x', 503, 'down'))).toBe(
      'Сервер вернул ошибку (код 503).',
    );
  });

  it('falls back to a connection message for network failures and non-Error rejections', () => {
    expect(describeLoadError(new TypeError('Failed to fetch'))).toMatch(/связаться с сервером/);
    expect(describeLoadError(undefined)).toMatch(/связаться с сервером/);
  });
});

describe('errorMessage', () => {
  it('reads an Error message and stringifies anything else', async () => {
    const { errorMessage } = await import('./load-error');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
