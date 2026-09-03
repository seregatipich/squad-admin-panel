import { buildManagedSegmentBody, spliceManagedSegment } from '@squad/shared-config/admins-config';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isVipLifecycleStrict, stripAdminsCfgManagedAuthority } from '../src/admins-cfg-sync.js';
import { createDatabaseClient } from '../src/client.js';
import { panelMeta } from '../src/schema/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const projection = buildManagedSegmentBody({
  roles: [{ name: 'VIP', squadPermissions: ['reserve'] }],
  admins: [{ eosId: 'eos-current', roleName: 'VIP' }],
});

describe('strict Admins.cfg authority sanitizer', () => {
  it('is byte-idempotent for an already canonical segment with an internal blank line', () => {
    const canonical = spliceManagedSegment('', projection.body);

    const reapplied = spliceManagedSegment(
      stripAdminsCfgManagedAuthority(canonical),
      projection.body,
    );

    expect(reapplied).toBe(canonical);
  });

  it('keeps one canonical block before the SQSTAT delimiter and drops every other authority line', () => {
    const contaminated = [
      '// heading',
      '//SQUAD-PANEL BEGIN',
      'Admin=eos-stale:VIP',
      '//SQUAD-PANEL END',
      'Admin=eos-bare:VIP',
      '//SQSTAT DELIMETER',
      'Group=BotAdmins:kick',
      'Admin=eos-bot:BotAdmins',
      '//SQUAD-PANEL BEGIN',
      'Admin=eos-duplicate:VIP',
      '// orphan marker',
      '// footer',
    ].join('\n');

    const sanitized = spliceManagedSegment(
      stripAdminsCfgManagedAuthority(contaminated),
      projection.body,
    );

    expect(sanitized.indexOf('//SQUAD-PANEL END')).toBeLessThan(
      sanitized.indexOf('//SQSTAT DELIMETER'),
    );
    expect(sanitized).toContain('// heading');
    expect(sanitized).toContain('// footer');
    expect(sanitized).not.toContain('eos-stale');
    expect(sanitized).not.toContain('eos-bare');
    expect(sanitized).not.toContain('BotAdmins');
    expect(sanitized).not.toContain('eos-duplicate');
    expect(sanitized.match(/\/\/SQUAD-PANEL BEGIN/g)).toHaveLength(1);
    expect(sanitized.match(/\/\/SQUAD-PANEL END/g)).toHaveLength(1);
  });
});

describeIfDb('Admins.cfg cutover fence', () => {
  it('keeps a relaxed writer ahead of the durable strict toggle until its transaction ends', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const writerDb = createDatabaseClient(DATABASE_URL);
    const cutoverDb = createDatabaseClient(DATABASE_URL);
    let releaseWriter!: () => void;
    let reportModeRead!: () => void;
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const modeRead = new Promise<void>((resolve) => {
      reportModeRead = resolve;
    });

    try {
      const writer = writerDb.transaction(async (tx) => {
        await isVipLifecycleStrict(tx);
        reportModeRead();
        await writerRelease;
      });
      await modeRead;

      let cutoverFinished = false;
      const cutover = cutoverDb
        .update(panelMeta)
        .set({ vipLifecycleStrict: panelMeta.vipLifecycleStrict })
        .where(eq(panelMeta.id, 1))
        .then(() => {
          cutoverFinished = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cutoverFinished).toBe(false);

      releaseWriter();
      await Promise.all([writer, cutover]);
      expect(cutoverFinished).toBe(true);
    } finally {
      releaseWriter();
      await Promise.all([writerDb.$client.end(), cutoverDb.$client.end()]);
    }
  });
});
