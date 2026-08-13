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

  it('removes only the tag whose button was clicked', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['one', 'two', 'three']} onChange={onChange} />);
    const secondRemoveButton = screen.getAllByRole('button')[1];
    if (!secondRemoveButton) throw new Error('second tag remove button is missing');

    fireEvent.click(secondRemoveButton);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(['one', 'three']);
  });

  it('focuses the input when its container is clicked or receives a key event', () => {
    render(<TagInput tags={[]} onChange={vi.fn()} />);
    const input = screen.getByRole('textbox');
    const container = input.closest('fieldset');
    if (!container) throw new Error('tag input fieldset is missing');

    fireEvent.click(container);
    expect(input).toHaveFocus();

    input.blur();
    fireEvent.keyDown(container, { key: 'ArrowRight' });
    expect(input).toHaveFocus();
  });
});
