import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_CONDITION_TYPES,
  AUTOMATION_RUN_STATUSES,
  parseAutomationAction,
  parseAutomationCondition,
} from '../src/automation.js';

describe('automation enums', () => {
  it('declares the four condition and action types and run statuses', () => {
    expect(AUTOMATION_CONDITION_TYPES).toEqual([
      'chat_keyword',
      'player_count',
      'time_of_day',
      'player_flag',
    ]);
    expect(AUTOMATION_ACTION_TYPES).toEqual(['rcon_command', 'kick', 'warn', 'notify_admin']);
    expect(AUTOMATION_RUN_STATUSES).toContain('matched');
    expect(AUTOMATION_RUN_STATUSES).toContain('executed');
  });
});

describe('parseAutomationCondition', () => {
  it('accepts a valid config for each condition type', () => {
    expect(parseAutomationCondition('chat_keyword', { keyword: 'hi' }).success).toBe(true);
    expect(
      parseAutomationCondition('player_count', { operator: 'gte', threshold: 40 }).success,
    ).toBe(true);
    expect(
      parseAutomationCondition('time_of_day', {
        startMinute: 0,
        endMinute: 120,
        timezone: 'UTC',
      }).success,
    ).toBe(true);
    expect(parseAutomationCondition('player_flag', { flag: 'watched' }).success).toBe(true);
  });

  it('rejects an invalid config for each condition type', () => {
    expect(parseAutomationCondition('chat_keyword', { keyword: '' }).success).toBe(false);
    expect(parseAutomationCondition('player_count', { operator: 'nope' }).success).toBe(false);
    expect(
      parseAutomationCondition('time_of_day', { startMinute: -1, endMinute: 5000 }).success,
    ).toBe(false);
    expect(parseAutomationCondition('player_flag', {}).success).toBe(false);
  });
});

describe('parseAutomationAction', () => {
  it('accepts a valid config for each action type', () => {
    expect(
      parseAutomationAction('rcon_command', { command: 'AdminBroadcast', args: ['hi'] }).success,
    ).toBe(true);
    expect(parseAutomationAction('kick', { reason: 'afk' }).success).toBe(true);
    expect(parseAutomationAction('warn', { message: 'stop' }).success).toBe(true);
    expect(
      parseAutomationAction('notify_admin', { message: 'wake', channels: ['email'] }).success,
    ).toBe(true);
  });

  it('rejects an invalid config for each action type', () => {
    expect(parseAutomationAction('rcon_command', { command: 'NotACommand' }).success).toBe(false);
    expect(parseAutomationAction('warn', { message: '' }).success).toBe(false);
    expect(parseAutomationAction('notify_admin', { channels: ['carrier-pigeon'] }).success).toBe(
      false,
    );
  });

  // #53 (#1168): worker-rcon rejects `AdminKick <target> ''`, yet the rule was
  // saved and each firing recorded as executed.
  it.each([{}, { reason: '' }, { reason: '   ' }])('rejects a kick without a reason %j', (raw) => {
    expect(parseAutomationAction('kick', raw).success).toBe(false);
  });

  // #53 (#1168): worker-rcon demands an exact argument count per command.
  it.each([
    ['AdminBroadcast', []],
    ['AdminBroadcast', ['a', 'b']],
    ['AdminEndMatch', ['now']],
    ['AdminReloadServerConfig', ['x']],
    ['AdminChangeLayer', []],
    ['AdminSetNextLayer', ['a', 'b']],
    ['AdminWarn', ['76561198000000001']],
    ['AdminKick', ['76561198000000001']],
    ['AdminBan', ['76561198000000001', '0']],
    ['AdminBroadcast', ['   ']],
  ])('rejects %s with args %j (wrong count or blank)', (command, args) => {
    expect(parseAutomationAction('rcon_command', { command, args }).success).toBe(false);
  });

  it.each([
    ['AdminBroadcast', ['hello']],
    ['AdminEndMatch', []],
    ['AdminReloadServerConfig', []],
    ['AdminChangeLayer', ['Yehorivka RAAS v11']],
    ['AdminSetNextLayer', ['Yehorivka RAAS v11']],
    ['AdminWarn', ['76561198000000001', 'stop']],
    ['AdminKick', ['76561198000000001', 'afk']],
    ['AdminBan', ['76561198000000001', '0', 'cheating']],
  ])('accepts %s with exactly its argument count', (command, args) => {
    expect(parseAutomationAction('rcon_command', { command, args }).success).toBe(true);
  });
});

describe('time_of_day timezone (#53 #1177)', () => {
  it('accepts IANA zones and UTC', () => {
    for (const timezone of ['UTC', 'Europe/Moscow', 'America/New_York']) {
      expect(
        parseAutomationCondition('time_of_day', { startMinute: 0, endMinute: 60, timezone })
          .success,
      ).toBe(true);
    }
  });

  it('rejects an unknown timezone instead of saving a rule that never fires', () => {
    const result = parseAutomationCondition('time_of_day', {
      startMinute: 0,
      endMinute: 60,
      timezone: 'Europe/Moskow',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('unknown IANA timezone');
  });
});
