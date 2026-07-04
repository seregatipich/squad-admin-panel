import { describe, expect, it } from 'vitest';
import MarkTypesPage from './page';

describe('MarkTypesPage', () => {
  it('is a valid React component', () => {
    expect(MarkTypesPage).toBeDefined();
    expect(typeof MarkTypesPage).toBe('function');
  });
});
