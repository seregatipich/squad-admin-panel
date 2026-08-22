// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Card, CardBody, CardFooter, CardGrid, CardHeader } from './Card';

afterEach(cleanup);

describe('Card', () => {
  it('renders its children inside a div by default', () => {
    const { container } = render(<Card>содержимое</Card>);
    const card = container.firstElementChild;
    expect(card?.tagName).toBe('DIV');
    expect(card).toHaveTextContent('содержимое');
  });

  it('renders the semantic element asked for by `as`', () => {
    const { container: section } = render(<Card as="section">раздел</Card>);
    expect(section.firstElementChild?.tagName).toBe('SECTION');

    const { container: article } = render(<Card as="article">статья</Card>);
    expect(article.firstElementChild?.tagName).toBe('ARTICLE');
  });

  it('keeps a caller-supplied className alongside its own', () => {
    const { container } = render(<Card className="col-span-2">x</Card>);
    expect(container.firstElementChild?.classList).toContain('col-span-2');
  });
});

describe('CardHeader', () => {
  it('exposes the title as a level-2 heading by default', () => {
    render(<CardHeader title="Серверы" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Серверы' })).toBeInTheDocument();
  });

  it('drops the title to level 3 on request', () => {
    render(<CardHeader title="Серверы" headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Серверы' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('shows the count next to the title without folding it into the heading', () => {
    render(<CardHeader title="Игроки" count={128} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Игроки' })).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('renders a zero count rather than hiding it', () => {
    render(<CardHeader title="Жалобы" count={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('omits the count slot entirely when no count is given', () => {
    render(<CardHeader title="Жалобы" />);
    expect(screen.getByRole('heading', { level: 2 }).parentElement?.children).toHaveLength(1);
  });

  it('renders the description and the actions', () => {
    render(
      <CardHeader
        title="Серверы"
        description="Обновлено минуту назад"
        actions={<button type="button">Обновить</button>}
      />,
    );
    expect(screen.getByText('Обновлено минуту назад')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeInTheDocument();
  });

  it('renders rich nodes passed as title, count and description', () => {
    render(
      <CardHeader
        title={<span>Онлайн</span>}
        count={<span>42/100</span>}
        description={<em>по данным моста</em>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Онлайн' })).toBeInTheDocument();
    expect(screen.getByText('42/100')).toBeInTheDocument();
    expect(screen.getByText('по данным моста')).toBeInTheDocument();
  });
});

describe('CardBody and CardFooter', () => {
  it('render their children', () => {
    render(
      <Card padding="none">
        <CardHeader title="Роль" />
        <CardBody>тело карточки</CardBody>
        <CardFooter>
          <button type="button">Отмена</button>
          <button type="button">Сохранить</button>
        </CardFooter>
      </Card>,
    );
    expect(screen.getByText('тело карточки')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();
  });

  it('keeps the footer buttons in source order, confirming action last', () => {
    render(
      <CardFooter>
        <button type="button">Отмена</button>
        <button type="button">Сохранить</button>
      </CardFooter>,
    );
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Отмена', 'Сохранить']);
  });
});

describe('CardGrid', () => {
  it('lays every child out as a direct grid item', () => {
    const { container } = render(
      <CardGrid cols={3}>
        <Card>раз</Card>
        <Card>два</Card>
        <Card>три</Card>
      </CardGrid>,
    );
    const grid = container.firstElementChild;
    expect(grid?.children).toHaveLength(3);
    expect(grid).toHaveTextContent('раз');
    expect(grid).toHaveTextContent('два');
    expect(grid).toHaveTextContent('три');
  });

  it('accepts every supported column count without changing the child count', () => {
    for (const cols of [2, 3, 4] as const) {
      const { container, unmount } = render(
        <CardGrid cols={cols}>
          <Card>a</Card>
          <Card>b</Card>
        </CardGrid>,
      );
      expect(container.firstElementChild?.children).toHaveLength(2);
      unmount();
    }
  });
});
