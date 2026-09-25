// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox, FieldRow, Select, Switch, Textarea, TextInput } from './Field';

/** Контролируемый переключатель без состояния снаружи не переключается — вот оно. */
function SwitchHarness({
  initial = false,
  onChange,
  disabled = false,
}: {
  initial?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      checked={checked}
      onChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
      label="Уведомления о банах"
      disabled={disabled}
    />
  );
}

afterEach(cleanup);

describe('TextInput', () => {
  it('принимает ввод и отдаёт его как обычное поле', async () => {
    const user = userEvent.setup();
    render(<TextInput aria-label="Причина" />);
    const input = screen.getByRole('textbox', { name: 'Причина' });

    await user.type(input, 'Читы');
    expect(input).toHaveValue('Читы');
  });

  it('помечает ошибочное значение через aria-invalid, а не только цветом', () => {
    const { rerender } = render(<TextInput aria-label="Причина" />);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');

    rerender(<TextInput aria-label="Причина" invalid />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('не принимает ввод, пока отключено', async () => {
    const user = userEvent.setup();
    render(<TextInput aria-label="Причина" disabled />);
    const input = screen.getByRole('textbox');

    await user.type(input, 'Читы');
    expect(input).toBeDisabled();
    expect(input).toHaveValue('');
  });
});

describe('Textarea', () => {
  it('принимает многострочный ввод', async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Комментарий" />);
    const area = screen.getByRole('textbox', { name: 'Комментарий' });

    await user.type(area, 'Первая{enter}Вторая');
    expect(area).toHaveValue('Первая\nВторая');
  });

  it('помечает ошибочное значение через aria-invalid', () => {
    render(<Textarea aria-label="Комментарий" invalid />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Select', () => {
  it('остаётся нативным списком: выбор меняется с клавиатуры и мышью', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select aria-label="Роль" defaultValue="admin" onChange={onChange}>
        <option value="admin">Администратор</option>
        <option value="moderator">Модератор</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Роль' });

    expect(select).toHaveValue('admin');
    await user.selectOptions(select, 'moderator');
    expect(select).toHaveValue('moderator');
    expect(onChange).toHaveBeenCalled();
  });

  it('прячет собственный шеврон от скринридера', () => {
    render(
      <Select aria-label="Роль">
        <option value="admin">Администратор</option>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Роль' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('Checkbox', () => {
  it('переключается нажатием на подпись, а не только на сам флажок', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Показывать IP-адреса" />);
    const box = screen.getByRole('checkbox', { name: 'Показывать IP-адреса' });

    expect(box).not.toBeChecked();
    await user.click(screen.getByText('Показывать IP-адреса'));
    expect(box).toBeChecked();
  });

  it('сообщает изменение вызывающему коду', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Показывать IP-адреса" onChange={onChange} />);

    await user.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('не переключается, пока отключён', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Показывать IP-адреса" disabled onChange={onChange} />);

    await user.click(screen.getByText('Показывать IP-адреса'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Switch', () => {
  it('объявляет себя переключателем с доступным именем и состоянием', () => {
    render(<SwitchHarness />);
    const control = screen.getByRole('switch', { name: 'Уведомления о банах' });
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('переключается мышью и сообщает запрошенное состояние', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwitchHarness onChange={onChange} />);
    const control = screen.getByRole('switch');

    await user.click(control);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control).toHaveAttribute('aria-checked', 'true');

    await user.click(control);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('переключается пробелом', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwitchHarness onChange={onChange} />);
    const control = screen.getByRole('switch');

    await user.tab();
    expect(control).toHaveFocus();

    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('переключается Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwitchHarness onChange={onChange} />);
    const control = screen.getByRole('switch');

    await user.tab();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('не переключается, пока отключён', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwitchHarness disabled onChange={onChange} />);
    const control = screen.getByRole('switch');

    await user.click(control);
    expect(onChange).not.toHaveBeenCalled();
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('ссылается на внешнее пояснение через aria-describedby', () => {
    render(
      <>
        <Switch checked={false} onChange={vi.fn()} label="Автобан" describedBy={AUTOBAN_HINT_ID} />
        <p id={AUTOBAN_HINT_ID}>Банит за превышение порога.</p>
      </>,
    );
    expect(screen.getByRole('switch')).toHaveAccessibleDescription('Банит за превышение порога.');
  });
});

/**
 * Идентификаторы, которые в этих тестах задаёт вызывающий код.
 *
 * Вынесены в константы, а не написаны литералами прямо в JSX: правило
 * `useUniqueElementIds` требует, чтобы идентификатор элемента приходил из
 * `useId()` или переменной — иначе два экземпляра компонента на одной
 * странице получили бы один и тот же `id`. В тесте столкновения нет, но
 * держать исключение из правила дороже, чем три константы.
 */
const AUTOBAN_HINT_ID = 'hint-autoban';
const BAN_REASON_ID = 'ban-reason';
const REASON_HINT_ID = 'reason-hint';

describe('FieldRow', () => {
  it('связывает подпись с контролом, даже когда идентификатор не задан снаружи', () => {
    render(
      <FieldRow label="Причина бана">
        <TextInput />
      </FieldRow>,
    );
    expect(screen.getByLabelText('Причина бана')).toBe(screen.getByRole('textbox'));
  });

  it('уважает идентификатор, заданный вызывающим кодом', () => {
    render(
      <FieldRow label="Причина бана" htmlFor={BAN_REASON_ID}>
        <TextInput id={BAN_REASON_ID} />
      </FieldRow>,
    );
    expect(screen.getByLabelText('Причина бана')).toHaveAttribute('id', BAN_REASON_ID);
  });

  it('объявляет ошибку и связывает её с контролом', () => {
    render(
      <FieldRow label="Причина бана" error="Укажите причину">
        <TextInput />
      </FieldRow>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Укажите причину');

    const control = screen.getByRole('textbox');
    expect(control.getAttribute('aria-describedby')).toBe(alert.id);
    expect(control).toHaveAccessibleDescription('Укажите причину');
  });

  it('дописывает ошибку к уже имеющемуся описанию, а не затирает его', () => {
    render(
      <>
        <p id={REASON_HINT_ID}>До 200 символов.</p>
        <FieldRow label="Причина бана" error="Укажите причину">
          <TextInput aria-describedby={REASON_HINT_ID} />
        </FieldRow>
      </>,
    );
    const description = screen.getByRole('textbox').getAttribute('aria-describedby');
    expect(description).toContain('reason-hint');
    expect(description).toContain(screen.getByRole('alert').id);
  });

  it('без ошибки не объявляет тревогу и не описывает контрол', () => {
    render(
      <FieldRow label="Причина бана" hint="До 200 символов">
        <TextInput />
      </FieldRow>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby');
    expect(screen.getByText('До 200 символов')).toBeInTheDocument();
  });

  it('помечает обязательное поле так, что скринридер не читает звёздочку дважды', () => {
    render(
      <FieldRow label="Причина бана" required>
        <TextInput required />
      </FieldRow>,
    );
    const control = screen.getByRole('textbox', { name: 'Причина бана' });
    expect(control).toBeRequired();
  });

  it('связывает ошибку и с переключателем', () => {
    render(
      <FieldRow label="Автобан" error="Недоступно без прав">
        <Switch checked={false} onChange={vi.fn()} label="Автобан" />
      </FieldRow>,
    );
    expect(screen.getByRole('switch')).toHaveAccessibleDescription('Недоступно без прав');
  });
});
