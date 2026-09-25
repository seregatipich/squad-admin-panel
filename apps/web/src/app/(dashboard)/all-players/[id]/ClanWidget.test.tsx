// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClanWidget } from './ClanWidget';

afterEach(() => {
  cleanup();
});

describe('ClanWidget', () => {
  it('links to the clan and shows the member role label', () => {
    render(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: ['ALF'], member_role: 'deputy' }} />,
    );
    const link = screen.getByRole('link', { name: /Альфа/ });
    expect(link).toHaveAttribute('href', '/clans/clan-1');
    expect(link).toHaveTextContent('Зам');
  });

  it('renders leader and member role labels', () => {
    const { rerender } = render(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: [], member_role: 'leader' }} />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Глава');

    rerender(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: [], member_role: 'member' }} />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Участник');
  });

  it('renders nothing for a clanless player', () => {
    const { container } = render(<ClanWidget clan={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
