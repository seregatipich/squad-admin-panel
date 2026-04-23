import { users } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyPassword } from '../lib/argon.js';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { createSession, revokeSession, tokenIdFromToken } from '../lib/sessions.js';
import {
  consumeBackupCode,
  currentStep,
  generateBackupCodes,
  generateTotp,
  verifyTotpCode,
} from '../lib/totp.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
  totp_code: z.string().optional(),
  backup_code: z.string().optional(),
  remember_me: z.boolean().optional().default(false),
});

const sessionTtl = (remember: boolean) =>
  remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 8;

const authRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/auth/login',
    {
      config: {
        audit: { action: 'user.login', resource: 'session' },
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
      schema: { body: loginBody },
    },
    async (req, reply) => {
      const body = req.body;
      const rows = await app.db
        .select()
        .from(users)
        .where(eq(users.email, body.email.toLowerCase()))
        .limit(1);
      const user = rows[0];
      if (!user) {
        reply.code(401);
        return { error: 'invalid_credentials' };
      }
      const pwOk = await verifyPassword(user.passwordHash, body.password);
      if (!pwOk) {
        reply.code(401);
        return { error: 'invalid_credentials' };
      }

      if (user.totpSecretEncrypted) {
        if (body.totp_code) {
          const step = currentStep();
          if (user.totpLastUsedStep && Number(user.totpLastUsedStep) >= step) {
            reply.code(401);
            return { error: 'totp_replay' };
          }
          const blob = deserialize(Buffer.from(user.totpSecretEncrypted as unknown as Buffer));
          const secret = new Uint8Array(
            Buffer.from(decryptString(app.encryptionKey, blob), 'base64'),
          );
          if (!verifyTotpCode(secret, body.totp_code)) {
            reply.code(401);
            return { error: 'invalid_totp' };
          }
          await app.db
            .update(users)
            .set({ totpLastUsedStep: String(step), updatedAt: new Date() })
            .where(eq(users.id, user.id));
        } else if (body.backup_code) {
          const hashes = user.totpBackupCodesHash ?? [];
          const { consumed, remaining } = await consumeBackupCode(body.backup_code, hashes);
          if (!consumed) {
            reply.code(401);
            return { error: 'invalid_backup_code' };
          }
          await app.db
            .update(users)
            .set({ totpBackupCodesHash: remaining, updatedAt: new Date() })
            .where(eq(users.id, user.id));
        } else {
          reply.code(401);
          return { error: 'totp_required' };
        }
      }

      const { token } = await createSession(app.db, app.redis, {
        userId: user.id,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ttlMs: sessionTtl(body.remember_me ?? false),
      });

      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: Math.floor(sessionTtl(body.remember_me ?? false) / 1000),
      });
      return { user: { id: user.id, email: user.email, display_name: user.displayName } };
    },
  );

  fast.post(
    '/api/v1/auth/logout',
    {
      config: { audit: { action: 'user.logout', resource: 'session' } },
    },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        await revokeSession(app.db, app.redis, tokenIdFromToken(token));
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/me',
    {
      config: { audit: false },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      return {
        id: req.user.id,
        email: req.user.email,
        display_name: req.user.displayName,
        permissions: Array.from(req.user.permissions.permissions),
        clearance: req.user.permissions.clearance,
      };
    },
  );

  fast.post(
    '/api/v1/me/totp/provision',
    {
      config: { audit: { action: 'user.2fa.provision', resource: 'user' } },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const provision = generateTotp(req.user.email);
      const backup = await generateBackupCodes();
      const encrypted = encrypt(
        app.encryptionKey,
        Buffer.from(provision.secret).toString('base64'),
      );
      await app.db
        .update(users)
        .set({
          totpSecretEncrypted: serialize(encrypted),
          totpBackupCodesHash: backup.hashedCodes,
          totpLastUsedStep: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, req.user.id));
      return {
        uri: provision.uri,
        manual_entry: provision.manualEntry,
        backup_codes: backup.plainCodes,
      };
    },
  );

  fast.post(
    '/api/v1/me/totp/enable',
    {
      config: { audit: { action: 'user.2fa.enabled', resource: 'user' } },
      schema: { body: z.object({ totp_code: z.string().length(6) }) },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const rows = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      const user = rows[0];
      if (!user || !user.totpSecretEncrypted) {
        reply.code(400);
        return { error: 'totp_not_provisioned' };
      }
      const blob = deserialize(Buffer.from(user.totpSecretEncrypted as unknown as Buffer));
      const secret = new Uint8Array(Buffer.from(decryptString(app.encryptionKey, blob), 'base64'));
      if (!verifyTotpCode(secret, req.body.totp_code)) {
        reply.code(401);
        return { error: 'invalid_totp' };
      }
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/me/totp/disable',
    {
      config: { audit: { action: 'user.2fa.disabled', resource: 'user' } },
      schema: { body: z.object({ password: z.string().min(1) }) },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const rows = await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      const user = rows[0];
      if (!user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!(await verifyPassword(user.passwordHash, req.body.password))) {
        reply.code(401);
        return { error: 'invalid_password' };
      }
      await app.db
        .update(users)
        .set({
          totpSecretEncrypted: null,
          totpBackupCodesHash: null,
          totpLastUsedStep: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, req.user.id));
      return { ok: true };
    },
  );
};

export default authRoutes;
