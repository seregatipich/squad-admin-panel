// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { A2SIndicator } from './A2SIndicator';

afterEach(cleanup);

describe('A2SIndicator', () => {
  it('exports a React component function', async () => {
    const mod = await import('./A2SIndicator');
    expect(typeof mod.A2SIndicator).toBe('function');
  });

  it('stays silent for a server that is not up and for a missing probe', () => {
    const { container, rerender } = render(
      <A2SIndicator a2sStatus={{ visible: true }} serverStatus="stopped" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<A2SIndicator a2sStatus={null} serverStatus="running" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states visibility in words and keeps the latency in the tooltip', () => {
    const { container } = render(
      <A2SIndicator a2sStatus={{ visible: true, latency_ms: 42 }} serverStatus="running" />,
    );
    expect(screen.getByText('Виден в Steam')).toBeInTheDocument();
    expect(container.querySelector('[title]')).toHaveAttribute(
      'title',
      'Виден в Steam Browser (42ms)',
    );
  });

  it('states invisibility in words and explains the reason in the tooltip', () => {
    const { container } = render(
      <A2SIndicator a2sStatus={{ visible: false, reason: 'timeout' }} serverStatus="starting" />,
    );
    expect(screen.getByText('Не виден в Steam')).toBeInTheDocument();
    expect(container.querySelector('[title]')).toHaveAttribute(
      'title',
      'Не виден в Steam Browser: timeout',
    );
  });
});
