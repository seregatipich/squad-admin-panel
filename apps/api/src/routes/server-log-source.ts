import { generateKeyPair as generateKeyPairCb } from 'node:crypto';
import { promisify } from 'node:util';
import { serverLogSources, servers } from '@squad/db/schema';
import {
  type LogSourceStatus,
  logSourceStatus,
  logSourceStatusKey,
  logSourceUpsertInput,
} from '@squad/shared-types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import ssh2 from 'ssh2';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';
import { isExternalRuntime } from '../lib/server-runtime.js';

// ssh2 is CommonJS: under real Node ESM (the production `node dist/index.js`)
// only the default import is guaranteed, and `utils` in particular is not a
// statically detectable named export — the api crash-looped on that once.
const sshUtils = ssh2.utils;

const idParam = z.object({ id: z.string().uuid() });

export interface SshKeyPair {
  /** PKCS#1 PEM, the format ssh2 dials with. */
  privateKeyPem: string;
  /** One `authorized_keys` line: `ssh-rsa <base64> <comment>`. */
  publicKeyLine: string;
}

const generateKeyPairAsync = promisify(generateKeyPairCb);

/**
 * Generates the key pair the worker will present to the game host. RSA 3072
 * because ssh2 parses Node's PKCS#1 PEM directly; Node's ed25519 PKCS#8
 * output is not a format ssh2 accepts.
 *
 * #294: RSA-3072 generation costs hundreds of ms of CPU (more on a loaded
 * host), so this runs through the async/`libuv` threadpool variant rather
 * than `generateKeyPairSync`, which would otherwise block the event loop —
 * stalling every other in-flight request, WS log stream and heartbeat.
 */
export async function generateSshKeyPair(comment: string): Promise<SshKeyPair> {
  const { privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) throw new Error('ssh key generation produced no key');
  const safeComment = comment.replace(/[^\w.@-]+/g, '-');
  return {
    privateKeyPem: privateKey,
    publicKeyLine: `${key.type} ${key.getPublicSSH().toString('base64')} ${safeComment}`,
  };
}

