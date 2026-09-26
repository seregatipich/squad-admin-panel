// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switch } from './Field';
import { GroupedList, GroupedRow } from './GroupedList';

/** `true`, если `first` стоит в документе раньше `second`. */
function precedes(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(cleanup);

describe('GroupedList', () => {
  it('ставит заголовок группы над строками, а сноску под ними', () => {
    render(
      <GroupedList title="Уведомления" footnote="Настройки применяются ко всем серверам.">
        <GroupedRow label="Оповещать о банах" />
      </GroupedList>,
    );
    const heading = screen.getByRole('heading', { name: 'Уведомления' });
    const row = screen.getByText('Оповещать о банах');
    const footnote = screen.getByText('Настройки применяются ко всем серверам.');

    expect(precedes(heading, row)).toBe(true);
    expect(precedes(row, footnote)).toBe(true);
  });

  it('обходится без заголовка и сноски', () => {
    render(
      <GroupedList>
        <GroupedRow label="Оповещать о банах" />
      </GroupedList>,
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('Оповещать о банах')).toBeInTheDocument();
  });

  it('понижает ранг заголовка, когда группа вложена в раздел', () => {
    render(<GroupedList title="Уведомления" headingLevel={3} />);
    expect(screen.getByRole('heading', { name: 'Уведомления', level: 3 })).toBeInTheDocument();
  });

  it('складывает строки в том порядке, в каком их передали', () => {
    render(
      <GroupedList title="Уведомления">
        <GroupedRow label="Первая" />
        <GroupedRow label="Вторая" />
        <GroupedRow label="Третья" />
      </GroupedList>,
    );
    const first = screen.getByText('Первая');
    const second = screen.getByText('Вторая');
    const third = screen.getByText('Третья');

    expect(precedes(first, second)).toBe(true);
    expect(precedes(second, third)).toBe(true);
  });
});

describe('GroupedRow', () => {
  it('с href делает ссылкой всю строку, включая пояснение', () => {
    render(
      <GroupedRow
        href="/settings/roles"
        label="Роли"
        description="Кто и что может делать в панели"
      />,
    );
    const link = screen.getByRole('link', { name: /Роли/ });

    expect(link).toHaveAttribute('href', '/settings/roles');
    expect(link).toHaveTextContent('Кто и что может делать в панели');
  });

  it('с onClick делает строку кнопкой во всю ширину и сообщает нажатие', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<GroupedRow onClick={onClick} label="Сбросить фильтры" />);

    const button = screen.getByRole('button', { name: 'Сбросить фильтры' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('нажимается с клавиатуры, раз это настоящая кнопка', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<GroupedRow onClick={onClick} label="Сбросить фильтры" />);

    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('без href и onClick ничего не нажимает, но держит контрол справа', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <GroupedRow
        label="Оповещать о банах"
        description="Письмо на почту администратора"
        control={<Switch checked={false} onChange={onChange} label="Оповещать о банах" />}
      />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('прячет шеврон перехода от скринридера, чтобы имя ссылки было только подписью', () => {
    render(<GroupedRow href="/settings/roles" label="Роли" />);
    expect(screen.getByRole('link', { name: 'Роли' })).toBeInTheDocument();
  });

  it('разрушающую строку оставляет обычной кнопкой с читаемой подписью', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<GroupedRow onClick={onClick} label="Удалить сервер" danger />);

    await user.click(screen.getByRole('button', { name: 'Удалить сервер' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
