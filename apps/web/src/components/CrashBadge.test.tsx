// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CrashBadge } from './CrashBadge';

afterEach(cleanup);

describe('CrashBadge', () => {
  it('exports a React component function', async () => {
    const mod = await import('./CrashBadge');
    expect(typeof mod.CrashBadge).toBe('function');
  });

  it('says nothing when the server has never crashed', () => {
    const { container } = render(<CrashBadge crashLoop={false} crashCount={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the crash loop in words, not only in colour', () => {
    render(<CrashBadge crashLoop crashCount={7} />);
    expect(screen.getByText('Цикл аварий')).toBeInTheDocument();
  });

  it('counts single and repeated crashes', () => {
    const { rerender } = render(<CrashBadge crashLoop={false} crashCount={1} />);
    expect(screen.getByText('1 авария')).toBeInTheDocument();
    rerender(<CrashBadge crashLoop={false} crashCount={4} />);
    expect(screen.getByText('4 аварий')).toBeInTheDocument();
  });
});
