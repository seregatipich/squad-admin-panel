import { describe, expect, it } from 'vitest';
import {
  RCON_COMMAND_GROUP,
  RCON_COMMAND_RESULT_PREFIX,
  RCON_COMMAND_STREAM_PREFIX,
  RCON_OPERATOR_COMMANDS,
  rconCommandRequestSchema,
  rconCommandResultKey,
  rconCommandResultSchema,
  rconCommandStream,
} from '../src/rcon-commands.js';

describe('rcon command contract', () => {
  it('defines the worker stream, group and result keys', () => {
    expect(RCON_COMMAND_STREAM_PREFIX).toBe('rcon:commands:');
    expect(RCON_COMMAND_GROUP).toBe('worker-rcon:commands:v1');
    expect(RCON_COMMAND_RESULT_PREFIX).toBe('rcon:command-result:');
    expect(rconCommandStream('srv-1')).toBe('rcon:commands:srv-1');
    expect(rconCommandResultKey('req-1')).toBe('rcon:command-result:req-1');
  });

  it('allows only the whitelisted operator command names', () => {
    expect(RCON_OPERATOR_COMMANDS).toEqual([
      'AdminBan',
      'AdminBroadcast',
      'AdminEndMatch',
      'AdminKick',
      'AdminReloadServerConfig',
      'AdminWarn',
    ]);
    expect(
      rconCommandRequestSchema.safeParse({
        request_id: 'req-1',
        command: 'AdminKick',
        args: ['76561198000000001', 'Banned nickname'],
      }).success,
    ).toBe(true);
    expect(
      rconCommandRequestSchema.safeParse({
        request_id: 'req-1',
        command: 'AdminBan',
        args: ['76561198000000001', '0', 'Cheating'],
      }).success,
    ).toBe(true);
    expect(
      rconCommandRequestSchema.safeParse({
        request_id: 'req-1',
        command: 'AdminNuke',
        args: ['76561198000000001'],
      }).success,
    ).toBe(false);
  });

  it('validates request and result payloads used between API and worker', () => {
    expect(
      rconCommandRequestSchema.parse({
        request_id: 'req-1',
        command: 'AdminBroadcast',
        args: ['Server restart in 15 seconds'],
        actor_player_id: '76561198000000001',
        enqueued_at: '2026-07-07T12:00:00.000Z',
      }),
    ).toMatchObject({ command: 'AdminBroadcast' });

    expect(
      rconCommandResultSchema.parse({
        ok: true,
        server_id: 'srv-1',
        request_id: 'req-1',
        command: 'AdminBroadcast',
        response: 'sent',
        completed_at: '2026-07-07T12:00:01.000Z',
        duration_ms: 42,
      }),
    ).toMatchObject({ ok: true, response: 'sent' });
  });
});
