import { generateKeyPairSync } from 'node:crypto';
import { serverLogSources, servers } from '@squad/db/schema';
import {
  type LogSourceStatus,
  logSourceStatus,
  logSourceStatusKey,
  logSourceUpsertInput,
} from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { utils as sshUtils } from 'ssh2';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';
import { isExternalRuntime } from '../lib/server-runtime.js';

const idParam = z.object({ id: z.string().uuid() });

export interface SshKeyPair {
  /** PKCS#1 PEM, the format ssh2 dials with. */
  privateKeyPem: string;
  /** One `authorized_keys` line: `ssh-rsa <base64> <comment>`. */
  publicKeyLine: string;
}

/**
 * Generates the key pair the worker will present to the game host. RSA 3072
 * because ssh2 parses Node's PKCS#1 PEM directly; Node's ed25519 PKCS#8
 * output is not a format ssh2 accepts.
 */
export function generateSshKeyPair(comment: string): SshKeyPair {
  const { privateKey } = generateKeyPairSync('rsa', {
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
      const existing = await app.db.query.serverLogSources.findFirst({
        where: eq(serverLogSources.serverId, server.id),
      });
      const now = new Date();
      const needsKey = !existing || body.regenerate_key;
      const keyPair = needsKey
        ? generateSshKeyPair(`squad-admin-panel@${process.env.APP_DOMAIN ?? 'panel'}`)
        : null;
      // A new host (or port) means a new host key: drop the trust-on-first-use
      // pin so the worker records the next one instead of refusing it.
      const hostChanged =
        !!existing && (existing.sshHost !== body.ssh_host || existing.sshPort !== body.ssh_port);

      if (!existing) {
        if (!keyPair) throw new Error('unreachable: key pair required for a new log source');
        await app.db.insert(serverLogSources).values({
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
        });
      } else {
        await app.db
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
                  keyVersion: existing.keyVersion + 1,
                }
              : {}),
          })
          .where(eq(serverLogSources.serverId, server.id));
      }
      const row = await app.db.query.serverLogSources.findFirst({
        where: eq(serverLogSources.serverId, server.id),
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
