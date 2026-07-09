import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MatchTimelineEvent } from '../helpers';
import { MatchTimeline } from './MatchCard';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

function event(overrides: Partial<MatchTimelineEvent> = {}): MatchTimelineEvent {
  return {
    id: overrides.id ?? 1,
    event_type: overrides.event_type ?? 'death',
    occurred_at: overrides.occurred_at ?? '2026-07-04T10:02:30.000Z',
    weapon: overrides.weapon === undefined ? 'BP_AK74' : overrides.weapon,
    damage: overrides.damage === undefined ? null : overrides.damage,
    attacker_vehicle: overrides.attacker_vehicle === undefined ? null : overrides.attacker_vehicle,
    victim_vehicle: overrides.victim_vehicle === undefined ? null : overrides.victim_vehicle,
    attacker_kit: overrides.attacker_kit === undefined ? null : overrides.attacker_kit,
    is_teamkill: overrides.is_teamkill ?? false,
    attacker:
      overrides.attacker === undefined
        ? { player_id: 'attacker-1', current_name: 'Alpha' }
        : overrides.attacker,
    victim:
      overrides.victim === undefined
        ? { player_id: 'victim-1', current_name: 'Bravo' }
        : overrides.victim,
  };
}

describe('MatchTimeline', () => {
  it('renders death events with player links, weapon and offset', () => {
    const html = renderToStaticMarkup(
      <MatchTimeline
        events={[event({ is_teamkill: true })]}
        startedAt="2026-07-04T10:00:00.000Z"
        combatLogHref="/combat-log?server=srv-1"
      />,
    );

    expect(html).toContain('Тимкилл');
    expect(html).toContain('+2м 30с');
    expect(html).toContain('BP_AK74');
    expect(html).toContain('href="/players/attacker-1"');
    expect(html).toContain('href="/players/victim-1"');
    expect(html).toContain('href="/combat-log?server=srv-1"');
  });

  it('renders a clear empty state for no events', () => {
    const html = renderToStaticMarkup(
      <MatchTimeline
        events={[]}
        startedAt="2026-07-04T10:00:00.000Z"
        combatLogHref="/combat-log"
      />,
    );
    expect(html).toContain('Боевые события не найдены');
  });

  it('renders no-access state when combat events are not available', () => {
    const html = renderToStaticMarkup(
      <MatchTimeline
        events={null}
        startedAt="2026-07-04T10:00:00.000Z"
        combatLogHref="/combat-log"
      />,
    );
    expect(html).toContain('Нет доступа к боевым событиям');
  });
});
