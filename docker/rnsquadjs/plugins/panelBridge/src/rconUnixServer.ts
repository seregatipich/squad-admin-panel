import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

export type RconExecutor = (method: string, args: unknown[]) => Promise<string>;

interface RconRequestBody {
  method?: unknown;
  args?: unknown;
}

export class RconUnixServer {
  private server?: Server;

  constructor(
    private readonly socketPath: string,
    private readonly exec: RconExecutor,
  ) {}

  async listen(): Promise<void> {
    await unlink(this.socketPath).catch(() => {});
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/rcon') {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RconRequestBody;
          if (typeof body.method !== 'string') {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ ok: false, error: 'missing method' }));
            return;
          }
          const args = Array.isArray(body.args) ? body.args : [];
          const response = await this.exec(body.method, args);
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: true, response }));
        } catch (err) {
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (err) => console.error('panelBridge rcon socket', err));
    this.server = server;
    await chmod(this.socketPath, 0o770);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    await unlink(this.socketPath).catch(() => {});
  }
}
