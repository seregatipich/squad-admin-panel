import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDatabaseClient } from '@squad/db';
import { GEOIP_SETTINGS_SINGLETON_ID, geoipSettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoIpProvider } from '../src/geoip/provider.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the test database');

const db = createDatabaseClient(DATABASE_URL);
const encryptionKey = randomBytes(32);
const settingsId = GEOIP_SETTINGS_SINGLETON_ID;
const NOW = new Date('2026-09-30T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function encryptedBlob(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kv: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }),
  );
}

function tarGzWithMmdb(body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write('GeoLite2-City_20260101/GeoLite2-City.mmdb', 0, 'utf-8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('0', 156, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

async function seedSettings(values: Partial<typeof geoipSettings.$inferInsert>) {
  await db.delete(geoipSettings).where(eq(geoipSettings.id, settingsId));
  await db.insert(geoipSettings).values({ id: settingsId, ...values });
}

async function readSettings() {
  const [row] = await db.select().from(geoipSettings).where(eq(geoipSettings.id, settingsId));
  return row;
}

function okResponse(archive: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(archive.length) },
    arrayBuffer: async () =>
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  };
}

describe('GeoIpProvider (#1341)', () => {
  const dirs: string[] = [];
  const newDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geoip-provider-'));
    dirs.push(dir);
    return dir;
  };

  beforeEach(async () => {
    await db.delete(geoipSettings).where(eq(geoipSettings.id, settingsId));
  });

  afterAll(async () => {
    await db.delete(geoipSettings).where(eq(geoipSettings.id, settingsId));
    await db.$client.end();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('downloads the database with Basic credentials and records dbPath and lastRefreshedAt', async () => {
    const dataDir = await newDir();
    await seedSettings({
      enabled: true,
      accountId: '12345',
      licenseKeyEncrypted: encryptedBlob('secret-license'),
    });
    const database = Buffer.from('fake-mmdb-content');
    const fetchImpl = vi.fn(async () => okResponse(tarGzWithMmdb(database)));
    const provider = new GeoIpProvider({
      db,
      encryptionKey,
      dataDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(await provider.refreshIfDue()).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: { Authorization: string } },
    ];
    expect(url).toContain('GeoLite2-City');
    expect(url).not.toContain('secret-license');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('12345:secret-license').toString('base64')}`,
    );
    const row = await readSettings();
    expect(row?.dbPath).toBe(join(dataDir, 'GeoLite2-City.mmdb'));
    expect(row?.lastRefreshedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await readFile(row?.dbPath as string)).equals(database)).toBe(true);
  });

  it('does nothing while GeoIP is disabled or has no credentials', async () => {
    const fetchImpl = vi.fn();
    const provider = new GeoIpProvider({
      db,
      encryptionKey,
      dataDir: await newDir(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    await seedSettings({ enabled: false, accountId: '1', licenseKeyEncrypted: encryptedBlob('k') });
    expect(await provider.refreshIfDue()).toBe(false);
    await seedSettings({ enabled: true, accountId: null, licenseKeyEncrypted: null });
    expect(await provider.refreshIfDue()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips a fresh database and refreshes one older than the interval', async () => {
    const fetchImpl = vi.fn(async () => okResponse(tarGzWithMmdb(Buffer.from('new'))));
    const provider = new GeoIpProvider({
      db,
      encryptionKey,
      dataDir: await newDir(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const credentials = { enabled: true, accountId: '1', licenseKeyEncrypted: encryptedBlob('k') };

    await seedSettings({
      ...credentials,
      dbPath: '/data/old.mmdb',
      lastRefreshedAt: new Date(NOW.getTime() - DAY_MS),
    });
    expect(await provider.refreshIfDue()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    await seedSettings({
      ...credentials,
      dbPath: '/data/old.mmdb',
      lastRefreshedAt: new Date(NOW.getTime() - 8 * DAY_MS),
    });
    expect(await provider.refreshIfDue()).toBe(true);
  });

  it('reports a failed download without throwing or touching the settings', async () => {
    const onError = vi.fn();
    const provider = new GeoIpProvider({
      db,
      encryptionKey,
      dataDir: await newDir(),
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
      now: () => NOW,
      onError,
    });
    await seedSettings({ enabled: true, accountId: '1', licenseKeyEncrypted: encryptedBlob('k') });

    expect(await provider.refreshIfDue()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      'geoip refresh skipped',
      expect.objectContaining({ status: 'download_failed', httpStatus: 401 }),
    );
    expect((await readSettings())?.dbPath).toBeNull();
  });

  it('never downloads without the encryption key', async () => {
    const fetchImpl = vi.fn();
    const provider = new GeoIpProvider({
      db,
      encryptionKey: null,
      dataDir: await newDir(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await seedSettings({ enabled: true, accountId: '1', licenseKeyEncrypted: encryptedBlob('k') });
    expect(await provider.refreshIfDue()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('getLookup is null while disabled or without a readable database', async () => {
    const provider = new GeoIpProvider({ db, encryptionKey, dataDir: await newDir() });
    expect(await provider.getLookup()).toBeNull();

    await seedSettings({ enabled: true, dbPath: '/nonexistent/GeoLite2-City.mmdb' });
    const fresh = new GeoIpProvider({ db, encryptionKey, dataDir: await newDir() });
    expect(await fresh.getLookup()).toBeNull();
  });
});
