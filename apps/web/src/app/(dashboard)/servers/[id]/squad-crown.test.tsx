// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { SquadCrown as SquadCrownData } from '@squad/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SquadCrown } from './squad-crown';

const squad = {
  squad_name: 'Alpha',
  team_id: 1,
  squad_id: 1,
  created_at: '2026-09-27T21:04:00.000Z',
  handoffs: [{ to_name: 'Ivan', reason: 'passed' as const, at: '2026-09-27T21:10:00.000Z' }],
  disbanded_at: null,
  abandoned_at: null,
};

afterEach(() => cleanup());

describe('SquadCrown', () => {
  it('draws a muted crown whose label names the handoff', () => {
    const crown: SquadCrownData = { color: 'grey', squads: [squad] };
    render(<SquadCrown crown={crown} />);
    const icon = screen.getByRole('img', {
      name: /^Создал отряд "Alpha" в \d{2}:\d{2}, передал командование: Ivan \(\d{2}:\d{2}\)$/,
    });
    expect(icon).toHaveClass('text-ink-3');
    expect(icon.getAttribute('title')).toBe(icon.getAttribute('aria-label'));
  });

  it('draws a danger-tone crown for an abandoned squad', () => {
    const crown: SquadCrownData = {
      color: 'red',
      squads: [{ ...squad, handoffs: [], abandoned_at: '2026-09-27T21:12:00.000Z' }],
    };
    render(<SquadCrown crown={crown} />);
    const icon = screen.getByRole('img', { name: /покинул его, будучи командиром/ });
    expect(icon).toHaveClass('text-crit');
  });
});
