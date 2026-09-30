import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractMmdbFromTarGz } from '../src/geoip/archive.js';

/** Builds one ustar entry (header block plus zero-padded body blocks). */
function tarEntry(name: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf-8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(type, 156, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

const END_OF_ARCHIVE = Buffer.alloc(1024);

describe('extractMmdbFromTarGz (#1341)', () => {
  it('returns the .mmdb entry among licence and readme files', () => {
    const database = Buffer.from('mmdb-bytes'.repeat(100));
    const archive = gzipSync(
      Buffer.concat([
        tarEntry('GeoLite2-City_20260101/', Buffer.alloc(0), '5'),
        tarEntry('GeoLite2-City_20260101/LICENSE.txt', Buffer.from('licence')),
        tarEntry('GeoLite2-City_20260101/GeoLite2-City.mmdb', database),
        tarEntry('GeoLite2-City_20260101/README.txt', Buffer.from('readme')),
        END_OF_ARCHIVE,
      ]),
    );
    expect(extractMmdbFromTarGz(archive).equals(database)).toBe(true);
  });

  it('throws when the archive has no .mmdb entry', () => {
    const archive = gzipSync(
      Buffer.concat([tarEntry('a/LICENSE.txt', Buffer.from('x')), END_OF_ARCHIVE]),
    );
    expect(() => extractMmdbFromTarGz(archive)).toThrow('no .mmdb');
  });

  it('throws on a truncated entry', () => {
    const full = tarEntry('a/GeoLite2-City.mmdb', Buffer.alloc(2000, 1));
    const archive = gzipSync(full.subarray(0, 1024));
    expect(() => extractMmdbFromTarGz(archive)).toThrow('truncated');
  });

  it('throws on input that is not gzip', () => {
    expect(() => extractMmdbFromTarGz(Buffer.from('not gzip'))).toThrow();
  });
});
