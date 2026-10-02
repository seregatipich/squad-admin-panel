import { type LookupAddress, lookup } from 'node:dns';
import { createConnection, isIP, type LookupFunction, type Socket } from 'node:net';
import { type HostCidr, isPrivateHostAllowed, isRestrictedNetworkHost } from '@squad/shared-types';
import type { Logger } from 'pino';
import { refuseResolvedAddresses } from './address-guard.js';
import {
  encodePacket,
  type RconPacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_CHAT_VALUE,
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
  /**
   * Refuse to dial a loopback, link-local or otherwise restricted address
   * (`isRestrictedNetworkHost`), checked on the literal host and on every
   * address DNS returns for it — the connection uses exactly the checked
   * address, so a rebinding resolver cannot swap in 127.0.0.1 afterwards.
   * Set for operator-supplied hosts (external servers, #30 finding #333);
   * panel-hosted containers are legitimately reached on loopback.
   */
  refuseRestrictedAddresses?: boolean;
  /**
   * Private LAN ranges an external server may live in
   * (`EXTERNAL_HOST_PRIVATE_ALLOWLIST`, finding #333). Applies only together
   * with `refuseRestrictedAddresses`, to the literal host and to every
   * resolved address. `undefined`/`null` leaves every private range reachable.
   */
  privateHostAllowlist?: readonly HostCidr[] | null;
  /** Resolver for the restricted-address guard; defaults to `dns.lookup`. Tests pass a stub. */
  dnsLookup?: DnsLookup;
  /**
   * Called with the raw body of every unsolicited broadcast packet Squad
   * pushes (chat, admin camera, squad creation, kicks). Interleaved with
   * command responses, so it must not block; exceptions are logged and
   * swallowed rather than tearing down the socket.
   */
  onBroadcast?: (body: string) => void;
}

/** The resolver `net.connect` consults; `dns.lookup` unless a test substitutes a stub. */
export type DnsLookup = typeof lookup;

/**
 * `dns.lookup` that fails with an error instead of returning an address the
 * panel must not dial: a restricted one, or a private one outside
 * `privateHostAllowlist`. Handles both the single-address and the `all: true`
 * (happy-eyeballs) callback shapes `net.connect` may ask for, and refuses the
 * whole answer when any of its addresses is refused. `net.connect` dials the
 * address this callback returns, so there is no second resolution a rebinding
 * resolver could answer differently.
 */
function makeRestrictedAddressLookup(
  privateHostAllowlist: readonly HostCidr[] | null,
  resolve: DnsLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      const addresses = Array.isArray(address)
        ? (address as LookupAddress[]).map((entry) => entry.address)
        : [address];
      const refusal = refuseResolvedAddresses(addresses, privateHostAllowlist);
      if (refusal !== null) {
        const reason =
          refusal === 'restricted'
            ? 'resolves to a restricted address'
            : 'resolves to a private address outside the allowlist';
        callback(
          Object.assign(new Error(`rcon host ${hostname} ${reason}`), { code: 'ERESTRICTED' }),
          address,
          family,
        );
        return;
      }
      callback(null, address, family);
    });
  };
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
  private lastCommandAt = 0;
  private execQueue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RconClientOptions) {}

  /**
   * Opens the socket and authenticates.
   *
   * @throws when the password contains CR, LF or NUL — it is written verbatim
   *   as the SERVERDATA_AUTH body, so a line break would smuggle commands into
   *   any line-based service (e.g. the host's Redis) the target points at (#34).
   *   The check runs before dialling, so such a password never leaves the process.
   */
  async connect(): Promise<void> {
    if (this.socket) return;
    if (/[\r\n\0]/.test(this.opts.password)) {
      throw new Error('rcon password contains a line break or NUL; refusing to send it');
    }
    this.closed = false;
    const refuse = this.opts.refuseRestrictedAddresses === true;
    if (refuse && isIP(this.opts.host) !== 0 && isRestrictedNetworkHost(this.opts.host)) {
      throw new Error(`rcon host ${this.opts.host} is a restricted address`);
    }
    const privateHostAllowlist = this.opts.privateHostAllowlist ?? null;
    if (refuse && !isPrivateHostAllowed(this.opts.host, privateHostAllowlist)) {
      throw new Error(`rcon host ${this.opts.host} is a private address outside the allowlist`);
    }
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({
        host: this.opts.host,
        port: this.opts.port,
        ...(refuse
          ? {
              lookup: makeRestrictedAddressLookup(
                privateHostAllowlist,
                this.opts.dnsLookup ?? lookup,
              ),
            }
          : {}),
      });
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
    const run = this.execQueue.then(() => this.execNow(command));
    this.execQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async execNow(command: string): Promise<string> {
    if (this.closed) throw new Error('rcon closed');
    if (!this.socket) throw new Error('rcon not connected');
    this.lastCommandAt = Date.now();
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
    if (p.type === SERVERDATA_CHAT_VALUE) {
      try {
        this.opts.onBroadcast?.(p.body);
      } catch (err) {
        this.opts.log.warn({ err: (err as Error).message }, 'rcon broadcast handler failed');
      }
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
      // Any command already keeps the connection alive; only an idle one needs the ping.
      if (Date.now() - this.lastCommandAt < interval) return;
      this.exec('ShowServerInfo').catch((err) =>
        this.opts.log.warn({ err: (err as Error).message }, 'keepalive failed'),
      );
    }, interval);
  }
}
