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

/**
 * Byte sequences captured on 2026-09-07 from a live Squad server (RCON
 * 80.242.59.123:7900) for `ListPlayers` (id 10) followed by the empty probe
 * (id 11). Squad answers the probe twice; the second answer claims size 10
 * but carries 7 extra bytes. Before this regression the decoder read those
 * bytes as a size-256 header and every later response was mis-framed.
 */
describe('Squad broken probe reply', () => {
  const emptyId11 = Buffer.from('0a0000000b000000000000000000', 'hex');
  const brokenId11 = Buffer.from('0a0000000b00000000000000000000010000000000', 'hex');
  const listPlayers = encodePacket({
    id: 10,
    type: 0,
    body: '----- Active Players -----\nID: 6 | Online IDs: EOS: 000208e9 steam: 76561198000000006 | Name: A | Team ID: 1 | Squad ID: N/A | Is Leader: False | Role: USA_Rifleman_01\n----- Recently Disconnected Players [Max of 15] -----',
  });
  const nextResponse = encodePacket({
    id: 12,
    type: 0,
    body: 'Current level is Gorodok, layer is Gorodok_RAAS_v1',
  });

  it('drops the 21-byte broken frame when it arrives whole and keeps framing the next command', () => {
    const s = new RconPacketStream();
    const first = s.push(Buffer.concat([listPlayers, emptyId11]));
    expect(first.map((p) => [p.id, p.body.length])).toEqual([
      [10, listPlayers.readInt32LE(0) - 10],
      [11, 0],
    ]);
    expect(s.push(brokenId11)).toEqual([]);
    const after = s.push(nextResponse);
    expect(after).toEqual([
      { id: 12, type: 0, body: 'Current level is Gorodok, layer is Gorodok_RAAS_v1' },
    ]);
  });

  it('drops the 7 trailing bytes when the broken frame is split after its first 14 bytes', () => {
    const s = new RconPacketStream();
    // First 14 bytes of the broken frame look exactly like the legitimate
    // second probe echo; only the tail identifies the frame.
    expect(s.push(brokenId11.subarray(0, 14))).toEqual([{ id: 11, type: 0, body: '' }]);
    expect(s.push(brokenId11.subarray(14, 18))).toEqual([]);
    expect(s.push(brokenId11.subarray(18))).toEqual([]);
    expect(s.push(nextResponse)).toEqual([
      { id: 12, type: 0, body: 'Current level is Gorodok, layer is Gorodok_RAAS_v1' },
    ]);
  });

  it('survives the tail and the next response arriving in a single TCP chunk', () => {
    const s = new RconPacketStream();
    s.push(emptyId11);
    const out = s.push(Buffer.concat([brokenId11, nextResponse, emptyId11]));
    expect(out.map((p) => p.id)).toEqual([12, 11]);
  });

  it('still rejects a genuinely malformed size', () => {
    const s = new RconPacketStream();
    expect(() => s.push(Buffer.from('03000000ffffffff', 'hex'))).toThrow(
      /invalid RCON packet size: 3/,
    );
  });
});
