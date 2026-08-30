import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AccountNames,
  describeDevice,
  displayName,
  formatDay,
  formatPermissionCount,
  formatPreviousNamesCount,
  formatRelative,
  previousNames,
} from './helpers';

const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const OPERA_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/134.0.0.0';
const CLAUDE_ELECTRON_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.34493.1 Chrome/148.0.7778.280 Electron/42.9.2 Safari/537.36';
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const FIREFOX_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('describeDevice', () => {
  it('tells two browsers on the same platform apart', () => {
    // Регрессия: жадная `.*` в старой регулярке доедала строку до последней
    // скобки, и каждая сессия показывалась как «Mozilla/5.0 (KHTML, like
    // Gecko)» — колонка переставала различать устройства, ради чего она есть.
    expect(describeDevice(CHROME_LINUX)).toBe('Chrome 150 · Linux');
    expect(describeDevice(OPERA_LINUX)).toBe('Opera 134 · Linux');
    expect(describeDevice(CHROME_LINUX)).not.toBe(describeDevice(OPERA_LINUX));
  });

  it('names the embedding app for an Electron client, not its Chrome', () => {
    expect(describeDevice(CLAUDE_ELECTRON_LINUX)).toBe('Claude · Linux');
  });

  it('prefers the vendor token over the Chrome token it is built on', () => {
    expect(describeDevice(EDGE_WINDOWS)).toBe('Edge 120 · Windows');
  });

  it('recognises Firefox on macOS', () => {
    expect(describeDevice(FIREFOX_MAC)).toBe('Firefox 121 · macOS');
  });

  it('reads iOS before the “like Mac OS X” tail it contains', () => {
    expect(describeDevice(SAFARI_IOS)).toBe('Safari 17 · iOS');
  });

  it('reads Android before the Linux token it contains', () => {
    expect(describeDevice(CHROME_ANDROID)).toBe('Chrome 120 · Android');
  });

  it('falls back to the platform alone when no product token is present', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
  });

  it('shows a non-browser agent verbatim', () => {
    expect(describeDevice('mint-owner-session')).toBe('mint-owner-session');
  });

  it('truncates an unrecognised agent instead of stretching the column', () => {
    expect(describeDevice('x'.repeat(200))).toHaveLength(60);
  });

  it('renders a dash for a missing agent', () => {
    expect(describeDevice(null)).toBe('—');
    expect(describeDevice('')).toBe('—');
  });
});

describe('formatPermissionCount', () => {
  it('uses the singular for counts ending in one', () => {
    expect(formatPermissionCount(1)).toBe('1 ключ');
    expect(formatPermissionCount(21)).toBe('21 ключ');
  });

  it('uses the paucal for counts ending in two to four', () => {
    expect(formatPermissionCount(2)).toBe('2 ключа');
    expect(formatPermissionCount(4)).toBe('4 ключа');
    // Регрессия: на экране стояло «53 ключей» — форма была захардкожена.
    expect(formatPermissionCount(53)).toBe('53 ключа');
  });

  it('uses the plural for the teens and for counts ending in five to nine', () => {
    expect(formatPermissionCount(5)).toBe('5 ключей');
    expect(formatPermissionCount(11)).toBe('11 ключей');
    expect(formatPermissionCount(14)).toBe('14 ключей');
    expect(formatPermissionCount(0)).toBe('0 ключей');
  });
});

describe('formatRelative', () => {
  // Часы фиксируются: без этого «через 30 мин» превращается в «через 29 мин»,
  // стоит паре миллисекунд уйти между построением метки и вызовом.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a past moment as expired', () => {
    expect(formatRelative('2026-08-24T11:59:00.000Z')).toBe('истекла');
    expect(formatRelative('2026-08-24T12:00:00.000Z')).toBe('истекла');
  });

  it('counts minutes, hours and days ahead', () => {
    expect(formatRelative('2026-08-24T12:30:00.000Z')).toBe('через 30 мин');
    expect(formatRelative('2026-08-24T15:00:00.000Z')).toBe('через 3 ч');
    expect(formatRelative('2026-08-24T17:59:00.000Z')).toBe('через 5 ч 59 мин');
    expect(formatRelative('2026-08-26T14:00:00.000Z')).toBe('через 2 дн');
  });
});

function names(overrides: Partial<AccountNames> = {}): AccountNames {
  return { canonical_name: 'Bravo', persona_name: null, history: [], ...overrides };
}

function entry(name: string, lastSeen: string): AccountNames['history'][number] {
  return { name, first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: lastSeen };
}

describe('displayName', () => {
  it('prefers the in-game name', () => {
    expect(displayName(names({ canonical_name: 'Bravo', persona_name: 'SteamNick' }))).toBe(
      'Bravo',
    );
  });

  it('falls back to the Steam nickname when the in-game name is blank', () => {
    expect(displayName(names({ canonical_name: '   ', persona_name: 'SteamNick' }))).toBe(
      'SteamNick',
    );
  });

  it('renders a dash when neither name is known', () => {
    expect(displayName(names({ canonical_name: '', persona_name: null }))).toBe('—');
  });
});

describe('previousNames', () => {
  it('drops the name already shown in the header', () => {
    const result = previousNames(
      names({
        canonical_name: 'Bravo',
        history: [
          entry('Bravo', '2026-08-01T00:00:00.000Z'),
          entry('Alpha', '2026-06-01T00:00:00.000Z'),
        ],
      }),
    );
    expect(result.map((item) => item.name)).toEqual(['Alpha']);
  });

  it('keeps the order the endpoint sorted them in', () => {
    const result = previousNames(
      names({
        canonical_name: 'Bravo',
        history: [
          entry('Charlie', '2026-07-01T00:00:00.000Z'),
          entry('Alpha', '2026-06-01T00:00:00.000Z'),
        ],
      }),
    );
    expect(result.map((item) => item.name)).toEqual(['Charlie', 'Alpha']);
  });

  it('drops the Steam nickname too when it is the one on display', () => {
    const result = previousNames(
      names({
        canonical_name: '',
        persona_name: 'SteamNick',
        history: [
          entry('SteamNick', '2026-08-01T00:00:00.000Z'),
          entry('Alpha', '2026-06-01T00:00:00.000Z'),
        ],
      }),
    );
    expect(result.map((item) => item.name)).toEqual(['Alpha']);
  });
});

describe('formatPreviousNamesCount', () => {
  it('declines the noun the same way the permission counter does', () => {
    expect(formatPreviousNamesCount(1)).toBe('ещё 1 ник');
    expect(formatPreviousNamesCount(3)).toBe('ещё 3 ника');
    expect(formatPreviousNamesCount(7)).toBe('ещё 7 ников');
    expect(formatPreviousNamesCount(11)).toBe('ещё 11 ников');
    expect(formatPreviousNamesCount(22)).toBe('ещё 22 ника');
  });
});

describe('formatDay', () => {
  it('drops the time — the history is read by day, not by minute', () => {
    expect(formatDay('2026-08-01T13:45:00.000Z')).toBe('01.08.2026');
  });
});