async function readStatus(app: FastifyInstance, serverId: string): Promise<LogSourceStatus | null> {
  const raw = await app.redis.get(logSourceStatusKey(serverId));
  if (!raw) return null;
  try {
    const parsed = logSourceStatus.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function view(row: typeof serverLogSources.$inferSelect, status: LogSourceStatus | null) {
  return {
    configured: true as const,
    kind: row.kind,
    ssh_host: row.sshHost,
    ssh_port: row.sshPort,
    ssh_user: row.sshUser,
    log_path: row.logPath,
    enabled: row.enabled,
    public_key: row.sshPublicKey,
    host_key_fingerprint: row.hostKeyFingerprint,
    key_version: row.keyVersion,
    updated_at: row.updatedAt,
    status,
  };
}

/**
 * Remote `SquadGame.log` source for external servers (`runtime='external'`):
 * worker-log-ingest tails the file over SSH with a key the panel generates
 * here. The private key never leaves the database; the public key is what
 * the operator installs on the game host.
 */
const serverLogSourceRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadExternalServer(id: string) {
    const row = await app.db.query.servers.findFirst({
      where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      columns: { id: true, runtime: true },
    });
    return row ?? null;
  }

  fast.get(
    '/api/v1/servers/:id/log-source',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParam },
    },
    async (req, reply) => {
      const server = await loadExternalServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!isExternalRuntime(server.runtime)) {
        reply.code(409);
        return {
          error: 'not_external_server',
          message: 'Log sources apply only to external servers.',
        };
      }
      const row = await app.db.query.serverLogSources.findFirst({
        where: eq(serverLogSources.serverId, server.id),
      });
      if (!row) return { configured: false as const, status: null };
      return view(row, await readStatus(app, server.id));
    },
  );

  fast.put(
    '/api/v1/servers/:id/log-source',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.log_source.update', resource: 'server' },
      },
      schema: { params: idParam, body: logSourceUpsertInput },
    },
    async (req, reply) => {
      const server = await loadExternalServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (!isExternalRuntime(server.runtime)) {
        reply.code(409);
        return {
          error: 'not_external_server',
          message: 'Log sources apply only to external servers.',
        };
      }
      const body = req.body;
      const now = new Date();
      // #297: a plain SELECT-then-INSERT/UPDATE races two concurrent first
      // PUTs (both see no row, both INSERT, the second hits the server_id
      // PK and 500s) and can compute a stale keyVersion when a regenerate
      // races another write. `SELECT ... FOR UPDATE` inside a transaction
      // serializes concurrent PUTs on the same server instead: the second
      // transaction blocks until the first commits, then sees its result.
      const row = await app.db.transaction(async (tx) => {
        // Serializes concurrent PUTs for the same server, including the
        // "no row yet" case a `SELECT ... FOR UPDATE` cannot lock: the
        // advisory lock is released automatically at commit/rollback.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${server.id}))`);
        const existingRows = await tx
          .select()
          .from(serverLogSources)
          .where(eq(serverLogSources.serverId, server.id))
          .for('update');
        const existing = existingRows[0] ?? null;
        const needsKey = !existing || body.regenerate_key;
        const keyPair = needsKey
          ? await generateSshKeyPair(`squad-admin-panel@${app.config.APP_DOMAIN}`)
          : null;
        // A new host (or port) means a new host key: drop the
        // trust-on-first-use pin so the worker records the next one instead
        // of refusing it.
        const hostChanged =
          !!existing && (existing.sshHost !== body.ssh_host || existing.sshPort !== body.ssh_port);

        if (!existing) {
          if (!keyPair) throw new Error('unreachable: key pair required for a new log source');
          const inserted = await tx
            .insert(serverLogSources)
            .values({
              serverId: server.id,
              kind: 'ssh',
              sshHost: body.ssh_host,
              sshPort: body.ssh_port,
              sshUser: body.ssh_user,
              sshPrivateKeyEncrypted: serialize(encrypt(app.encryptionKey, keyPair.privateKeyPem)),
              sshPublicKey: keyPair.publicKeyLine,
              hostKeyFingerprint: null,
              logPath: body.log_path,
              enabled: body.enabled,
              keyVersion: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return inserted[0];
        }
        const updated = await tx
          .update(serverLogSources)
          .set({
            sshHost: body.ssh_host,
            sshPort: body.ssh_port,
            sshUser: body.ssh_user,
            logPath: body.log_path,
            enabled: body.enabled,
            updatedAt: now,
            ...(hostChanged ? { hostKeyFingerprint: null } : {}),
            ...(keyPair
              ? {
                  sshPrivateKeyEncrypted: serialize(
                    encrypt(app.encryptionKey, keyPair.privateKeyPem),
                  ),
                  sshPublicKey: keyPair.publicKeyLine,
                  keyVersion: sql`${serverLogSources.keyVersion} + 1`,
                }
              : {}),
          })
          .where(eq(serverLogSources.serverId, server.id))
          .returning();
        return updated[0];
      });
      if (!row) throw new Error('log source vanished after upsert');
      return view(row, await readStatus(app, server.id));
    },
  );

  fast.delete(
    '/api/v1/servers/:id/log-source',
    {
      config: {
        permissions: ['server:edit_settings'],
        audit: { action: 'server.log_source.delete', resource: 'server' },
      },
      schema: { params: idParam },
    },
    async (req, reply) => {
      const server = await loadExternalServer(req.params.id);
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const deleted = await app.db
        .delete(serverLogSources)
        .where(eq(serverLogSources.serverId, server.id))
        .returning({ serverId: serverLogSources.serverId });
      if (deleted.length === 0) {
        reply.code(404);
        return { error: 'log_source_not_configured' };
      }
      await app.redis.del(logSourceStatusKey(server.id));
      return { ok: true };
    },
  );
};

export default serverLogSourceRoutes;
