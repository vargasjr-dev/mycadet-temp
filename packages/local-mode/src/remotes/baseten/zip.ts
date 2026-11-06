import { crc32 } from "node:zlib";

/**
 * A minimal zip writer for the Baseten image push context.
 */
interface ZipEntry {
  name: string;
  data: Buffer;
}

/** All multi-byte fields in a zip are little-endian. */
function u16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
}

function u32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/**
 * Build a zip archive from the given entries, in order. Returns the raw
 * archive bytes — the same shape `unzip` and every zip reader produce.
 */
export function buildZip(entries: Array<ZipEntry>): Buffer {
  const crcs = entries.map((entry) => crc32(entry.data) >>> 0);

  let localSize = 0;
  for (const entry of entries) {
    localSize +=
      LOCAL_HEADER_SIZE + Buffer.byteLength(entry.name) + entry.data.length;
  }
  const centralSize = entries.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_SIZE + Buffer.byteLength(entry.name),
    0,
  );
  const archive = Buffer.alloc(localSize + centralSize + EOCD_SIZE);

  // Local file headers + data, back to back.
  let offset = 0;
  const localOffsets: number[] = [];
  for (const [index, entry] of entries.entries()) {
    localOffsets.push(offset);
    const name = Buffer.from(entry.name, "utf-8");
    u32(archive, offset, 0x04034b50); // local file header signature
    u16(archive, offset + 4, 20); // version needed to extract
    u16(archive, offset + 6, 0); // general purpose flags
    u16(archive, offset + 8, 0); // method: STORED
    u16(archive, offset + 10, 0); // mod time (DOS)
    u16(archive, offset + 12, 0); // mod date (DOS)
    u32(archive, offset + 14, crcs[index]);
    u32(archive, offset + 18, entry.data.length); // compressed size
    u32(archive, offset + 22, entry.data.length); // uncompressed size
    u16(archive, offset + 26, name.length);
    u16(archive, offset + 28, 0); // extra field length
    name.copy(archive, offset + LOCAL_HEADER_SIZE);
    entry.data.copy(archive, offset + LOCAL_HEADER_SIZE + name.length);
    offset += LOCAL_HEADER_SIZE + name.length + entry.data.length;
  }

  // Central directory.
  const centralOffset = offset;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, "utf-8");
    u32(archive, offset, 0x02014b50); // central directory signature
    u16(archive, offset + 4, 20); // version made by
    u16(archive, offset + 6, 20); // version needed to extract
    u16(archive, offset + 8, 0); // general purpose flags
    u16(archive, offset + 10, 0); // method: STORED
    u16(archive, offset + 12, 0); // mod time (DOS)
    u16(archive, offset + 14, 0); // mod date (DOS)
    u32(archive, offset + 16, crcs[index]);
    u32(archive, offset + 20, entry.data.length); // compressed size
    u32(archive, offset + 24, entry.data.length); // uncompressed size
    u16(archive, offset + 28, name.length);
    u16(archive, offset + 30, 0); // extra field length
    u16(archive, offset + 32, 0); // file comment length
    u16(archive, offset + 34, 0); // disk number start
    u16(archive, offset + 36, 0); // internal file attributes
    u32(archive, offset + 38, 0); // external file attributes
    u32(archive, offset + 42, localOffsets[index]);
    name.copy(archive, offset + CENTRAL_HEADER_SIZE);
    offset += CENTRAL_HEADER_SIZE + name.length;
  }

  // End of central directory.
  u32(archive, offset, 0x06054b50); // EOCD signature
  u16(archive, offset + 4, 0); // disk number
  u16(archive, offset + 6, 0); // disk with the central directory
  u16(archive, offset + 8, entries.length); // entries on this disk
  u16(archive, offset + 10, entries.length); // entries total
  u32(archive, offset + 12, offset - centralOffset); // central directory size
  u32(archive, offset + 16, centralOffset); // central directory offset
  u16(archive, offset + 20, 0); // comment length

  return archive;
}
