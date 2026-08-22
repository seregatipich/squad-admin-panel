// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

const onRefresh = vi.fn();
const onDelete = vi.fn();

/**
 * Порядок обхода: «Все игроки» → «Баны» → «Обновить» → «Удалить сервер».
 * Разделитель и `disabled` стоят внутри и в конце, чтобы каждый вид навигации
 * доказывал, что они пропускаются.
 */
const ITEMS: MenuItem[] = [
  { kind: 'link', href: '/all-players', label: 'Все игроки', hint: 'Полный список', active: true },
  { kind: 'link', href: '/bans', label: 'Баны', badge: '3' },
  { kind: 'separator' },
  { kind: 'action', label: 'Обновить', onSelect: onRefresh },
  { kind: 'action', label: 'Удалить сервер', tone: 'destructive', onSelect: onDelete },
  { kind: 'action', label: 'Архивировать', onSelect: vi.fn(), disabled: true },
];

/** Menu управляется снаружи — без состояния он не откроется. */
function Harness({
  items = ITEMS,
  columns,
  onOpenChange,
}: {
  items?: MenuItem[];
  columns?: 1 | 2;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Menu
        trigger={{ label: 'Игроки' }}
        items={items}
        open={open}
        columns={columns}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
      />
      <button type="button">Следующая кнопка страницы</button>
    </>
  );
}

function trigger() {
  return screen.getByRole('button', { name: /^Игроки/ });
}

function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole('menu');
}

afterEach(() => {
  cleanup();
  onRefresh.mockClear();
  onDelete.mockClear();
});

describe('Menu', () => {
  it('describes a closed menu on the trigger and renders no panel', () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click and closes again on the next click', () => {
    render(<Harness />);
    openMenu();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toHaveAttribute('id', trigger().getAttribute('aria-controls'));

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on Enter and puts focus on the first item', () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveFocus();
  });

  it('opens on Space and on ArrowDown at the first item', () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: ' ' });
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveFocus();

    fireEvent.keyDown(trigger(), { key: 'Escape' });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveFocus();
  });

  it('opens on ArrowUp at the last selectable item', () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Удалить сервер' })).toHaveFocus();
  });

  it('renders links as menu items and marks the current page', () => {
    render(<Harness />);
    openMenu();
    const link = screen.getByRole('menuitem', { name: /Все игроки/ });
    expect(link).toHaveAttribute('href', '/all-players');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('menuitem', { name: /Баны/ })).not.toHaveAttribute('aria-current');
  });

  it('walks down and up with the arrows and wraps around at both ends', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Баны/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Удалить сервер' })).toHaveFocus();

    // Последний → первый и обратно: обход замкнут.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Удалить сервер' })).toHaveFocus();
  });

  it('jumps to the edges with Home and End, skipping the disabled tail item', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Удалить сервер' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Архивировать' })).not.toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveFocus();
  });

  it('keeps the separator out of the traversal', () => {
    render(<Harness />);
    const menu = openMenu();
    expect(screen.getByRole('separator')).toBeInTheDocument();

    // Между «Баны» и «Обновить» стоит разделитель — стрелка проходит его насквозь.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();
  });

  it('never gives focus to a disabled item, and never selects it', () => {
    const onArchive = vi.fn();
    render(
      <Harness
        items={[
          { kind: 'action', label: 'Обновить', onSelect: onRefresh },
          { kind: 'action', label: 'Архивировать', onSelect: onArchive, disabled: true },
        ]}
      />,
    );
    const menu = openMenu();

    // Единственный доступный пункт: круговой обход возвращает на него же.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Архивировать' }));
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('moves to the next item starting with the typed letter', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'у' });
    expect(screen.getByRole('menuitem', { name: 'Удалить сервер' })).toHaveFocus();

    // Поиск продолжается по кругу от текущего пункта.
    fireEvent.keyDown(menu, { key: 'б' });
    expect(screen.getByRole('menuitem', { name: /Баны/ })).toHaveFocus();
  });

  it('matches the typed letter regardless of case, and stays put when nothing matches', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'О' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'z' });
    expect(screen.getByRole('menuitem', { name: 'Обновить' })).toHaveFocus();
  });

  it('runs the action and closes the menu when an item is chosen', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Обновить' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('closes the menu when a link is chosen', () => {
    // jsdom не умеет переходить по адресу и ругается в stderr; отмена перехода
    // не мешает всплытию, поэтому обработчик самого пункта всё равно срабатывает.
    const swallowNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', swallowNavigation);
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: /Баны/ }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    document.removeEventListener('click', swallowNavigation);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(trigger()).toHaveFocus();
  });

  it('closes on Tab and hands focus back to the trigger so the page order continues', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes on a pointer press outside, but not on one inside the panel', () => {
    render(<Harness />);
    const menu = openMenu();

    fireEvent.mouseDown(menu);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('exposes a group as a labelled region whose items stay in the same traversal', () => {
    render(
      <Harness
        columns={2}
        items={[
          {
            kind: 'group',
            label: 'Панель',
            items: [
              { kind: 'link', href: '/settings/groups', label: 'Группы' },
              { kind: 'link', href: '/settings/tokens', label: 'API-токены' },
            ],
          },
          {
            kind: 'group',
            label: 'Модерация',
            items: [{ kind: 'link', href: '/settings/rules', label: 'Правила' }],
          },
        ]}
      />,
    );
    const menu = openMenu();

    expect(screen.getByRole('group', { name: 'Панель' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Модерация' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Группы' })).toHaveFocus();

    // Обход сквозной: из конца первой группы стрелка уходит во вторую.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Правила' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Правила' })).toHaveAttribute(
      'href',
      '/settings/rules',
    );
  });

  it('survives a menu that has nothing selectable in it', () => {
    render(<Harness items={[{ kind: 'separator' }]} />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'End' });
    fireEvent.keyDown(menu, { key: 'а' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('uses the trigger aria-label as the accessible name of an icon trigger', () => {
    function IconHarness() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          trigger={{
            label: <span aria-hidden>⋯</span>,
            ariaLabel: 'Меню пользователя',
            badge: '4',
          }}
          items={ITEMS}
          open={open}
          onOpenChange={setOpen}
          align="end"
        />
      );
    }
    render(<IconHarness />);
    const button = screen.getByRole('button', { name: 'Меню пользователя' });
    expect(button).toHaveTextContent('4');

    fireEvent.click(button);
    expect(screen.getByRole('menu', { name: 'Меню пользователя' })).toBeInTheDocument();
  });
});
