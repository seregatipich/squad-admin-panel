// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useId } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleExpiryDateField } from './RoleExpiryDateField';

function TestRoleExpiryDateField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return <RoleExpiryDateField id={id} value={value} onChange={onChange} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RoleExpiryDateField', () => {
  it('opens the native picker from the whole visible field', () => {
    const showPicker = vi.fn();
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
      configurable: true,
      value: showPicker,
    });

    render(<TestRoleExpiryDateField value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Открыть календарь срока действия' }));
    expect(showPicker).toHaveBeenCalledOnce();
  });

  it('shows a fixed dd/mm/yyyy value and lets the operator clear it', () => {
    const onChange = vi.fn();
    render(<TestRoleExpiryDateField value="2099-12-31" onChange={onChange} />);

    expect(screen.getByText('31/12/2099')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сделать роль бессрочной' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('forwards the ISO day chosen in the native calendar', () => {
    const onChange = vi.fn();
    render(<TestRoleExpiryDateField value="" onChange={onChange} />);

    fireEvent.change(screen.getByTestId('role-expiry-native-date'), {
      target: { value: '2026-08-15' },
    });
    expect(onChange).toHaveBeenCalledWith('2026-08-15');
  });
});
