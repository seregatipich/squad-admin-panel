// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagInput } from './TagInput';

afterEach(cleanup);

describe('TagInput', () => {
  it('trims and lowercases a tag submitted with Enter', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['existing']} onChange={onChange} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '  New-TAG  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(['existing', 'new-tag']);
    expect(input).toHaveValue('');
  });

  it.each([
    { name: 'empty input', tags: ['one'], maxTags: 20, value: '   ' },
    { name: 'a case-normalized duplicate', tags: ['duplicate'], maxTags: 20, value: ' DUPLICATE ' },
    { name: 'the configured tag limit', tags: ['one', 'two'], maxTags: 2, value: 'three' },
  ])('rejects $name', ({ tags, maxTags, value }) => {
    const onChange = vi.fn();
    render(<TagInput tags={tags} onChange={onChange} maxTags={maxTags} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes the last tag with Backspace only when the input is empty', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['one', 'two']} onChange={onChange} />);
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['one']);

    onChange.mockClear();
    fireEvent.change(input, { target: { value: 'text' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names every remove button after its own tag and removes only that tag', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['one', 'two', 'three']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить тег two' }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(['one', 'three']);
  });

  // Раньше поле жило в `<fieldset>` без легенды и оставалось безымянным: имя
  // ему давал только placeholder, который исчезал, как только появлялся тег.
  it('gives the input an accessible name that survives the first tag', () => {
    const { rerender } = render(<TagInput tags={[]} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Теги')).toBe(screen.getByRole('textbox'));

    rerender(<TagInput tags={['one']} onChange={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Теги' })).toBeInTheDocument();
  });

  it('lets the caller name the field', () => {
    render(<TagInput tags={[]} onChange={vi.fn()} label="Метки сервера" />);
    expect(screen.getByRole('textbox', { name: 'Метки сервера' })).toBeInTheDocument();
  });
});
