import { describe, expect, it } from 'vitest';
import {
  balancerViewState,
  buildProposalsQuery,
  DEFAULT_BALANCER_FILTERS,
  decisionLabel,
  formatTeam,
  proposalStateLabel,
  proposalStateRowClass,
  proposalStateTone,
  proposalStatusLabel,
  subjectTypeLabel,
  summarizeStates,
  triggerReasonLabel,
} from './helpers';

describe('proposalStateTone', () => {
  it('maps on_target to the green tone', () => {
    expect(proposalStateTone('on_target')).toBe('emerald');
  });

  it('maps no_change to the neutral/gray tone', () => {
    expect(proposalStateTone('no_change')).toBe('neutral');
  });

  it('maps should_move to the red tone', () => {
    expect(proposalStateTone('should_move')).toBe('red');
  });

  it('falls back to the neutral tone for an unknown payload state', () => {
    expect(proposalStateTone('teleport')).toBe('neutral');
  });
});

describe('proposalStateRowClass', () => {
  it('derives one distinct row class per tone, never from free text', () => {
    const classes = [
      proposalStateRowClass('on_target'),
      proposalStateRowClass('no_change'),
      proposalStateRowClass('should_move'),
    ];
    expect(new Set(classes).size).toBe(3);
    expect(classes[0]).toContain('emerald');
    expect(classes[2]).toContain('red');
  });

  it('renders an unknown state with the neutral row class', () => {
    expect(proposalStateRowClass('???')).toBe(proposalStateRowClass('no_change'));
  });
});

describe('proposalStateLabel', () => {
  it('labels every known state in Russian', () => {
    expect(proposalStateLabel('on_target')).toBe('На нужной стороне');
    expect(proposalStateLabel('no_change')).toBe('Без изменений');
    expect(proposalStateLabel('should_move')).toBe('Предлагается перевод');
  });

  it('echoes an unknown state instead of inventing a label', () => {
    expect(proposalStateLabel('weird')).toBe('weird');
  });
});

describe('proposalStatusLabel and decisionLabel', () => {
  it('labels every proposal status in Russian', () => {
    expect(proposalStatusLabel('open')).toBe('Новое');
    expect(proposalStatusLabel('reviewed')).toBe('Рассмотрено');
    expect(proposalStatusLabel('dismissed')).toBe('Отклонено');
    expect(proposalStatusLabel('superseded')).toBe('Устарело');
    expect(proposalStatusLabel('other')).toBe('other');
  });

  it('labels every operator decision in Russian', () => {
    expect(decisionLabel('acknowledge')).toBe('Принято к сведению');
    expect(decisionLabel('veto')).toBe('Вето');
    expect(decisionLabel('dismiss')).toBe('Отклонено');
    expect(decisionLabel('nope')).toBe('nope');
  });
});

describe('subjectTypeLabel and formatTeam', () => {
  it('labels every subject type in Russian', () => {
    expect(subjectTypeLabel('squad')).toBe('Отряд');
    expect(subjectTypeLabel('group')).toBe('Группа');
    expect(subjectTypeLabel('player')).toBe('Игрок');
    expect(subjectTypeLabel('alien')).toBe('alien');
  });

  it('renders team numbers and an em dash for a missing team', () => {
    expect(formatTeam(1)).toBe('Команда 1');
    expect(formatTeam(2)).toBe('Команда 2');
    expect(formatTeam(null)).toBe('—');
    expect(formatTeam(undefined)).toBe('—');
  });
});

describe('triggerReasonLabel', () => {
  it('renders each trigger kind with its observed value and threshold', () => {
    expect(triggerReasonLabel({ kind: 'win_streak', observed: 4, threshold: 3 })).toBe(
      'Серия побед: 4 (порог 3)',
    );
    expect(triggerReasonLabel({ kind: 'ticket_diff', observed: 320, threshold: 150 })).toBe(
      'Разница тикетов: 320 (порог 150)',
    );
    expect(triggerReasonLabel({ kind: 'one_sided_rounds', observed: 3, threshold: 2 })).toBe(
      'Односторонних раундов: 3 (порог 2)',
    );
  });

  it('falls back to the raw kind for an unknown reason', () => {
    expect(triggerReasonLabel({ kind: 'gravity', observed: 1, threshold: 0 })).toBe(
      'gravity: 1 (порог 0)',
    );
  });
});

describe('buildProposalsQuery', () => {
  it('always sends the mode and omits the "all" server sentinel', () => {
    expect(buildProposalsQuery(DEFAULT_BALANCER_FILTERS)).toBe('mode=squad&limit=25');
  });

  it('sends every set filter', () => {
    expect(
      buildProposalsQuery({
        mode: 'player',
        serverId: '019e0083-0000-7000-8000-0000000000a1',
        status: 'open',
        limit: 50,
      }),
    ).toBe('mode=player&server_id=019e0083-0000-7000-8000-0000000000a1&status=open&limit=50');
  });

  it('drops an empty status filter', () => {
    expect(buildProposalsQuery({ ...DEFAULT_BALANCER_FILTERS, status: '' })).toBe(
      'mode=squad&limit=25',
    );
  });
});

describe('summarizeStates', () => {
  it('counts each state in the diff payload', () => {
    expect(
      summarizeStates([
        { state: 'should_move' },
        { state: 'should_move' },
        { state: 'on_target' },
        { state: 'no_change' },
        { state: 'unknown' },
      ]),
    ).toEqual({ on_target: 1, no_change: 1, should_move: 2 });
  });

  it('returns all-zero counts for an empty diff', () => {
    expect(summarizeStates([])).toEqual({ on_target: 0, no_change: 0, should_move: 0 });
  });
});

describe('balancerViewState', () => {
  it('reports loading while the first fetch is in flight', () => {
    expect(balancerViewState({ loading: true, error: null, items: [] })).toBe('loading');
  });

  it('reports error when the fetch failed, even with stale items', () => {
    expect(
      balancerViewState({
        loading: false,
        error: 'HTTP 500',
        items: [{ evaluation: { triggered: true } }],
      }),
    ).toBe('error');
  });

  it('reports empty when no upstream snapshot has arrived', () => {
    expect(balancerViewState({ loading: false, error: null, items: [] })).toBe('empty');
  });

  it('reports healthy when snapshots exist but no signal is triggered', () => {
    expect(
      balancerViewState({
        loading: false,
        error: null,
        items: [{ evaluation: { triggered: false } }, { evaluation: { triggered: false } }],
      }),
    ).toBe('healthy');
  });

  it('reports imbalance as soon as one snapshot triggers', () => {
    expect(
      balancerViewState({
        loading: false,
        error: null,
        items: [{ evaluation: { triggered: false } }, { evaluation: { triggered: true } }],
      }),
    ).toBe('imbalance');
  });
});
