// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SteamLoginLink } from './SteamLoginLink';

afterEach(cleanup);

describe('SteamLoginLink', () => {
  it('is a plain anchor to the Steam login endpoint, so the browser does a full navigation', () => {
    render(<SteamLoginLink>Войти через Steam</SteamLoginLink>);

    const link = screen.getByRole('link', { name: 'Войти через Steam' });
    expect(link).toHaveAttribute('href', '/api/v1/auth/steam/login');
    expect(link.tagName).toBe('A');
  });
});
