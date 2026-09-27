// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isSegmentActive, SegmentedNav, type SegmentedNavItem } from './SegmentedNav';

const ITEMS: SegmentedNavItem[] = [
  { href: '/servers/1', label: 'Обзор' },
  { href: '/servers/1/players', label: 'Игроки', badge: '48' },
  { href: '/servers/1/logs', label: 'Логи' },
];

afterEach(cleanup);

describe('isSegmentActive', () => {
  it('matches the segment own address exactly', () => {
    expect(isSegmentActive('/servers/1', '/servers/1')).toBe(true);
  });

  it('matches a page nested under the segment', () => {
    expect(isSegmentActive('/servers/1/logs/42', '/servers/1/logs')).toBe(true);
  });

  it('does not match a sibling that merely starts with the same characters', () => {
    expect(isSegmentActive('/servers/12', '/servers/1')).toBe(false);
    expect(isSegmentActive('/servers/12/logs', '/servers/1')).toBe(false);
  });

  it('does not match a parent of the segment', () => {
    expect(isSegmentActive('/servers', '/servers/1')).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(isSegmentActive('/dashboard', '/servers/1')).toBe(false);
  });
});

describe('SegmentedNav', () => {
  it('renders every item as a link inside a labelled nav', () => {
    render(<SegmentedNav items={ITEMS} pathname="/servers/1" ariaLabel="Разделы сервера" />);
    const nav = screen.getByRole('navigation', { name: 'Разделы сервера' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('href', '/servers/1');
    expect(screen.getByRole('link', { name: /Игроки/ })).toHaveAttribute(
      'href',
      '/servers/1/players',
    );
  });

  it('marks the index segment on its own exact address', () => {
    render(<SegmentedNav items={ITEMS} pathname="/servers/1" ariaLabel="Разделы сервера" />);
    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Игроки/ })).not.toHaveAttribute('aria-current');
  });

  it('marks the current page with aria-current and nothing else', () => {
    render(
      <SegmentedNav items={ITEMS} pathname="/servers/1/players" ariaLabel="Разделы сервера" />,
    );
    expect(screen.getByRole('link', { name: /Игроки/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Обзор' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Логи' })).not.toHaveAttribute('aria-current');
  });

  // The index segment prefix-matches every child; only the longest match wins.
  it('keeps a nested page inside its own segment only', () => {
    render(
      <SegmentedNav items={ITEMS} pathname="/servers/1/logs/42" ariaLabel="Разделы сервера" />,
    );
    expect(screen.getByRole('link', { name: 'Логи' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Обзор' })).not.toHaveAttribute('aria-current');
  });

  it('leaves every segment unmarked on a path that belongs to none of them', () => {
    render(<SegmentedNav items={ITEMS} pathname="/dashboard" ariaLabel="Разделы сервера" />);
    for (const link of screen.getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('renders the badge next to its label', () => {
    render(<SegmentedNav items={ITEMS} pathname="/servers/1" ariaLabel="Разделы сервера" />);
    expect(screen.getByRole('link', { name: /Игроки/ })).toHaveTextContent('48');
  });
});
