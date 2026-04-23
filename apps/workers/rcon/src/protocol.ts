/**
 * Valve Source RCON protocol encoder/decoder.
 *
 * Wire format per packet:
 *   int32 size   (little-endian, bytes after this field)
 *   int32 id     (echoed back)
 *   int32 type   (SERVERDATA_AUTH=3, SERVERDATA_EXECCOMMAND=2,
 *                 SERVERDATA_RESPONSE_VALUE=0, SERVERDATA_AUTH_RESPONSE=2)
 *   ASCII body   (null-terminated)
 *   0x00         (trailing null)
 *
 * Behaviour quirks observed against Squad v10.3.1 (§0A.4):
 *   - AUTH returns two packets: an empty SERVERDATA_RESPONSE_VALUE followed
 *     by SERVERDATA_AUTH_RESPONSE with the same id as the request.
 *   - Multi-packet responses are delimited with the "empty ping" trick:
 *     after the real EXECCOMMAND, the client sends a second EXECCOMMAND
 *     with id=`probeId` and empty body; when the probe's response
 *     arrives, all chunks for the real command have been delivered.
 */

export const SERVERDATA_AUTH = 3;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(packet: RconPacket): Buffer {
  const body = Buffer.from(packet.body, 'utf-8');
  const payload = Buffer.alloc(4 + 4 + body.byteLength + 2);
  payload.writeInt32LE(packet.id, 0);
  payload.writeInt32LE(packet.type, 4);
  body.copy(payload, 8);
  // trailing \0\0
  payload[8 + body.byteLength] = 0;
  payload[9 + body.byteLength] = 0;
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export class RconPacketStream {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RconPacket[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: RconPacket[] = [];
    while (this.buf.byteLength >= 4) {
      const size = this.buf.readInt32LE(0);
      if (size < 10) {
        throw new Error(`invalid RCON packet size: ${size}`);
      }
      if (this.buf.byteLength - 4 < size) break;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const bodyEnd = 4 + size - 2; // last two bytes are null terminators
      const body = this.buf.subarray(12, bodyEnd).toString('utf-8');
      out.push({ id, type, body });
      this.buf = this.buf.subarray(4 + size);
    }
    return out;
  }
}
