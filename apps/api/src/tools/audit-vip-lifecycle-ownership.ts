import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  auditVipLifecycleOwnershipState,
  disableVipLifecycleFence,
  enableVipLifecycleFence,
  VipLifecycleOwnershipAuditError,
  type VipOwnershipAuditResult,
} from '../lib/vip-lifecycle-fence.js';

export async function auditVipLifecycleOwnership(
  databaseUrl: string,
): Promise<VipOwnershipAuditResult> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 5,
    prepare: false,
  });
  const db = drizzle(client, { schema }) as unknown as DatabaseClient;

  try {
    return await auditVipLifecycleOwnershipState(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function changeVipLifecycleFence(
  databaseUrl: string,
  action: 'enable' | 'disable',
): Promise<VipOwnershipAuditResult | null> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 5,
    prepare: false,
  });
  const db = drizzle(client, { schema }) as unknown as DatabaseClient;
  try {
    if (action === 'disable') {
      await disableVipLifecycleFence(db);
      return null;
    }
    return await enableVipLifecycleFence(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write('Аудит VIP lifecycle не выполнен: требуется DATABASE_URL\n');
    process.exitCode = 1;
    return;
  }

  try {
    const action = process.env.VIP_LIFECYCLE_FENCE_ACTION?.trim() || 'audit';
    if (action !== 'audit' && action !== 'enable' && action !== 'disable') {
      process.stderr.write('Действие VIP lifecycle fence не распознано\n');
      process.exitCode = 1;
      return;
    }
    if (action === 'disable') {
      await changeVipLifecycleFence(databaseUrl, action);
      process.stdout.write('VIP lifecycle writer fence выключен явной rollback-командой\n');
      return;
    }
    const result =
      action === 'enable'
        ? await changeVipLifecycleFence(databaseUrl, action)
        : await auditVipLifecycleOwnership(databaseUrl);
    if (!result) throw new Error('VIP lifecycle audit result is missing');
    if (result.orphanedAssignments > 0 || result.conflictingAssignments > 0) {
      process.stderr.write(
        `Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: ${result.orphanedAssignments}; конфликтующих lifecycle marker: ${result.conflictingAssignments}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Проверено активных VIP-назначений: ${result.activeAssignments}; без владельца bss-store: 0${action === 'enable' ? '; writer fence включён' : ''}\n`,
    );
  } catch (error) {
    if (error instanceof VipLifecycleOwnershipAuditError) {
      process.stderr.write(
        `Аудит VIP lifecycle отклонён: активных VIP без владельца bss-store: ${error.result.orphanedAssignments}; конфликтующих lifecycle marker: ${error.result.conflictingAssignments}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write('Аудит VIP lifecycle не выполнен: проверьте соединение PostgreSQL\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
