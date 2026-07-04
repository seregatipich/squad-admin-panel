import { describe, expect, it } from 'vitest';
import { TemplatePicker } from './TemplatePicker';

describe('TemplatePicker', () => {
  it('is a valid React component', () => {
    expect(TemplatePicker).toBeDefined();
    expect(typeof TemplatePicker).toBe('function');
  });
});
