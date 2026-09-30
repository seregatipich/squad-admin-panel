import { describe, expect, it } from 'vitest';
import {
  externalConnectionResponse,
  externalServerConnectionUpdate,
  externalServerCreateInput,
  logSourceStatusKey,
  logSourceUpsertInput,
  logSourceView,
  remoteLogPath,
  seedingSettingsResponse,
  serverCreateInput,
  serverDetailResponse,
  serverRuntime,
  serverSettingsView,
  sidecarIntegrationResponse,
  uuidString,
} from '../src/api.js';

const VALID_UUID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c4';

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
  });

  it('accepts an IPv4 or IPv6 multihome literal (#52 finding 1170)', () => {
    for (const multihome of ['10.0.0.5', '0.0.0.0', '2001:db8::1']) {
      expect(serverCreateInput.safeParse({ ...minimal, multihome }).success, multihome).toBe(true);
    }
  });

  it('rejects a multihome that is not an IP literal, so no launch flag can ride along (#52 finding 1170)', () => {
    for (const multihome of ['0.0.0.0 -SomeFlag', 'host.example', '', '10.0.0.5/24']) {
      expect(serverCreateInput.safeParse({ ...minimal, multihome }).success, multihome).toBe(false);
    }
  });

  // #53 (#1169/#1186): the panel never applied these to the container, so an
  // operator setting e.g. a memory cap got a 200 and an unlimited server.
  it.each([
    ['extra_args', '-log'],
    ['launch_args_override', '+sm_clean=1'],
    ['cpu_affinity', '0-3'],
    ['cpu_weight', 5_000],
    ['niceness', -5],
    ['memory_high_mb', 8_192],
    ['memory_max_mb', 16_384],
    ['io_weight', 100],
  ])('rejects the never-applied launch/resource knob %s', (key, value) => {
    expect(serverCreateInput.safeParse({ ...minimal, [key]: value }).success).toBe(false);
  });

  it('still accepts the unset value of each knob (existing clients send the defaults)', () => {
    const v = {
      ...minimal,
      extra_args: '',
      launch_args_override: null,
      cpu_affinity: null,
      cpu_weight: null,
      niceness: null,
      memory_high_mb: null,
      memory_max_mb: null,
      io_weight: null,
    };
    expect(serverCreateInput.safeParse(v).success).toBe(true);
  });

  // #53 (#1187): multihome is interpolated into the Squad launch argv.
  it('accepts an IPv4 or IPv6 multihome address', () => {
    expect(serverCreateInput.safeParse({ ...minimal, multihome: '10.0.0.5' }).success).toBe(true);
    expect(serverCreateInput.safeParse({ ...minimal, multihome: '::' }).success).toBe(true);
  });

  it.each(['0.0.0.0 -ExecCmds=quit', 'example.com', '', '999.1.1.1'])(
    'rejects the non-IP multihome %j',
    (multihome) => {
      expect(serverCreateInput.safeParse({ ...minimal, multihome }).success).toBe(false);
    },
  );

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

  // #293: display_name is interpolated unescaped into Server.cfg's
  // `ServerName="${displayName}"` directive; a quote or newline lets a holder
  // of server:create/server:install inject arbitrary Server.cfg directives.
  it('rejects display_name containing a double quote', () => {
    expect(
      serverCreateInput.safeParse({ ...minimal, display_name: 'Box" \nMaxPlayers=1' }).success,
    ).toBe(false);
  });

  it('rejects display_name containing a newline', () => {
    expect(
      serverCreateInput.safeParse({ ...minimal, display_name: 'Box\nMaxPlayers=1' }).success,
    ).toBe(false);
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

  it('rejects unknown extra keys (strict)', () => {
    expect(serverCreateInput.safeParse({ ...minimal, hax: true }).success).toBe(false);
  });

  it('rejects description longer than 500', () => {
    expect(serverCreateInput.safeParse({ ...minimal, description: 'x'.repeat(501) }).success).toBe(
      false,
    );
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

  it('rejects a loopback, link-local, unspecified or host-internal rcon_host (#34)', () => {
    for (const rcon_host of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '169.254.169.254',
      'localhost',
      'LOCALHOST',
      'panel.localhost',
      'host.docker.internal',
      'gateway.docker.internal',
      'redis',
      '::1',
      '[::1]',
      '::',
      '[fe80::1]',
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
      '[::127.0.0.1]',
      '127.1',
      '2130706433',
      '0x7f.1',
      'localhost.',
    ]) {
      expect(
        externalServerCreateInput.safeParse({ ...minimal, rcon_host }).success,
        rcon_host,
      ).toBe(false);
    }
  });

  it('keeps private LAN addresses allowed for a server hosted next door', () => {
    for (const rcon_host of ['10.0.0.5', '192.168.1.20', '172.20.0.3', '[fd00::10]']) {
      expect(
        externalServerCreateInput.safeParse({ ...minimal, rcon_host }).success,
        rcon_host,
      ).toBe(true);
    }
  });

  it('rejects an RCON password carrying CR, LF or NUL (#34)', () => {
    for (const rcon_password of ['a\r\nSET x 1', 'a\nb', 'a\rb', 'a\u0000b']) {
      expect(externalServerCreateInput.safeParse({ ...minimal, rcon_password }).success).toBe(
        false,
      );
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

  it('rejects a loopback host and a password with line breaks (#34)', () => {
    expect(externalServerConnectionUpdate.safeParse({ rcon_host: '127.0.0.1' }).success).toBe(
      false,
    );
    expect(
      externalServerConnectionUpdate.safeParse({ rcon_password: 'x\r\nFLUSHALL' }).success,
    ).toBe(false);
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

describe('server settings page response schemas (#86 finding 656)', () => {
  const settings = {
    server_id: 's',
    game_port: 7787,
    query_port: 27165,
    beacon_port: 15000,
    rcon_port: 21114,
    max_players: 80,
    tickrate: 50,
    multihome: null,
    seed_live_at: 60,
    seed_hysteresis: 5,
    chat_commands_enabled: true,
    rules_text: null,
  };

  it('parses a server detail, strips unknown fields and defaults archive_logs_to_backup', () => {
    const parsed = serverDetailResponse.parse({
      server: { status: 'running', display_name: 'A', secret: 'x' },
      settings,
    });
    expect(parsed.settings?.archive_logs_to_backup).toBe(false);
    expect(parsed.server).not.toHaveProperty('secret');
  });

  it('accepts null settings but rejects a missing server or a mistyped port', () => {
    expect(
      serverDetailResponse.safeParse({ server: { status: 's', display_name: 'A' }, settings: null })
        .success,
    ).toBe(true);
    expect(serverDetailResponse.safeParse({ settings }).success).toBe(false);
    expect(serverSettingsView.safeParse({ ...settings, game_port: '7787' }).success).toBe(false);
  });

  it('parses log-source views for the configured and unconfigured cases', () => {
    expect(logSourceView.safeParse({ configured: false, status: null }).success).toBe(true);
    expect(
      logSourceView.safeParse({
        configured: true,
        ssh_port: 22,
        status: { state: 'connected', ts: 't', last_line_at: null },
      }).success,
    ).toBe(true);
    expect(logSourceView.safeParse({ configured: true }).success).toBe(false);
    expect(
      logSourceView.safeParse({ configured: true, status: { state: 'weird', ts: 't' } }).success,
    ).toBe(false);
  });

  it('validates the connection, seeding and sidecar responses', () => {
    expect(
      externalConnectionResponse.safeParse({
        rcon_host: null,
        rcon_port: 1,
        query_port: null,
        game_port: null,
      }).success,
    ).toBe(true);
    expect(seedingSettingsResponse.safeParse({ seed_live_at: 1 }).success).toBe(false);
    expect(
      sidecarIntegrationResponse.safeParse({
        server_id: 's',
        mode: 'legacy',
        cutover: false,
        status: null,
      }).success,
    ).toBe(true);
    expect(
      sidecarIntegrationResponse.safeParse({
        server_id: 's',
        mode: 'bogus',
        cutover: false,
        status: null,
      }).success,
    ).toBe(false);
  });
});
