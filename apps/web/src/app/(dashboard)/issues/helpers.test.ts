import { describe, expect, it } from 'vitest';
import type { IssueComment, IssueView } from '@/lib/live-bus';
import {
  appendComment,
  authorLabel,
  buildApiQuery,
  buildQueryString,
  issueMatchesFilters,
  parseFilters,
  removeIssue,
  totalPages,
  upsertIssue,
  validateCreateForm,
} from './helpers';

function makeIssue(overrides: Partial<IssueView> = {}): IssueView {
  return {
    id: overrides.id ?? 'issue-1',
    number: overrides.number ?? 1,
    title: overrides.title ?? 'Title',
    body: overrides.body ?? 'Body',
    state: overrides.state ?? 'open',
    author_player_id: overrides.author_player_id ?? 'author-1',
    assignee_player_id: overrides.assignee_player_id ?? null,
    author: overrides.author ?? { id: 'author-1', name: 'Author' },
    assignee: overrides.assignee ?? null,
    labels: overrides.labels ?? [],
    created_at: overrides.created_at ?? '2026-07-04T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-07-04T00:00:00.000Z',
    closed_at: overrides.closed_at ?? null,
  };
}

describe('parseFilters', () => {
  it('reads a full filter set from URL params', () => {
    const params = new URLSearchParams('state=in_progress&label=bug&assignee=abc&q=crash&page=3');
    expect(parseFilters(params)).toEqual({
      state: 'in_progress',
      label: 'bug',
      assignee: 'abc',
      q: 'crash',
      page: 3,
    });
  });

  it('falls back to defaults for missing/invalid values', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual({
      state: '',
      label: '',
      assignee: '',
      q: '',
      page: 1,
    });
    expect(parseFilters(new URLSearchParams('state=bogus&page=0')).state).toBe('');
    expect(parseFilters(new URLSearchParams('page=-2')).page).toBe(1);
  });
});

describe('buildQueryString / buildApiQuery (deep-link)', () => {
  it('omits defaults from the deep-link URL', () => {
    expect(buildQueryString({ state: '', label: '', assignee: '', q: '', page: 1 })).toBe('');
  });

  it('round-trips filters through the URL', () => {
    const filters = { state: 'closed' as const, label: 'bug', assignee: 'p1', q: 'net', page: 2 };
    const parsed = parseFilters(new URLSearchParams(buildQueryString(filters)));
    expect(parsed).toEqual(filters);
  });

  it('always includes page and per_page in the API query', () => {
    const query = buildApiQuery({ state: 'open', label: '', assignee: '', q: '', page: 2 }, 20);
    const params = new URLSearchParams(query);
    expect(params.get('state')).toBe('open');
    expect(params.get('page')).toBe('2');
    expect(params.get('per_page')).toBe('20');
  });
});

describe('totalPages', () => {
  it('computes page count and never returns zero', () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(20)).toBe(1);
    expect(totalPages(21)).toBe(2);
    expect(totalPages(41)).toBe(3);
  });
});

describe('validateCreateForm', () => {
  it('rejects empty title and body', () => {
    expect(validateCreateForm({ title: '  ', body: 'x', labelCount: 0 })).toEqual({
      ok: false,
      error: 'Введите заголовок тикета.',
    });
    expect(validateCreateForm({ title: 'x', body: '  ', labelCount: 0 })).toEqual({
      ok: false,
      error: 'Введите описание тикета.',
    });
  });

  it('rejects over-limit title, body and labels', () => {
    expect(validateCreateForm({ title: 'a'.repeat(201), body: 'x', labelCount: 0 }).ok).toBe(false);
    expect(validateCreateForm({ title: 'x', body: 'a'.repeat(4001), labelCount: 0 }).ok).toBe(
      false,
    );
    expect(validateCreateForm({ title: 'x', body: 'y', labelCount: 21 }).ok).toBe(false);
  });

  it('accepts a valid form', () => {
    expect(validateCreateForm({ title: 'Bug', body: 'Steps', labelCount: 2 })).toEqual({
      ok: true,
    });
  });
});

describe('issueMatchesFilters', () => {
  it('matches by state, assignee and label', () => {
    const issue = makeIssue({
      state: 'open',
      assignee_player_id: 'p1',
      labels: [{ id: 'l1', name: 'bug', color: '#dc2626' }],
    });
    expect(
      issueMatchesFilters(issue, { state: 'open', label: '', assignee: '', q: '', page: 1 }),
    ).toBe(true);
    expect(
      issueMatchesFilters(issue, { state: 'closed', label: '', assignee: '', q: '', page: 1 }),
    ).toBe(false);
    expect(
      issueMatchesFilters(issue, { state: '', label: 'bug', assignee: '', q: '', page: 1 }),
    ).toBe(true);
    expect(
      issueMatchesFilters(issue, { state: '', label: 'question', assignee: '', q: '', page: 1 }),
    ).toBe(false);
    expect(
      issueMatchesFilters(issue, { state: '', label: '', assignee: 'p1', q: '', page: 1 }),
    ).toBe(true);
    expect(
      issueMatchesFilters(issue, { state: '', label: '', assignee: 'p2', q: '', page: 1 }),
    ).toBe(false);
  });
});

describe('upsertIssue / removeIssue', () => {
  it('prepends unseen issues and replaces existing ones in place', () => {
    const first = makeIssue({ id: 'a', number: 1 });
    const second = makeIssue({ id: 'b', number: 2 });
    const list = [second, first];
    const fresh = makeIssue({ id: 'c', number: 3 });
    expect(upsertIssue(list, fresh).map((i) => i.id)).toEqual(['c', 'b', 'a']);

    const editedFirst = makeIssue({ id: 'a', number: 1, state: 'closed' });
    const replaced = upsertIssue(list, editedFirst);
    expect(replaced.map((i) => i.id)).toEqual(['b', 'a']);
    expect(replaced.find((i) => i.id === 'a')?.state).toBe('closed');
  });

  it('removes by id', () => {
    const list = [makeIssue({ id: 'a' }), makeIssue({ id: 'b' })];
    expect(removeIssue(list, 'a').map((i) => i.id)).toEqual(['b']);
  });
});

describe('appendComment', () => {
  function makeComment(id: string): IssueComment {
    return {
      id,
      issue_id: 'issue-1',
      author_player_id: 'p1',
      author: { id: 'p1', name: 'P1' },
      body: 'text',
      created_at: '2026-07-04T00:00:00.000Z',
    };
  }
  it('appends new comments and dedupes by id', () => {
    const list = [makeComment('c1')];
    expect(appendComment(list, makeComment('c2')).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(appendComment(list, makeComment('c1'))).toBe(list);
  });
});

describe('authorLabel', () => {
  it('prefers the resolved name and falls back to a short id', () => {
    expect(authorLabel({ id: 'p1', name: 'Alice' }, 'p1')).toBe('Alice');
    expect(authorLabel(null, 'abcdefghijkl')).toBe('abcdefgh…');
  });
});
