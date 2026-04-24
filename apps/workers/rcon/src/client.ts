import { createConnection, type Socket } from 'node:net';
import type { Logger } from 'pino';
import {
  encodePacket,
  type RconPacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_RESPONSE_VALUE,
} from './protocol.js';

export interface RconClientOptions {
  host: string;
  port: number;
  password: string;
  log: Logger;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  keepaliveMs?: number;
  onDisconnect?: (reason: 'remote-close' | 'explicit-close') => void;
}

interface PendingCommand {
  id: number;
  probeId: number;
  chunks: string[];
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class RconClient {
  private socket?: Socket;
  private readonly stream = new RconPacketStream();
  private nextId = 1000;
  private readonly pending = new Map<number, PendingCommand>();
  private keepaliveTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: RconClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: this.opts.host, port: this.opts.port });
      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error('rcon connect timeout'));
      }, this.opts.connectTimeoutMs ?? 5000);
      sock.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      sock.once('connect', () => {
        clearTimeout(timeout);
        this.socket = sock;
        this.attach(sock);
        resolve();
      });
    });
    await this.authenticate();
    this.keepalive();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('rcon closed'));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }

  async exec(command: string): Promise<string> {
    if (!this.socket) throw new Error('rcon not connected');
    const id = ++this.nextId;
    const probeId = ++this.nextId;

    return await new Promise<string>((resolve, reject) => {
      const pending: PendingCommand = { id, probeId, chunks: [], resolve, reject };
      pending.timer = setTimeout(() => {
        this.pending.delete(probeId);
        this.pending.delete(id);
        reject(new Error(`rcon exec timeout: ${command}`));
      }, this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(probeId, pending);
      // The real command and an empty follow-up probe. We wait for the probe's
      // response to know we've drained every chunk of the real command.
      this.socket?.write(encodePacket({ id, type: SERVERDATA_EXECCOMMAND, body: command }));
      this.socket?.write(encodePacket({ id: probeId, type: SERVERDATA_EXECCOMMAND, body: '' }));
    });
  }

  private attach(sock: Socket): void {
    sock.on('data', (chunk) => {
      try {
        const packets = this.stream.push(chunk);
        for (const p of packets) this.handlePacket(p);
      } catch (err) {
        this.opts.log.error({ err: (err as Error).message }, 'rcon decode error');
        this.close().catch(() => undefined);
      }
    });
    sock.on('close', () => {
      const wasClosed = this.closed;
      if (!wasClosed) {
        this.opts.log.warn('rcon socket closed');
      }
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('rcon socket closed'));
      }
      this.pending.clear();
      this.socket = undefined;
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
      this.opts.onDisconnect?.(wasClosed ? 'explicit-close' : 'remote-close');
    });
    sock.on('error', (err) => {
      this.opts.log.warn({ err: err.message }, 'rcon socket error');
    });
  }

  private authenticate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const authId = ++this.nextId;
      const timer = setTimeout(() => reject(new Error('rcon auth timeout')), 5000);

      const onPacket = (p: RconPacket) => {
        if (p.type === 2 && p.id === authId) {
          // SERVERDATA_AUTH_RESPONSE with our id = success; -1 = failure
          clearTimeout(timer);
          this.packetHandler = null;
          resolve();
        } else if (p.type === 2 && p.id === -1) {
          clearTimeout(timer);
          this.packetHandler = null;
          reject(new Error('rcon auth rejected'));
        }
        // ignore empty SERVERDATA_RESPONSE_VALUE that Squad sends before auth response
      };
      this.packetHandler = onPacket;
      this.socket?.write(
        encodePacket({ id: authId, type: SERVERDATA_AUTH, body: this.opts.password }),
      );
    });
  }

  private packetHandler: ((p: RconPacket) => void) | null = null;

  private handlePacket(p: RconPacket): void {
    if (this.packetHandler) {
      this.packetHandler(p);
      return;
    }
    if (p.type !== SERVERDATA_RESPONSE_VALUE) return;

    // Find the command that owns this id.
    for (const [probeId, pending] of this.pending) {
      if (p.id === probeId) {
        // probe echo: resolve the accumulated body
        this.pending.delete(probeId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(pending.chunks.join(''));
        return;
      }
      if (p.id === pending.id) {
        pending.chunks.push(p.body);
        return;
      }
    }
  }

  private keepalive(): void {
    const interval = this.opts.keepaliveMs ?? 90_000;
    this.keepaliveTimer = setInterval(() => {
      if (!this.socket) return;
      this.exec('ShowServerInfo').catch((err) =>
        this.opts.log.warn({ err: (err as Error).message }, 'keepalive failed'),
      );
    }, interval);
  }
}
