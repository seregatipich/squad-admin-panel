import { generateTOTP } from '@oslojs/otp';
import { sessions, users } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptString, deserialize, encrypt, serialize } from '../../src/lib/crypto.js';
import { assertAuditRow, buildIntegrationApp, type IntegrationHarness } from './harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { email: EMAIL, password: PASSWORD } });
});

afterEach(async () => {
  await h.cleanup();
});

describe('POST /api/v1/auth/login', () => {
  it('401 invalid_credentials on unknown email', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ghost@test.local', password: PASSWORD },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('401 invalid_credentials on wrong password', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: 'wrong' },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('200 with set-cookie and DB session on good password', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user: { email: string } }>();
    expect(body.user.email).toBe(EMAIL);
    expect(resp.headers['set-cookie']).toMatch(/__Host-sid=/);
    const rows = await h.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    await assertAuditRow(h, { action: 'user.login', resource: 'session' });
  });

  it('401 totp_required when the user has TOTP enabled and no code is given', async () => {
    const provisionResp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie: await loginCookie(h) },
    });
    expect(provisionResp.statusCode).toBe(200);

    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toEqual({ error: 'totp_required' });
  });

  it('accepts a valid TOTP code and rejects replay', async () => {
    const provisionResp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie: await loginCookie(h) },
    });
    const provision = provisionResp.json<{ manual_entry: string; uri: string }>();
    const secret = await readStoredSecret(h);

    const code = generateTOTP(secret, 30, 6);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD, totp_code: code },
    });
    expect(ok.statusCode).toBe(200);

    const replay = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD, totp_code: code },
    });
    expect(replay.statusCode).toBe(401);
    // Within the same 30 s TOTP step we get the replay guard's `totp_replay`;
    // crossing a step boundary mid-test surfaces `invalid_totp` instead.
    expect(['totp_replay', 'invalid_totp']).toContain(replay.json<{ error: string }>().error);
    expect(provision.manual_entry.length).toBeGreaterThan(0);
  });

  it('accepts a valid backup code and removes it from the remaining set', async () => {
    const provisionResp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie: await loginCookie(h) },
    });
    const { backup_codes } = provisionResp.json<{ backup_codes: string[] }>();
    expect(backup_codes).toHaveLength(8);

    const used = backup_codes[0]!;
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD, backup_code: used },
    });
    expect(ok.statusCode).toBe(200);

    const [row] = await h.db.select().from(users).where(eq(users.email, EMAIL));
    expect(row?.totpBackupCodesHash?.length).toBe(7);

    const reuse = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD, backup_code: used },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toEqual({ error: 'invalid_backup_code' });
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session, clears the cookie, writes an audit row', async () => {
    const cookie = await loginCookie(h);
    const before = await h.db.select().from(sessions);
    expect(before).toHaveLength(1);

    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['set-cookie']).toMatch(/__Host-sid=;/);

    const after = await h.db.select().from(sessions);
    expect(after).toHaveLength(0);
    await assertAuditRow(h, { action: 'user.logout', resource: 'session' });
  });
});

describe('GET /api/v1/me', () => {
  it('401 unauthenticated when no cookie is sent', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns the current user with permissions + clearance', async () => {
    const cookie = await loginCookie(h);
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ email: string; permissions: string[]; clearance: number }>();
    expect(body.email).toBe(EMAIL);
    expect(body.permissions).toContain('server:view');
    expect(body.clearance).toBe(1000);
  });
});

describe('POST /api/v1/me/totp/provision', () => {
  it('encrypts the TOTP secret, returns URI + 8 backup codes, writes audit row', async () => {
    const cookie = await loginCookie(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ uri: string; manual_entry: string; backup_codes: string[] }>();
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.backup_codes).toHaveLength(8);

    const row = await currentUserRow(h);
    expect(row.totpSecretEncrypted).toBeTruthy();
    expect(row.totpBackupCodesHash?.length).toBe(8);
    await assertAuditRow(h, { action: 'user.2fa.provision', resource: 'user' });
  });
});

describe('POST /api/v1/me/totp/enable', () => {
  it('accepts the right code and rejects the wrong one', async () => {
    const cookie = await loginCookie(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie },
    });
    const secret = await readStoredSecret(h);
    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/enable',
      headers: { cookie },
      payload: { totp_code: '000000' },
    });
    expect([401, 400]).toContain(wrong.statusCode);

    const code = generateTOTP(secret, 30, 6);
    const right = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/enable',
      headers: { cookie },
      payload: { totp_code: code },
    });
    expect(right.statusCode).toBe(200);
  });
});

describe('POST /api/v1/me/totp/disable', () => {
  it('wrong password → 401, right password → 200 and secret nulled', async () => {
    const cookie = await loginCookie(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/provision',
      headers: { cookie },
    });
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/disable',
      headers: { cookie },
      payload: { password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/totp/disable',
      headers: { cookie },
      payload: { password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    const row = await currentUserRow(h);
    expect(row.totpSecretEncrypted).toBeNull();
    expect(row.totpBackupCodesHash).toBeNull();
  });
});

async function loginCookie(harness: IntegrationHarness): Promise<string> {
  const resp = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
}

async function currentUserRow(harness: IntegrationHarness) {
  const [row] = await harness.db.select().from(users).where(eq(users.email, EMAIL));
  if (!row) throw new Error('user row not found');
  return row;
}

async function readStoredSecret(harness: IntegrationHarness): Promise<Uint8Array> {
  const row = await currentUserRow(harness);
  if (!row.totpSecretEncrypted) throw new Error('totp not provisioned');
  const blob = deserialize(Buffer.from(row.totpSecretEncrypted as unknown as Buffer));
  const b64 = decryptString(harness.app.encryptionKey, blob);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Silence unused-import: encrypt+serialize are exposed for future tests that
// roundtrip writes through the lib directly.
void encrypt;
void serialize;
