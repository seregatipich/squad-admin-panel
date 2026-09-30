// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeExternalLink } from './SafeExternalLink';

afterEach(cleanup);

describe('SafeExternalLink', () => {
  it('renders an anchor for an http(s) URL', () => {
    render(<SafeExternalLink href="https://example.com/clip" />);
    const link = screen.getByRole('link', { name: 'https://example.com/clip' });
    expect(link).toHaveAttribute('href', 'https://example.com/clip');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders plain text, not a link, for a javascript: URL (#445)', () => {
    const evil = 'javascript:alert(document.cookie)';
    render(<SafeExternalLink href={evil} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(evil)).toBeInTheDocument();
  });

  it('renders plain text for a data: URL', () => {
    render(<SafeExternalLink href="data:text/html,<script>alert(1)</script>" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('accepts custom children instead of echoing the raw href', () => {
    render(<SafeExternalLink href="https://example.com">Ссылка</SafeExternalLink>);
    expect(screen.getByRole('link', { name: 'Ссылка' })).toBeInTheDocument();
  });
});
