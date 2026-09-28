import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

export type RconExecutor = (method: string, args: unknown[]) => Promise<string>;

interface RconRequestBody {
  method?: unknown;
  args?: unknown;
}

// Only reachable over the unix socket bind-mounted into the api container
// (no network exposure), but nothing on that path authenticates the caller
// beyond filesystem permissions, so the transport itself stays defensive:
// a bounded body and a method shaped like a single RCON verb (no embedded
// whitespace/newlines that could be used to smuggle a second command into
// whatever assembles the final RCON line downstream).
const MAX_BODY_BYTES = 16 * 1024;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

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
      let size = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          rejected = true;
          res
            .writeHead(413, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: 'body too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (rejected) return;
        let body: RconRequestBody;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RconRequestBody;
        } catch {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
          return;
        }
        if (typeof body.method !== 'string' || !METHOD_PATTERN.test(body.method)) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: 'missing or malformed method' }));
          return;
        }
        const args = Array.isArray(body.args) ? body.args : [];
        try {
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
