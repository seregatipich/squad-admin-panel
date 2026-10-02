import { describe, expect, it } from 'vitest';
import { formatDateTimeRu } from '@/lib/format';
import { a2sView } from './a2s-view';

const AT = '2026-10-02T10:05:00.000Z';

describe('a2sView (#127)', () => {
  it('shows nothing before the first check', () => {
    expect(a2sView(null)).toBeNull();
    expect(a2sView(undefined)).toBeNull();
  });

  it('shows an answering server as good', () => {
    expect(a2sView({ visible: true, queried_at: AT, last_success_at: AT })).toEqual({
      state: 'good',
      label: 'отвечает',
      detail: null,
    });
  });

  it('shows no answer as a warning with the time of the last answer, not as hidden or critical', () => {
    const view = a2sView({ visible: null, reason: 'timeout', last_success_at: AT });
    expect(view).toEqual({
      state: 'warn',
      label: 'запрос не отвечает',
      detail: `последний ответ: ${formatDateTimeRu(AT)}`,
    });
  });

  it('says there was never an answer when there is no last success', () => {
    expect(a2sView({ visible: null, reason: 'timeout', last_success_at: null })?.detail).toBe(
      'ответов не было',
    );
    expect(a2sView({ visible: null, reason: 'refused_address' })?.detail).toBe('ответов не было');
  });

  it('treats the old worker timeout entry (visible:false, reason timeout) as no answer', () => {
    expect(a2sView({ visible: false, reason: 'timeout' })).toMatchObject({
      state: 'warn',
      label: 'запрос не отвечает',
    });
  });

  it('shows a server that answered and reports itself not visible as hidden', () => {
    expect(a2sView({ visible: false, last_success_at: AT })).toEqual({
      state: 'warn',
      label: 'скрыт в списке серверов',
      detail: null,
    });
  });
});
