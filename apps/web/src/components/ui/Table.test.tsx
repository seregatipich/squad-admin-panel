// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SortableTh, Table, TableBody, TableCaption, TableHead, TableRow, Td, Th } from './Table';

afterEach(cleanup);

const DIRECTION_TEXT = { asc: 'по возрастанию', desc: 'по убыванию' } as const;

function renderSortableHeader(overrides: Partial<Parameters<typeof SortableTh>[0]> = {}): {
  onSort: ReturnType<typeof vi.fn>;
} {
  const onSort = vi.fn();
  render(
    <Table ariaLabel="Игроки">
      <TableHead>
        <TableRow>
          <SortableTh
            sortKey="name"
            activeKey="name"
            direction="asc"
            onSort={onSort}
            label="Ник"
            directionText={DIRECTION_TEXT}
            {...overrides}
          />
        </TableRow>
      </TableHead>
    </Table>,
  );
  return { onSort };
}

describe('Table', () => {
  it('is reachable as a table named by ariaLabel', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableBody>
          <TableRow>
            <Td>Alice</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'Игроки' });
    expect(within(table).getByRole('cell', { name: 'Alice' })).toBeInTheDocument();
  });

  it('keeps every row and cell in the accessibility tree', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableHead>
          <TableRow>
            <Th>Ник</Th>
            <Th align="right">Очки</Th>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <Td>Alice</Td>
            <Td numeric>120</Td>
          </TableRow>
          <TableRow>
            <Td>Bob</Td>
            <Td numeric>90</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getAllByRole('cell')).toHaveLength(4);
  });
});

describe('TableHead', () => {
  it('pins the header row group by default', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableHead>
          <TableRow>
            <Th>Ник</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );
    expect(screen.getByRole('columnheader').closest('thead')).toHaveClass('sticky');
  });

  it('scrolls with the page by default and offsets the header by the chrome height', () => {
    render(
      <Table ariaLabel="Серверы">
        <TableHead>
          <TableRow>
            <Th>Имя</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );

    const wrapper = screen.getByRole('table').parentElement as HTMLElement;
    expect(wrapper.className).not.toContain('overflow');
    expect(wrapper.style.getPropertyValue('--table-head-top')).toBe('var(--chrome-h)');
  });

  it('takes its own scroller when a height is given, and pins the header to it', () => {
    render(
      <Table ariaLabel="Серверы" maxHeight="60vh">
        <TableHead>
          <TableRow>
            <Th>Имя</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );

    const wrapper = screen.getByRole('table').parentElement as HTMLElement;
    expect(wrapper).toHaveClass('overflow-auto');
    expect(wrapper.style.maxHeight).toBe('60vh');
    // Внутри собственного скроллера шапка прилипает к его краю, а не к окну.
    expect(wrapper.style.getPropertyValue('--table-head-top')).toBe('0px');
  });

  it('releases the header when sticky is turned off', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableHead sticky={false}>
          <TableRow>
            <Th>Ник</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );
    expect(screen.getByRole('columnheader').closest('thead')).not.toHaveClass('sticky');
  });
});

describe('Th', () => {
  it('scopes itself to its column by default', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableHead>
          <TableRow>
            <Th>Ник</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Ник' })).toHaveAttribute('scope', 'col');
  });

  it('applies a width only when one is given', () => {
    render(
      <Table ariaLabel="Игроки" layout="fixed">
        <TableHead>
          <TableRow>
            <Th width="12rem">Ник</Th>
            <Th>Роль</Th>
          </TableRow>
        </TableHead>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Ник' })).toHaveStyle({ width: '12rem' });
    expect(screen.getByRole('columnheader', { name: 'Роль' }).getAttribute('style')).toBeNull();
  });
});

describe('Td', () => {
  it('right-aligns numbers and keeps their digits in columns', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableBody>
          <TableRow>
            <Td numeric>120</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('cell', { name: '120' })).toHaveClass('text-right', 'tabular-nums');
  });

  it('leaves ordinary cells alone', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableBody>
          <TableRow>
            <Td>Alice</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cell = screen.getByRole('cell', { name: 'Alice' });
    expect(cell).not.toHaveClass('text-right');
    expect(cell).not.toHaveClass('tabular-nums');
  });
});

