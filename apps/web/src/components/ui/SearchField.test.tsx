// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchField } from './SearchField';

function renderField(props: Omit<Partial<Parameters<typeof SearchField>[0]>, 'onCommit'> = {}) {
  const onCommit = vi.fn<(value: string) => void>();
  const view = render(
    <SearchField
      value=""
      placeholder="Ник или SteamID"
      label="Поиск по игрокам"
      clearLabel="Очистить поиск"
      {...props}
      onCommit={onCommit}
    />,
  );
  return { ...view, onCommit, input: screen.getByRole('searchbox', { name: 'Поиск по игрокам' }) };
}

/** Задержка «сервера» в {@link SlowHarness}, мс. */
const APPLY_LAG = 100;

/** Список, который применяет запрос не мгновенно, — как и настоящий. */
function SlowHarness() {
  const [applied, setApplied] = useState('');
  return (
    <div>
      <SearchField
        value={applied}
        onCommit={(next) => {
          setTimeout(() => setApplied(next), APPLY_LAG);
        }}
        placeholder="Ник или SteamID"
        label="Поиск по игрокам"
        clearLabel="Очистить поиск"
      />
      <output>{applied}</output>
    </div>
  );
}

/** Список, который реально применяет запрос: только так видно эхо и сброс. */
function Harness({ onCommit }: { onCommit: (value: string) => void }) {
  const [applied, setApplied] = useState('');
  return (
    <div>
      <SearchField
        value={applied}
        onCommit={(next) => {
          setApplied(next);
          onCommit(next);
        }}
        placeholder="Ник или SteamID"
        label="Поиск по игрокам"
        clearLabel="Очистить поиск"
      />
      <button type="button" onClick={() => setApplied('')}>
        Сбросить фильтры
      </button>
      <output>{applied}</output>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SearchField', () => {
  it('shows the placeholder and the accessible name it is given', () => {
    const { input } = renderField();
    expect(input).toHaveAttribute('placeholder', 'Ник или SteamID');
  });

  it('does not report a keystroke before the delay has passed', () => {
    const { input, onCommit } = renderField();
    fireEvent.change(input, { target: { value: 'seregа' } });

    act(() => vi.advanceTimersByTime(249));
    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('seregа');
  });

  it('collapses a burst of keystrokes into a single commit of the last value', () => {
    const { input, onCommit } = renderField();
    for (const value of ['s', 'se', 'ser']) {
      fireEvent.change(input, { target: { value } });
      act(() => vi.advanceTimersByTime(200));
    }
    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('ser');
  });

  it('honours a custom delay', () => {
    const { input, onCommit } = renderField({ delay: 1000 });
    fireEvent.change(input, { target: { value: 'ban' } });

    act(() => vi.advanceTimersByTime(250));
    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(750));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('ban');
  });

  it('commits immediately on Enter and does not commit again when the timer would have fired', () => {
    const { input, onCommit } = renderField();
    fireEvent.change(input, { target: { value: 'ban' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('ban');

    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('keeps the clear button out of the way until there is something to clear', () => {
    const { input } = renderField();
    expect(screen.queryByRole('button', { name: 'Очистить поиск' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'ban' } });
    expect(screen.getByRole('button', { name: 'Очистить поиск' })).toBeInTheDocument();
  });

  it('clears the field immediately, without waiting out the delay, and keeps the focus', () => {
    const { input, onCommit } = renderField();
    fireEvent.change(input, { target: { value: 'ban' } });
    act(() => vi.advanceTimersByTime(250));
    onCommit.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('empties the field on Escape and reports it at once', () => {
    const { input, onCommit } = renderField();
    fireEvent.change(input, { target: { value: 'ban' } });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('');

    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('lets Escape through to the screen when the field is already empty', () => {
    // Экраны панели слушают Escape на документе (так закрывается меню и
    // диалог) — пустое поле не имеет права его перехватывать.
    const onEscape = vi.fn();
    document.addEventListener('keydown', onEscape);
    const { input, onCommit } = renderField();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    // А непустое — обязано: иначе очистка поиска заодно закрывает экран.
    fireEvent.change(input, { target: { value: 'ban' } });
    onEscape.mockClear();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
    expect(input).toHaveValue('');

    document.removeEventListener('keydown', onEscape);
  });

  it('puts the cursor in the field only when asked to', () => {
    const { input, unmount } = renderField();
    expect(input).not.toHaveFocus();
    unmount();

    const focused = renderField({ autoFocus: true });
    expect(focused.input).toHaveFocus();
  });

  it('drops a pending commit when the screen closes mid-pause', () => {
    const { input, onCommit, unmount } = renderField();
    fireEvent.change(input, { target: { value: 'ban' } });
    unmount();

    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('follows the query when it is reset from outside, and ignores its own echo', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByRole('searchbox', { name: 'Поиск по игрокам' });

    fireEvent.change(input, { target: { value: 'abc' } });
    act(() => vi.advanceTimersByTime(250));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('abc');
    // Эхо применённого запроса не перетирает поле.
    expect(input).toHaveValue('abc');

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    expect(input).toHaveValue('');
  });

  it('does not clobber keystrokes typed while the previous query is still being applied', () => {
    render(<SlowHarness />);
    const input = screen.getByRole('searchbox', { name: 'Поиск по игрокам' });

    fireEvent.change(input, { target: { value: 'abc' } });
    act(() => vi.advanceTimersByTime(250));

    // Ответ на «abc» ещё в пути, а оператор уже дописал букву.
    fireEvent.change(input, { target: { value: 'abcd' } });
    act(() => vi.advanceTimersByTime(APPLY_LAG));
    expect(screen.getByRole('status')).toHaveTextContent('abc');
    expect(input).toHaveValue('abcd');

    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('status')).toHaveTextContent('abcd');
  });
});
