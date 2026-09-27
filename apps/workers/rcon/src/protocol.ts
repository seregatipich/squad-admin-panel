/**
 * Valve Source RCON protocol encoder/decoder.
 *
 * Wire format per packet:
 *   int32 size   (little-endian, bytes after this field)
 *   int32 id     (echoed back)
 *   int32 type   (SERVERDATA_AUTH=3, SERVERDATA_EXECCOMMAND=2,
 *                 SERVERDATA_RESPONSE_VALUE=0, SERVERDATA_AUTH_RESPONSE=2,
 *                 SERVERDATA_CHAT_VALUE=1)
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
 *   - Squad answers that empty probe TWICE. The first reply is a regular
 *     empty SERVERDATA_RESPONSE_VALUE; the second claims size 10 but is
 *     actually 17 bytes long (21 with the size header) — its body is
 *     `00 00 00 01 00 00 00`. Captured verbatim from a live v8 server on
 *     2026-09-07 and handled the same way SquadJS's core/rcon.js does.
 *     Left in the stream, those 7 trailing bytes parse as a size-256 header
 *     and every later response is mis-framed (`invalid RCON packet size`
 *     errors, exec timeouts, a reconnect loop). A chat packet can carry the
 *     same 7 leading bytes, so `RconPacketStream` strips them only right
 *     after that second echo.
 */

export const SERVERDATA_AUTH = 3;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;
/**
 * Squad's unsolicited broadcast packet: chat lines, admin-camera notices,
 * squad creation, kick/warn notices. Not part of the Valve protocol — Squad
 * pushes these to every authenticated client without a matching request, so
 * they carry no id this client issued.
 */
export const SERVERDATA_CHAT_VALUE = 1;

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

/**
 * Body of Squad's second answer to the empty probe (see the header comment):
 * the 7 bytes that follow the two null terminators of a size-10 frame.
 */
export const SQUAD_BROKEN_PROBE_TAIL = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);

/** Wire size of an empty frame: id + type + two null terminators. */
const EMPTY_FRAME_SIZE = 10;

/**
 * Splits a TCP byte stream into RCON packets.
 *
 * The broken-probe tail is recognised by context, never by its bytes alone:
 * a server-pushed chat packet (`SERVERDATA_CHAT_VALUE`, id 0) with a 246-byte
 * body has size 256 and starts with exactly the same 7 bytes (#977). The tail
 * is only expected right after Squad's *second* empty echo of a probe — an
 * empty `SERVERDATA_RESPONSE_VALUE` whose id repeats the previous empty
 * response's id — and only there is it stripped (or waited for, when the TCP
 * chunking splits it). Anywhere else those bytes are parsed as a frame.
 */
export class RconPacketStream {
  private buf: Buffer = Buffer.alloc(0);
  private lastEmptyResponseId: number | null = null;
  private expectProbeTail = false;

  push(chunk: Buffer): RconPacket[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: RconPacket[] = [];
    while (this.buf.byteLength > 0) {
      if (this.expectProbeTail) {
        const n = Math.min(this.buf.byteLength, SQUAD_BROKEN_PROBE_TAIL.byteLength);
        if (!this.buf.subarray(0, n).equals(SQUAD_BROKEN_PROBE_TAIL.subarray(0, n))) {
          this.expectProbeTail = false;
        } else if (n < SQUAD_BROKEN_PROBE_TAIL.byteLength) {
          break;
        } else {
          this.buf = this.buf.subarray(n);
          this.expectProbeTail = false;
          continue;
        }
      }
      if (this.buf.byteLength < 4) break;
      const size = this.buf.readInt32LE(0);
      if (size < EMPTY_FRAME_SIZE) {
        throw new Error(`invalid RCON packet size: ${size}`);
      }
      if (this.buf.byteLength - 4 < size) break;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const bodyEnd = 4 + size - 2; // last two bytes are null terminators
      const body = this.buf.subarray(12, bodyEnd).toString('utf-8');
      out.push({ id, type, body });
      this.buf = this.buf.subarray(4 + size);
      this.trackProbeEcho(id, type, size);
    }
    return out;
  }

  /** Arms tail stripping after the second empty response with the same id. */
  private trackProbeEcho(id: number, type: number, size: number): void {
    if (type !== SERVERDATA_RESPONSE_VALUE || size !== EMPTY_FRAME_SIZE) return;
    if (this.lastEmptyResponseId === id) {
      this.expectProbeTail = true;
      this.lastEmptyResponseId = null;
      return;
    }
    this.lastEmptyResponseId = id;
  }
}
