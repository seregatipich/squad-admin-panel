// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl, type SegmentedControlItem } from './SegmentedControl';

const ITEMS: SegmentedControlItem[] = [
  { value: 'live', label: 'Онлайн' },
  { value: 'history', label: 'История', badge: '12' },
  { value: 'archive', label: 'Архив' },
];

/** Контролируемый компонент без состояния снаружи не переключается — вот оно. */
function Harness({
  items = ITEMS,
  initial = 'live',
  onChange,
}: {
  items?: SegmentedControlItem[];
  initial?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      items={items}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      ariaLabel="Период"
    />
  );
}

function tabs() {
  return screen.getAllByRole('tab');
}

function selectedTab() {
  return tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true');
}

afterEach(cleanup);

describe('SegmentedControl', () => {
  it('renders one tab per item inside a labelled tablist', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Период' })).toBeInTheDocument();
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Онлайн', 'История12', 'Архив']);
  });

  it('marks exactly one tab selected and keeps only it in the tab order', () => {
    render(<Harness initial="history" />);
    expect(selectedTab()).toHaveLength(1);
    expect(selectedTab()[0]).toHaveTextContent('История');
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('moves the selection right and left with the arrow keys', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = screen.getByRole('tablist');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('history');
    expect(selectedTab()[0]).toHaveTextContent('История');

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('live');
    expect(selectedTab()[0]).toHaveTextContent('Онлайн');
    expect(selectedTab()).toHaveLength(1);
  });

  it('wraps around at both ends, as the tablist pattern requires', () => {
    render(<Harness initial="archive" />);
    const list = screen.getByRole('tablist');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(selectedTab()[0]).toHaveTextContent('Онлайн');

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(selectedTab()[0]).toHaveTextContent('Архив');
  });

  it('selects the first and the last item with Home and End', () => {
    render(<Harness initial="history" />);
    const list = screen.getByRole('tablist');

    fireEvent.keyDown(list, { key: 'End' });
    expect(selectedTab()[0]).toHaveTextContent('Архив');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(selectedTab()[0]).toHaveTextContent('Онлайн');
  });

  it('moves focus with the selection so Tab leaves and re-enters the same segment', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(selectedTab()[0]).toHaveFocus();
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('skips disabled segments in every direction and never selects one', () => {
    const items: SegmentedControlItem[] = [
      { value: 'live', label: 'Онлайн' },
      { value: 'history', label: 'История', disabled: true },
      { value: 'archive', label: 'Архив' },
      { value: 'trash', label: 'Корзина', disabled: true },
    ];
    const onChange = vi.fn();
    render(<Harness items={items} onChange={onChange} />);
    const list = screen.getByRole('tablist');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('archive');

    // End must land on the last *enabled* item, not on the trailing disabled one.
    fireEvent.keyDown(list, { key: 'End' });
    expect(selectedTab()[0]).toHaveTextContent('Архив');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(selectedTab()[0]).toHaveTextContent('Онлайн');

    expect(onChange.mock.calls.flat()).not.toContain('history');
    expect(onChange.mock.calls.flat()).not.toContain('trash');
    expect(screen.getByRole('tab', { name: 'История' })).toBeDisabled();
  });

  it('ignores keys it does not own', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the clicked segment', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Архив' }));
    expect(onChange).toHaveBeenCalledWith('archive');
    expect(selectedTab()[0]).toHaveTextContent('Архив');
  });

  it('keeps a keyboard entry point when the value matches no segment', () => {
    render(
      <SegmentedControl items={ITEMS} value="unknown" onChange={vi.fn()} ariaLabel="Период" />,
    );
    expect(selectedTab()).toHaveLength(0);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });
});
