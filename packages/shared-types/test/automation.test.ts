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
});
