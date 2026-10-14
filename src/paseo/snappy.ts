/**
 * Snappy block decompression.
 *
 * Chromium's Local Storage is a leveldb, and leveldb snappy-compresses its data blocks, so the
 * daemon registry is not readable as text in the files on disk. This decodes one raw snappy stream
 * (the format leveldb stores, without the framing snappy's own file format adds).
 *
 * `null` means "these bytes are not a snappy stream" — the caller uses that to reject a block it
 * guessed wrong about, so every malformed case has to return null rather than throw.
 */

/** A block that claims to hold more than this is not a real one; the guard keeps a bad length from allocating. */
const MAX_BLOCK_BYTES = 1 << 26;

export function decodeSnappyBlock(buf: Buffer, offset: number): Buffer | null {
  const header = readVarint(buf, offset);
  if (!header) return null;
  if (header.value === 0 || header.value > MAX_BLOCK_BYTES) return null;

  const out = Buffer.alloc(header.value);
  let written = 0;
  let read = header.next;

  while (written < header.value) {
    if (read >= buf.length) return null;
    const tag = buf[read++];

    switch (tag & 3) {
      case 0: {
        const { length, next } = readLiteralLength(buf, tag, read);
        if (length === null) return null;
        read = next;
        if (read + length > buf.length || written + length > header.value) return null;
        buf.copy(out, written, read, read + length);
        read += length;
        written += length;
        break;
      }
      case 1: {
        // One-byte offset: the top three bits of the tag hold the offset's high bits.
        const length = ((tag >> 2) & 7) + 4;
        const copyFrom = ((tag >> 5) << 8) | buf[read++];
        if (!copyWithin(out, written, copyFrom, length, header.value)) return null;
        written += length;
        break;
      }
      case 2: {
        const length = (tag >> 2) + 1;
        const copyFrom = buf[read] | (buf[read + 1] << 8);
        read += 2;
        if (!copyWithin(out, written, copyFrom, length, header.value)) return null;
        written += length;
        break;
      }
      default: {
        const length = (tag >> 2) + 1;
        const copyFrom = buf[read] | (buf[read + 1] << 8) | (buf[read + 2] << 16) | (buf[read + 3] << 24);
        read += 4;
        if (!copyWithin(out, written, copyFrom, length, header.value)) return null;
        written += length;
        break;
      }
    }
  }

  return out;
}

/** Copies `length` bytes from `offset` back in the output, one at a time — a copy may run into its own output. */
function copyWithin(out: Buffer, written: number, from: number, length: number, total: number): boolean {
  if (from === 0 || from > written || written + length > total) return false;
  for (let i = 0; i < length; i++, written++) {
    out[written] = out[written - from];
  }
  return true;
}

/** Literals under 60 bytes keep their length in the tag; longer ones name how many extra bytes follow. */
function readLiteralLength(
  buf: Buffer,
  tag: number,
  read: number,
): { length: number | null; next: number } {
  const encoded = tag >> 2;
  if (encoded < 60) return { length: encoded + 1, next: read };

  const extraBytes = encoded - 59;
  if (read + extraBytes > buf.length) return { length: null, next: read };
  let length = 0;
  for (let i = 0; i < extraBytes; i++) {
    length |= buf[read + i] << (8 * i);
  }
  return { length: (length >>> 0) + 1, next: read + extraBytes };
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let read = offset;
  for (;;) {
    if (read >= buf.length) return null;
    const byte = buf[read++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: read };
    shift += 7;
    if (shift > 35) return null;
  }
}
