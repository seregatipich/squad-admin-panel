import { gunzipSync } from 'node:zlib';

const TAR_BLOCK_BYTES = 512;
const NAME_OFFSET = 0;
const NAME_BYTES = 100;
const SIZE_OFFSET = 124;
const SIZE_BYTES = 12;
const TYPE_OFFSET = 156;

function readCString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf-8');
}

/**
 * Extracts the `.mmdb` database from a MaxMind `tar.gz` download
 * (`GeoLite2-City_<date>/GeoLite2-City.mmdb` next to license and readme files).
 *
 * A minimal ustar reader is enough here: MaxMind archives hold only regular
 * files, and adding a tar dependency to a worker for one entry is not worth it.
 *
 * @param archive - raw bytes of the downloaded `tar.gz`
 * @returns the database file contents
 * @throws Error when the archive is not gzip, is truncated, or has no `.mmdb` entry
 */
export function extractMmdbFromTarGz(archive: Buffer): Buffer {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;

    const name = readCString(header, NAME_OFFSET, NAME_BYTES);
    const size = Number.parseInt(readCString(header, SIZE_OFFSET, SIZE_BYTES).trim(), 8);
    if (!Number.isFinite(size)) throw new Error('tar header has an invalid size field');

    const type = String.fromCharCode(header[TYPE_OFFSET] || 0x30);
    const bodyStart = offset + TAR_BLOCK_BYTES;
    if (type === '0' && name.endsWith('.mmdb')) {
      if (bodyStart + size > tar.length) throw new Error('tar archive is truncated');
      return tar.subarray(bodyStart, bodyStart + size);
    }
    offset = bodyStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error('archive contains no .mmdb file');
}
