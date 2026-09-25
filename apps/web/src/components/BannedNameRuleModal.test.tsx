// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BanNickButton, BannedNameRuleModal } from './BannedNameRuleModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetchOk(rule: Record<string, unknown> = { id: 'rule-1', pattern: 'x' }) {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(rule), { status: 201 })),
  );
}

describe('BannedNameRuleModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <BannedNameRuleModal open={false} onClose={() => {}} onSaved={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('prefills the pattern and match type from `initial` (2-click quick-add)', () => {
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'BadNick', match_type: 'exact' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const patternInput = screen.getByLabelText(/паттерн/i) as HTMLInputElement;
    expect(patternInput.value).toBe('BadNick');
    const matchTypeSelect = screen.getByLabelText(/тип матчинга/i) as HTMLSelectElement;
    expect(matchTypeSelect.value).toBe('exact');
  });

  it('the prefilled pattern stays editable', () => {
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'BadNick', match_type: 'exact' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const patternInput = screen.getByLabelText(/паттерн/i) as HTMLInputElement;
    fireEvent.change(patternInput, { target: { value: 'EvenWorseNick' } });
    expect(patternInput.value).toBe('EvenWorseNick');
  });

  it('submits a POST with the expected body and calls onSaved', async () => {
    const fetchMock = mockFetchOk({ id: 'rule-new', pattern: 'BadNick' });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'BadNick', match_type: 'exact' }}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /добавить/i }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ id: 'rule-new', pattern: 'BadNick' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/banned-names',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      pattern: 'BadNick',
      match_type: 'exact',
      action: 'kick',
      reason: null,
      is_active: true,
    });
  });

  it('submits a PATCH when editingId is set', async () => {
    const fetchMock = mockFetchOk({ id: 'rule-1', pattern: 'Edited' });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BannedNameRuleModal
        open
        editingId="rule-1"
        initial={{ pattern: 'Edited', match_type: 'exact' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /сохранить/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/banned-names/rule-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('disables submit and shows an error for an invalid regex pattern', () => {
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: '(unterminated', match_type: 'regex' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /добавить/i })).toBeDisabled();
  });

  it('closes on Escape — the window is a native <dialog>, not a hand-rolled overlay', () => {
    const onClose = vi.fn();
    const { container } = render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'BadNick' }}
        onClose={onClose}
        onSaved={() => {}}
      />,
    );
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('Окно не отрисовало <dialog>');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes through the dialog close control', () => {
    const onClose = vi.fn();
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'BadNick' }}
        onClose={onClose}
        onSaved={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окно' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the server error detail on a 409/422 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'rule_already_exists' }), { status: 409 }),
        ),
      ),
    );
    render(
      <BannedNameRuleModal
        open
        initial={{ pattern: 'Dupe', match_type: 'exact' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /добавить/i }));
    expect(await screen.findByText(/rule_already_exists/i)).toBeInTheDocument();
  });
});

describe('BanNickButton', () => {
  it('renders nothing without the ban permission', () => {
    const { container } = render(<BanNickButton nick="Someone" canBan={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the prefilled modal on click and closes it on save', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ id: 'rule-x', pattern: 'Someone' }));
    render(<BanNickButton nick="Someone" canBan />);
    fireEvent.click(screen.getByRole('button', { name: /забанить ник/i }));
    const patternInput = (await screen.findByLabelText(/паттерн/i)) as HTMLInputElement;
    expect(patternInput.value).toBe('Someone');

    fireEvent.click(screen.getByRole('button', { name: /добавить/i }));
    await waitFor(() => expect(screen.queryByLabelText(/паттерн/i)).not.toBeInTheDocument());
  });
});
