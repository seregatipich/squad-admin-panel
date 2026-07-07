import { createConnection } from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf-8');
  const buf = Buffer.alloc(4 + 4 + payload.byteLength + 2);
  buf.writeInt32LE(id, 0);
  buf.writeInt32LE(type, 4);
  payload.copy(buf, 8);
  const header = Buffer.alloc(4);
  header.writeInt32LE(buf.byteLength, 0);
  return Buffer.concat([header, buf]);
}

function* decodePackets(
  source: Buffer,
): Generator<{ id: number; type: number; body: string }, Buffer, undefined> {
  let b = source;
  while (b.byteLength >= 4) {
    const size = b.readInt32LE(0);
    if (b.byteLength - 4 < size) break;
    const id = b.readInt32LE(4);
    const type = b.readInt32LE(8);
    const body = b.subarray(12, 4 + size - 2).toString('utf-8');
    yield { id, type, body };
    b = b.subarray(4 + size);
  }
  return b;
}

/**
 * Fire-and-forget RCON command. Opens a fresh TCP socket, sends AUTH,
 * executes one command, closes. Used by the panel API as a direct fallback
 * when worker-rcon is not connected yet.
 */
export async function rconSendOnce(opts: {
  host: string;
  port: number;
  password: string;
  command: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}): Promise<string> {
  const connectTimeout = opts.connectTimeoutMs ?? 3000;
  const commandTimeout = opts.commandTimeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: opts.host, port: opts.port });
    let buf = Buffer.alloc(0);
    const authId = 1;
    const cmdId = 2;
    const probeId = 3;
    let authed = false;
    let done = false;
    const chunks: string[] = [];

    const bail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(cmdTimer);
      sock.destroy();
      reject(err);
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(cmdTimer);
      sock.end();
      resolve(chunks.join(''));
    };

    const connectTimer = setTimeout(() => bail(new Error('rcon connect timeout')), connectTimeout);
    const cmdTimer = setTimeout(
      () => bail(new Error('rcon command timeout')),
      commandTimeout + connectTimeout,
    );

    sock.once('connect', () => {
      clearTimeout(connectTimer);
      sock.write(encodePacket(authId, SERVERDATA_AUTH, opts.password));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const gen = decodePackets(buf);
      let next = gen.next();
      while (!next.done) {
        const pkt = next.value;
        if (!authed) {
          if (pkt.type === SERVERDATA_AUTH_RESPONSE && pkt.id === authId) {
            authed = true;
            sock.write(encodePacket(cmdId, SERVERDATA_EXECCOMMAND, opts.command));
            sock.write(encodePacket(probeId, SERVERDATA_EXECCOMMAND, ''));
          } else if (pkt.type === SERVERDATA_AUTH_RESPONSE && pkt.id === -1) {
            bail(new Error('rcon auth failed'));
            return;
          }
        } else {
          if (pkt.type === SERVERDATA_RESPONSE_VALUE && pkt.id === cmdId) {
            chunks.push(pkt.body);
          } else if (pkt.type === SERVERDATA_RESPONSE_VALUE && pkt.id === probeId) {
            finish();
            return;
          }
        }
        next = gen.next();
      }
      if (next.value) buf = Buffer.from(next.value);
    });

    sock.on('error', (err) => bail(err));
    sock.on('close', () => {
      if (!done && authed) finish();
      else if (!done) bail(new Error('rcon socket closed unexpectedly'));
    });
  });
}
