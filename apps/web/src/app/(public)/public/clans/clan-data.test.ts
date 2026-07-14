// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatOnlineHours } from './clan-data';

afterEach(() => cleanup());

describe('formatOnlineHours', () => {
  it('formats aggregate online seconds in Russian hours', () => {
    expect(formatOnlineHours(5400)).toBe('1,5 ч');
  });

  it('does not render negative activity', () => {
    expect(formatOnlineHours(-1)).toBe('0,0 ч');
  });
});
