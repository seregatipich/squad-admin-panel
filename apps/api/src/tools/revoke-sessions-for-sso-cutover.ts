import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Redis from 'ioredis';
import postgres from 'postgres';

const CONFIRMATION = '--confirm-all-sessions';

interface CutoverInput {
  databaseUrl: string;
  redisUrl: string;
}

export function requireExactConfirmation(args: string[]): void {
  const normalized = args[0] === '--' ? args.slice(1) : args;
  if (normalized.length !== 1 || normalized[0] !== CONFIRMATION) {
    throw new Error(`требуется единственный точный флаг ${CONFIRMATION}`);
  }
}

export async function revokeSessionsForSsoCutover(input: CutoverInput): Promise<number> {
  const sql = postgres(input.databaseUrl, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 5,
    prepare: false,
  });
  const redis = new Redis(input.redisUrl, {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);

  try {
    await redis.connect();
    return await sql.begin(async (transaction) => {
      // Переход выполняется один раз при остановленном API. Эксклюзивная
      // блокировка не даёт параллельному чтению вернуть ключ в Redis между
      // очисткой кеша и фиксацией удаления в PostgreSQL.
      await transaction`LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE`;
      const rows = await transaction<{ id: string }[]>`SELECT id FROM sessions`;
      if (rows.length === 0) return 0;

      const sessionIds = rows.map((row) => row.id);
      const cacheKeys = sessionIds.flatMap((id) => [`session:${id}`, `session-touch:${id}`]);
      for (let offset = 0; offset < cacheKeys.length; offset += 1_000) {
        await redis.del(...cacheKeys.slice(offset, offset + 1_000));
      }
      await transaction`DELETE FROM sessions`;
      return sessionIds.length;
    });
  } finally {
    redis.disconnect(false);
    await sql.end({ timeout: 5 });
  }
}

export async function runRevokeSessionsForSsoCutoverCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  requireExactConfirmation(args);
  const databaseUrl = env.DATABASE_URL?.trim();
  const redisUrl = env.REDIS_URL?.trim();
  if (!databaseUrl) throw new Error('требуется DATABASE_URL');
  if (!redisUrl) throw new Error('требуется REDIS_URL');
  return revokeSessionsForSsoCutover({ databaseUrl, redisUrl });
}

async function main(): Promise<void> {
  try {
    const count = await runRevokeSessionsForSsoCutoverCli(process.argv.slice(2));
    process.stdout.write(`Отозвано сессий панели: ${count}\n`);
  } catch (error) {
    const confirmationError =
      error instanceof Error && error.message.includes(CONFIRMATION)
        ? `требуется единственный точный флаг ${CONFIRMATION}`
        : 'проверьте соединения PostgreSQL и Redis, затем повторите команду';
    process.stderr.write(`Не удалось отозвать сессии панели: ${confirmationError}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
