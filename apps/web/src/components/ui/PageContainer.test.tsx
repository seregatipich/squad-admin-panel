// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageContainer, type PageWidth } from './PageContainer';

afterEach(cleanup);

/** Ширина — это и есть поведение контейнера, поэтому здесь ассерт на класс. */
const EXPECTED_WIDTH: Record<PageWidth, string> = {
  full: 'max-w-[1600px]',
  wide: 'max-w-6xl',
  reading: 'max-w-3xl',
  form: 'max-w-xl',
};

describe('PageContainer', () => {
  it('renders its children', () => {
    render(
      <PageContainer>
        <p>содержимое</p>
      </PageContainer>,
    );
    expect(screen.getByText('содержимое')).toBeInTheDocument();
  });

  it('applies the max width of every variant', () => {
    for (const [width, expected] of Object.entries(EXPECTED_WIDTH) as [PageWidth, string][]) {
      const { container, unmount } = render(
        <PageContainer width={width}>
          <p>{width}</p>
        </PageContainer>,
      );
      expect(container.firstElementChild?.classList).toContain(expected);
      unmount();
    }
  });

  it('defaults to the full width', () => {
    const { container } = render(
      <PageContainer>
        <p>по умолчанию</p>
      </PageContainer>,
    );
    expect(container.firstElementChild?.classList).toContain(EXPECTED_WIDTH.full);
  });

  it('centres every variant but full, which the layout already centres', () => {
    const { container: full } = render(
      <PageContainer width="full">
        <p>full</p>
      </PageContainer>,
    );
    expect(full.firstElementChild?.classList).not.toContain('mx-auto');

    for (const width of ['wide', 'reading', 'form'] as const) {
      const { container, unmount } = render(
        <PageContainer width={width}>
          <p>{width}</p>
        </PageContainer>,
      );
      expect(container.firstElementChild?.classList).toContain('mx-auto');
      unmount();
    }
  });

  it('always spaces the page blocks and never adds vertical padding of its own', () => {
    const { container } = render(
      <PageContainer>
        <p>ритм</p>
      </PageContainer>,
    );
    const classes = Array.from(container.firstElementChild?.classList ?? []);
    expect(classes).toContain('w-full');
    expect(classes).toContain('space-y-6');
    expect(classes.filter((name) => /^p[ytb]-/.test(name))).toEqual([]);
  });

  it('keeps extra classes from the page alongside the width', () => {
    const { container } = render(
      <PageContainer width="form" className="pointer-events-none">
        <p>дополнение</p>
      </PageContainer>,
    );
    const classes = container.firstElementChild?.classList;
    expect(classes).toContain('pointer-events-none');
    expect(classes).toContain(EXPECTED_WIDTH.form);
  });
});
