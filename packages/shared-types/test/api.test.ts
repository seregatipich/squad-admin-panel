import { describe, expect, it } from 'vitest';
import {
  auditEntry,
  bridgeStatus,
  externalServerConnectionUpdate,
  externalServerCreateInput,
  hostInfo,
  hostMetrics,
  logSourceStatusKey,
  logSourceUpsertInput,
  paginated,
  playerRow,
  remoteLogPath,
  serverCreateInput,
  serverRow,
  serverRuntime,
  serverStatus,
  uuidString,
} from '../src/api.js';

const VALID_UUID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c4';
const ISO = '2026-04-23T11:20:00.000Z';

describe('uuidString', () => {
  it('accepts a v7 UUID', () => {
    expect(uuidString.safeParse(VALID_UUID).success).toBe(true);
  });

  it('rejects an obvious non-uuid', () => {
    expect(uuidString.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(uuidString.safeParse(42).success).toBe(false);
  });
});

describe('hostInfo', () => {
  const valid = {
    hostname: 'box-01',
    os_name: 'Ubuntu',
    os_version: '24.04',
    kernel: '6.8.0-110-generic',
    arch: 'x86_64',
    cpu_model: 'AMD Ryzen 9 7950X',
    cpu_cores: 16,
    ram_total_bytes: 67_108_864_000,
  };

  it('accepts a fully-populated host info', () => {
    expect(hostInfo.safeParse(valid).success).toBe(true);
  });

  it('rejects cpu_cores = 0 (must be positive)', () => {
    expect(hostInfo.safeParse({ ...valid, cpu_cores: 0 }).success).toBe(false);
  });

  it('rejects negative ram_total_bytes', () => {
    expect(hostInfo.safeParse({ ...valid, ram_total_bytes: -1 }).success).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(hostInfo.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('rejects missing required keys', () => {
    const { hostname: _omit, ...rest } = valid;
    void _omit;
    expect(hostInfo.safeParse(rest).success).toBe(false);
  });
});

describe('hostMetrics', () => {
  const valid = {
    cpu_percent: 27.5,
    ram_used_bytes: 1024,
    ram_total_bytes: 2048,
    disk_used_bytes: 100,
    disk_total_bytes: 1000,
    net_rx_bytes_per_sec: 0,
    net_tx_bytes_per_sec: 0,
    sampled_at: ISO,
  };

  it('accepts a full metrics row', () => {
    expect(hostMetrics.safeParse(valid).success).toBe(true);
  });

  it('rejects cpu_percent above 100', () => {
    expect(hostMetrics.safeParse({ ...valid, cpu_percent: 100.1 }).success).toBe(false);
  });

  it('rejects cpu_percent below 0', () => {
    expect(hostMetrics.safeParse({ ...valid, cpu_percent: -0.1 }).success).toBe(false);
  });

  it('rejects ram_total_bytes = 0', () => {
    expect(hostMetrics.safeParse({ ...valid, ram_total_bytes: 0 }).success).toBe(false);
  });

  it('rejects non-datetime sampled_at', () => {
    expect(hostMetrics.safeParse({ ...valid, sampled_at: 'yesterday' }).success).toBe(false);
  });
});

describe('bridgeStatus', () => {
  it('accepts connected = true with version + uptime', () => {
    const v = { connected: true, version: '0.1.0', uptime_seconds: 60, last_error: null };
    expect(bridgeStatus.safeParse(v).success).toBe(true);
  });

  it('accepts disconnected with last_error filled', () => {
    const v = { connected: false, version: null, uptime_seconds: null, last_error: 'EPIPE' };
    expect(bridgeStatus.safeParse(v).success).toBe(true);
  });

  it('rejects negative uptime', () => {
    const v = { connected: true, version: 'x', uptime_seconds: -1, last_error: null };
    expect(bridgeStatus.safeParse(v).success).toBe(false);
  });
});

describe('serverStatus', () => {
  it.each([
    ['pending'],
    ['installing'],
    ['ready'],
    ['starting'],
    ['running'],
    ['stopping'],
    ['stopped'],
    ['failed'],
  ])('accepts %s', (s) => {
    expect(serverStatus.safeParse(s).success).toBe(true);
  });

  it('rejects unknown status', () => {
    expect(serverStatus.safeParse('paused').success).toBe(false);
  });
});

describe('serverCreateInput', () => {
  const minimal = {
    display_name: 'Squad Box',
    slug: 'squad-box',
    game_port: 7787,
    query_port: 27_165,
    beacon_port: 15_000,
    rcon_port: 21_114,
  };

  it('accepts a minimal input and applies defaults', () => {
    const parsed = serverCreateInput.parse(minimal);
    expect(parsed.multihome).toBe('0.0.0.0');
    expect(parsed.max_players).toBe(100);
    expect(parsed.tickrate).toBe(50);
    expect(parsed.extra_args).toBe('');
  });

  it('accepts every optional cgroup tuning knob', () => {
    const v = {
      ...minimal,
      description: 'long-form text',
      launch_args_override: '+sm_clean=1',
      cpu_affinity: '0-3',
      cpu_weight: 5_000,
      niceness: -5,
      memory_high_mb: 8_192,
      memory_max_mb: 16_384,
      io_weight: 100,
    };
    expect(serverCreateInput.safeParse(v).success).toBe(true);
  });

  it('accepts description = null', () => {
    expect(serverCreateInput.safeParse({ ...minimal, description: null }).success).toBe(true);
  });

  it('rejects display_name longer than 120 chars', () => {
    expect(serverCreateInput.safeParse({ ...minimal, display_name: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('rejects display_name shorter than 1 char', () => {
    expect(serverCreateInput.safeParse({ ...minimal, display_name: '' }).success).toBe(false);
  });

  it('rejects slug starting with hyphen', () => {
    expect(serverCreateInput.safeParse({ ...minimal, slug: '-bad' }).success).toBe(false);
  });

  it('rejects slug with uppercase', () => {
    expect(serverCreateInput.safeParse({ ...minimal, slug: 'BadSlug' }).success).toBe(false);
  });

  it('rejects ports below 1024 (privileged)', () => {
    expect(serverCreateInput.safeParse({ ...minimal, game_port: 80 }).success).toBe(false);
  });

  it('rejects ports above 65535', () => {
    expect(serverCreateInput.safeParse({ ...minimal, query_port: 70_000 }).success).toBe(false);
  });

  it('rejects max_players = 0', () => {
    expect(serverCreateInput.safeParse({ ...minimal, max_players: 0 }).success).toBe(false);
  });

  it('rejects tickrate above 120', () => {
    expect(serverCreateInput.safeParse({ ...minimal, tickrate: 121 }).success).toBe(false);
  });

  it('rejects tickrate below 10', () => {
    expect(serverCreateInput.safeParse({ ...minimal, tickrate: 9 }).success).toBe(false);
  });

  it('rejects niceness above 19', () => {
    expect(serverCreateInput.safeParse({ ...minimal, niceness: 20 }).success).toBe(false);
  });

  it('rejects niceness below -20', () => {
    expect(serverCreateInput.safeParse({ ...minimal, niceness: -21 }).success).toBe(false);
  });

  it('rejects cpu_weight above 10000', () => {
    expect(serverCreateInput.safeParse({ ...minimal, cpu_weight: 10_001 }).success).toBe(false);
  });

  it('rejects memory_max_mb = 0', () => {
    expect(serverCreateInput.safeParse({ ...minimal, memory_max_mb: 0 }).success).toBe(false);
  });

  it('rejects io_weight below 1', () => {
    expect(serverCreateInput.safeParse({ ...minimal, io_weight: 0 }).success).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(serverCreateInput.safeParse({ ...minimal, hax: true }).success).toBe(false);
  });

  it('rejects description longer than 500', () => {
    expect(serverCreateInput.safeParse({ ...minimal, description: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});

describe('serverRow', () => {
  const row = {
    id: VALID_UUID,
    display_name: 'Squad Box',
    slug: 'squad-box',
    description: null,
    status: 'running' as const,
    tags: ['eu', 'official'],
    game_port: 7787,
    query_port: 27_165,
    beacon_port: 15_000,
    rcon_port: 21_114,
    max_players: 100,
    tickrate: 50,
    multihome: '0.0.0.0',
    created_at: ISO,
    updated_at: ISO,
  };

  it('accepts a complete row', () => {
    expect(serverRow.safeParse(row).success).toBe(true);
  });

  it('applies tags = [] default when omitted', () => {
    const { tags: _omit, ...rest } = row;
    void _omit;
    const parsed = serverRow.parse(rest);
    expect(parsed.tags).toEqual([]);
  });

  it('rejects bad uuid', () => {
    expect(serverRow.safeParse({ ...row, id: 'nope' }).success).toBe(false);
  });

  it('rejects bad status enum', () => {
    expect(serverRow.safeParse({ ...row, status: 'paused' }).success).toBe(false);
  });
});

describe('playerRow', () => {
  const p = {
    steam_id64: '76561198012345678',
    canonical_name: 'PlayerOne',
    eos_id: 'abcdef0123456789abcdef0123456789',
    first_seen_at: ISO,
    last_seen_at: ISO,
    total_time_played_seconds: 0,
    is_online: true,
  };

  it('accepts a complete row', () => {
    expect(playerRow.safeParse(p).success).toBe(true);
  });

  it('accepts is_online omitted', () => {
    const { is_online: _omit, ...rest } = p;
    void _omit;
    expect(playerRow.safeParse(rest).success).toBe(true);
  });

  it('accepts eos_id = null (Steam-only history)', () => {
    expect(playerRow.safeParse({ ...p, eos_id: null }).success).toBe(true);
  });

  it('rejects 16-digit steam_id64', () => {
    expect(playerRow.safeParse({ ...p, steam_id64: '7656119801234567' }).success).toBe(false);
  });

  it('rejects negative total_time_played_seconds', () => {
    expect(playerRow.safeParse({ ...p, total_time_played_seconds: -1 }).success).toBe(false);
  });
});

describe('auditEntry', () => {
  const e = {
    id: '42',
    created_at: ISO,
    actor_user_id: VALID_UUID,
    actor_display_name: 'admin',
    actor_ip: '203.0.113.10',
    actor_kind: 'user' as const,
    action_type: 'server.create',
    target_type: 'server',
    target_id: VALID_UUID,
    status_code: 201,
    duration_ms: 14,
  };

  it('accepts a fully-populated entry', () => {
    expect(auditEntry.safeParse(e).success).toBe(true);
  });

  it('accepts a system actor with nulls', () => {
    const sys = {
      ...e,
      actor_user_id: null,
      actor_display_name: null,
      actor_ip: null,
      actor_kind: 'system' as const,
      target_type: null,
      target_id: null,
      status_code: null,
      duration_ms: null,
    };
    expect(auditEntry.safeParse(sys).success).toBe(true);
  });

  it('accepts external actor_kind', () => {
    expect(auditEntry.safeParse({ ...e, actor_kind: 'external' }).success).toBe(true);
  });

  it('rejects unknown actor_kind', () => {
    expect(auditEntry.safeParse({ ...e, actor_kind: 'bot' }).success).toBe(false);
  });

  it('rejects bad uuid in actor_user_id', () => {
    expect(auditEntry.safeParse({ ...e, actor_user_id: 'nope' }).success).toBe(false);
  });
});

describe('paginated', () => {
  it('parses items + pagination metadata', () => {
    const schema = paginated(playerRow);
    const parsed = schema.parse({
      items: [
        {
          steam_id64: '76561198012345678',
          canonical_name: 'PlayerOne',
          eos_id: null,
          first_seen_at: ISO,
          last_seen_at: ISO,
          total_time_played_seconds: 0,
        },
      ],
      total: 1,
      page: 1,
      page_size: 25,
    });
    expect(parsed.total).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });

  it('rejects page = 0 (must be positive)', () => {
    const schema = paginated(playerRow);
    expect(schema.safeParse({ items: [], total: 0, page: 0, page_size: 25 }).success).toBe(false);
  });

  it('rejects negative total', () => {
    const schema = paginated(playerRow);
    expect(schema.safeParse({ items: [], total: -1, page: 1, page_size: 25 }).success).toBe(false);
  });

  it('rejects page_size = 0', () => {
    const schema = paginated(playerRow);
    expect(schema.safeParse({ items: [], total: 0, page: 1, page_size: 0 }).success).toBe(false);
  });

  it('rejects strict additional keys', () => {
    const schema = paginated(playerRow);
    expect(
      schema.safeParse({
        items: [],
        total: 0,
        page: 1,
        page_size: 25,
        cursor: 'abc',
      }).success,
    ).toBe(false);
  });

  it('rejects items that fail the inner schema', () => {
    const schema = paginated(playerRow);
    expect(
      schema.safeParse({
        items: [{ steam_id64: 'short' }],
        total: 1,
        page: 1,
        page_size: 25,
      }).success,
    ).toBe(false);
  });
});

describe('serverRuntime', () => {
  it('accepts the two hosting modes and nothing else', () => {
    expect(serverRuntime.safeParse('container').success).toBe(true);
    expect(serverRuntime.safeParse('external').success).toBe(true);
    expect(serverRuntime.safeParse('systemd').success).toBe(false);
  });
});

describe('externalServerCreateInput', () => {
  const minimal = {
    display_name: 'RAAS/AAS #1',
    slug: 'raas-1',
    rcon_host: '203.0.113.10',
    rcon_port: 21_114,
    rcon_password: 's3cret',
    query_port: 27_165,
  };

  it('accepts a minimal input and applies defaults', () => {
    const parsed = externalServerCreateInput.parse(minimal);
    expect(parsed.game_port).toBe(7787);
    expect(parsed.max_players).toBe(100);
    expect(parsed.rcon_host).toBe('203.0.113.10');
  });

  it('accepts a hostname and an IPv6 literal as rcon_host', () => {
    expect(
      externalServerCreateInput.safeParse({ ...minimal, rcon_host: 'squad.example.org' }).success,
    ).toBe(true);
    expect(
      externalServerCreateInput.safeParse({ ...minimal, rcon_host: '[2001:db8::1]' }).success,
    ).toBe(true);
  });

  it('rejects a host with a scheme, port suffix or whitespace', () => {
    for (const rcon_host of ['tcp://1.2.3.4', 'host name', '', ' ']) {
      expect(externalServerCreateInput.safeParse({ ...minimal, rcon_host }).success).toBe(false);
    }
  });

  it('requires the RCON password — there is no container to generate one for', () => {
    const { rcon_password: _omitted, ...withoutPassword } = minimal;
    expect(externalServerCreateInput.safeParse(withoutPassword).success).toBe(false);
    expect(externalServerCreateInput.safeParse({ ...minimal, rcon_password: '' }).success).toBe(
      false,
    );
  });

  it('rejects container-only knobs (strict object)', () => {
    expect(externalServerCreateInput.safeParse({ ...minimal, beacon_port: 15_000 }).success).toBe(
      false,
    );
    expect(externalServerCreateInput.safeParse({ ...minimal, cpu_affinity: '0-3' }).success).toBe(
      false,
    );
  });
});

describe('externalServerConnectionUpdate', () => {
  it('accepts a partial update and keeps the password optional', () => {
    expect(externalServerConnectionUpdate.safeParse({ rcon_port: 21_115 }).success).toBe(true);
    expect(
      externalServerConnectionUpdate.safeParse({ rcon_host: '198.51.100.7', rcon_password: 'x' })
        .success,
    ).toBe(true);
  });

  it('rejects an empty body — nothing to change', () => {
    expect(externalServerConnectionUpdate.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(externalServerConnectionUpdate.safeParse({ slug: 'x' }).success).toBe(false);
  });
});

describe('logSourceUpsertInput / remoteLogPath', () => {
  const minimal = {
    ssh_host: '203.0.113.10',
    ssh_user: 'squad',
    log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
  };

  it('accepts a minimal input and applies defaults', () => {
    const parsed = logSourceUpsertInput.parse(minimal);
    expect(parsed.ssh_port).toBe(22);
    expect(parsed.enabled).toBe(true);
    expect(parsed.regenerate_key).toBe(false);
  });

  it('refuses paths that could escape the exec argument or the directory', () => {
    for (const log_path of [
      'relative/SquadGame.log',
      "/opt/squad1/'; rm -rf /; '",
      '/opt/squad1/../../etc/shadow',
      '/opt/squad 1/SquadGame.log',
      '/opt/squad1/SquadGame.log;id',
    ]) {
      expect(remoteLogPath.safeParse(log_path).success, log_path).toBe(false);
      expect(logSourceUpsertInput.safeParse({ ...minimal, log_path }).success, log_path).toBe(
        false,
      );
    }
    expect(remoteLogPath.safeParse('/home/squad/logs/squad/1/SquadGame_2.log').success).toBe(true);
  });

  it('rejects a user name with shell characters and unknown fields', () => {
    expect(logSourceUpsertInput.safeParse({ ...minimal, ssh_user: 'squad;id' }).success).toBe(
      false,
    );
    expect(logSourceUpsertInput.safeParse({ ...minimal, private_key: 'x' }).success).toBe(false);
  });

  it('derives the status key from the server id', () => {
    expect(logSourceStatusKey('srv-1')).toBe('log-source:status:srv-1');
  });
});
