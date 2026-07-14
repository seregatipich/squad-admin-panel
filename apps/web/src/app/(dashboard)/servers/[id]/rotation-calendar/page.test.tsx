// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RotationCalendarPage from './page';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/rotation-schedule')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              entries: [],
              history: [],
              profiles: [],
              warnings: {},
              can_edit: true,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [{ name: 'Yehorivka RAAS v11' }] }), { status: 200 }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RotationCalendarPage', () => {
  it('renders the calendar and weekly profile planner for changemap users', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <RotationCalendarPage params={Promise.resolve({ id: 'server-1' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByTestId('rotation-calendar-grid')).toBeInTheDocument();
    expect(screen.getByTestId('rotation-profiles')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Добавить смену ротации' })).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Добавить профиль' })).toBeInTheDocument();
  });
});
