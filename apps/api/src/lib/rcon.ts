import { join } from 'node:path';
import { Agent, request } from 'undici';

export interface RconClient {
  exec(serverId: string, method: string, args: unknown[]): Promise<string>;
}

export interface RconClientOptions {
  socketDir?: string;
  retryMs?: number;
}

interface RconResponseBody {
  ok: boolean;
  response?: string;
  error?: string;
}

export function createRconClient(opts: RconClientOptions = {}): RconClient {
  const socketDir = opts.socketDir ?? '/run/squad-panel/rnsquadjs';
  const retryMs = opts.retryMs ?? 5_000;

  return {
    async exec(serverId, method, args) {
      const socketPath = join(socketDir, `${serverId}.sock`);
      const dispatcher = new Agent({ connect: { socketPath } });
      const deadline = Date.now() + retryMs;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          const res = await request('http://localhost/rcon', {
            method: 'POST',
            dispatcher,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, args }),
          });
          const body = (await res.body.json()) as RconResponseBody;
          if (!body.ok) {
            throw new Error(body.error ?? `rcon failed (${res.statusCode})`);
          }
          return body.response ?? '';
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'ECONNREFUSED' && code !== 'ENOENT') throw err;
          lastErr = err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      throw lastErr ?? new Error('rcon timeout');
    },
  };
}