describe('TableRow', () => {
  it('renders a navigating row as a real link inside the first cell', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableBody>
          <TableRow interactive>
            <Td>
              <a href="/players/1">Alice</a>
            </Td>
            <Td numeric>120</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    // A real <a> is what gives middle-click, Cmd+click and "copy link address"
    // back; an onClick on the <tr> would expose none of them.
    expect(screen.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/players/1');
  });

  it('renders its cells in every tone and selection state', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableBody>
          <TableRow tone="warn">
            <Td>предупреждение</Td>
          </TableRow>
          <TableRow tone="crit" selected>
            <Td>критично</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: 'предупреждение' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'критично' })).toBeInTheDocument();
  });
});

describe('SortableTh', () => {
  it('announces the ascending direction on the active column', () => {
    renderSortableHeader();
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('announces the descending direction on the active column', () => {
    renderSortableHeader({ direction: 'desc' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
  });

  it('reports an inactive column as unsorted whatever the direction is', () => {
    renderSortableHeader({ sortKey: 'score', activeKey: 'name', direction: 'desc' });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('reports every column as unsorted while the table has no order', () => {
    renderSortableHeader({ activeKey: null });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('follows the active column across rerenders', () => {
    const onSort = vi.fn();
    const header = (props: Partial<Parameters<typeof SortableTh>[0]>) => (
      <Table ariaLabel="Игроки">
        <TableHead>
          <TableRow>
            <SortableTh
              sortKey="name"
              activeKey="name"
              direction="asc"
              onSort={onSort}
              label="Ник"
              directionText={DIRECTION_TEXT}
              {...props}
            />
          </TableRow>
        </TableHead>
      </Table>
    );

    const { rerender } = render(header({}));
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');

    rerender(header({ direction: 'desc' }));
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');

    rerender(header({ activeKey: 'score' }));
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('spells the direction out for a screen reader on the active column', () => {
    renderSortableHeader();
    expect(screen.getByRole('button', { name: /Ник.*по возрастанию/ })).toBeInTheDocument();
  });

  it('says nothing about direction on an inactive column', () => {
    renderSortableHeader({ sortKey: 'score', activeKey: 'name', label: 'Очки' });
    expect(screen.getByRole('button', { name: 'Очки' })).toBeInTheDocument();
    expect(screen.queryByText('по возрастанию')).not.toBeInTheDocument();
    expect(screen.queryByText('по убыванию')).not.toBeInTheDocument();
  });

  it('asks to sort by its own key when clicked', async () => {
    const { onSort } = renderSortableHeader();
    await userEvent.click(screen.getByRole('button', { name: /Ник/ }));
    expect(onSort).toHaveBeenCalledExactlyOnceWith('name');
  });

  it('asks to sort by an inactive column too', async () => {
    const { onSort } = renderSortableHeader({
      sortKey: 'score',
      activeKey: 'name',
      label: 'Очки',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Очки' }));
    expect(onSort).toHaveBeenCalledExactlyOnceWith('score');
  });

  it('is reachable and operable from the keyboard', async () => {
    const { onSort } = renderSortableHeader();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /Ник/ })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onSort).toHaveBeenCalledTimes(2);
    expect(onSort).toHaveBeenCalledWith('name');
  });
});

describe('TableCaption', () => {
  it('describes the table for assistive technology without showing on screen', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableCaption>Игроки, отсортированные по нику</TableCaption>
        <TableBody>
          <TableRow>
            <Td>Alice</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const caption = screen.getByText('Игроки, отсортированные по нику');
    expect(caption.tagName).toBe('CAPTION');
    expect(caption).toHaveClass('sr-only');
  });

  it('shows on screen when asked to', () => {
    render(
      <Table ariaLabel="Игроки">
        <TableCaption visible>Все игроки</TableCaption>
        <TableBody>
          <TableRow>
            <Td>Alice</Td>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByText('Все игроки')).not.toHaveClass('sr-only');
  });
});
