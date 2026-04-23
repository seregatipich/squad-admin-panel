import { describe, expect, it } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_EXECCOMMAND,
} from '../src/protocol.js';

describe('Source RCON codec', () => {
  it('encodes an AUTH packet matching the wire dump from §0A.4', () => {
    const packet = encodePacket({
      id: 1,
      type: SERVERDATA_AUTH,
      body: 'rc0nT3st_e30ee3497e9e',
    });
    // Expected: 1f 00 00 00 | 01 00 00 00 | 03 00 00 00 | "rc0n...9e" | 00 00
    expect(packet.byteLength).toBe(4 + 4 + 4 + 21 + 2);
    expect(packet.readInt32LE(0)).toBe(31);
    expect(packet.readInt32LE(4)).toBe(1);
    expect(packet.readInt32LE(8)).toBe(3);
    expect(packet.slice(12, 12 + 21).toString('utf-8')).toBe('rc0nT3st_e30ee3497e9e');
    expect(packet[packet.byteLength - 1]).toBe(0);
    expect(packet[packet.byteLength - 2]).toBe(0);
  });

  it('decodes the auth-ok double packet Squad sends', () => {
    const s = new RconPacketStream();
    // Packet 1: empty SERVERDATA_RESPONSE_VALUE (type=0, id=1)
    const pkt1 = Buffer.concat([
      Buffer.from([0x0a, 0x00, 0x00, 0x00]),
      Buffer.from([0x01, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00]),
    ]);
    // Packet 2: SERVERDATA_AUTH_RESPONSE (type=2, id=1)
    const pkt2 = Buffer.concat([
      Buffer.from([0x0a, 0x00, 0x00, 0x00]),
      Buffer.from([0x01, 0x00, 0x00, 0x00]),
      Buffer.from([0x02, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00]),
    ]);
    const packets = s.push(Buffer.concat([pkt1, pkt2]));
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({ id: 1, type: 0, body: '' });
    expect(packets[1]).toEqual({ id: 1, type: 2, body: '' });
  });

  it('buffers partial packets across push calls', () => {
    const s = new RconPacketStream();
    const full = encodePacket({ id: 42, type: SERVERDATA_EXECCOMMAND, body: 'ShowCurrentMap' });
    expect(s.push(full.subarray(0, 5))).toHaveLength(0);
    const packets = s.push(full.subarray(5));
    expect(packets).toHaveLength(1);
    expect(packets[0]?.body).toBe('ShowCurrentMap');
  });
});
