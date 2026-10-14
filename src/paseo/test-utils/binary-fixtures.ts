/**
 * Test-only encoders for the on-disk formats the host reader parses.
 *
 * The extension only ever *reads* leveldb, so there is no production encoder to lean on; these
 * build the smallest inputs that still exercise each decoding path. Nothing here ships.
 */

/** LEB128, the varint flavour leveldb uses for lengths and block handles. */
export function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/**
 * A raw snappy stream that stores everything as one literal.
 *
 * Legal snappy, and the simplest thing an encoder can emit — which is exactly why it belongs in a
 * fixture: the reader must still run its length and tag parsing to get the bytes back out.
 */
export function snappyLiteralBytes(body: Buffer): Buffer {
  return Buffer.concat([varint(body.length), literalTag(body.length), body]);
}

/** The same, for text. Block fixtures need the byte form: their content is binary already. */
export function snappyLiteral(text: string): Buffer {
  return snappyLiteralBytes(Buffer.from(text, "utf8"));
}

function literalTag(length: number): Buffer {
  const encoded = length - 1;
  if (encoded < 60) return Buffer.from([encoded << 2]);
  const bytes: number[] = [];
  let rest = encoded;
  do {
    bytes.push(rest & 0xff);
    rest >>>= 8;
  } while (rest > 0);
  return Buffer.concat([Buffer.from([(59 + bytes.length) << 2]), Buffer.from(bytes)]);
}

/** A copy element with a one-byte offset: repeats `length` bytes from `offset` bytes back. */
export function snappyCopyShort(offset: number, length: number): Buffer {
  return Buffer.from([((length - 4) << 2) | 1 | ((offset >> 8) << 5), offset & 0xff]);
}
