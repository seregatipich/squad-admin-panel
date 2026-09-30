import { describe, expect, it } from 'vitest';
import { banStatusBadge, foundBadgeLabel, trustLevelLabel } from './external-bans';

describe('foundBadgeLabel', () => {
  it('renders the green "not found" phrase for n=0', () => {
    expect(foundBadgeLabel(0)).toBe('Не найден во внешних банлистах');
  });

  it('uses singular declension for n=1', () => {
    expect(foundBadgeLabel(1)).toBe('Найден в 1 внешнем банлисте');
  });

  it('uses plural declension for n=2', () => {
    expect(foundBadgeLabel(2)).toBe('Найден в 2 внешних банлистах');
  });

  it('uses plural declension for n=5', () => {
    expect(foundBadgeLabel(5)).toBe('Найден в 5 внешних банлистах');
  });

  it('uses plural declension for n=11 (the "11" exception)', () => {
    expect(foundBadgeLabel(11)).toBe('Найден в 11 внешних банлистах');
  });

  it('uses singular declension for n=21 (last digit 1, not 11)', () => {
    expect(foundBadgeLabel(21)).toBe('Найден в 21 внешнем банлисте');
  });

  it('treats negative counts the same as zero', () => {
    expect(foundBadgeLabel(-1)).toBe('Не найден во внешних банлистах');
  });
});

describe('banStatusBadge', () => {
  it('renders "Перманентный" for an active permanent ban', () => {
    expect(banStatusBadge({ is_active: true, is_permanent: true }).label).toBe('Перманентный');
  });

  it('renders "Временный" for an active temporary ban', () => {
    expect(banStatusBadge({ is_active: true, is_permanent: false }).label).toBe('Временный');
  });

  it('renders "Неактивен" for an expired ban', () => {
    expect(banStatusBadge({ is_active: false, is_permanent: false }).label).toBe('Неактивен');
  });

  it('renders "Неактивен" for a revoked permanent ban', () => {
    expect(banStatusBadge({ is_active: false, is_permanent: true }).label).toBe('Неактивен');
  });
});

describe('trustLevelLabel', () => {
  it('maps trusted/normal/low to Russian labels', () => {
    expect(trustLevelLabel('trusted')).toBe('Доверенный');
    expect(trustLevelLabel('normal')).toBe('Обычный');
    expect(trustLevelLabel('low')).toBe('Низкий');
  });

  it('falls back to the raw value for an unknown level', () => {
    expect(trustLevelLabel('mystery')).toBe('mystery');
  });
});
