/**
 * Test-only builders for the two leveldb file formats the host reader has to walk.
 *
 * Only what the reader actually touches is modelled: data blocks and their trailer, the index
 * block and the footer for a table, and whole FULL records for a log. Checksums are written as
 * zeroes — the reader never validates them, and computing crc32c here would only test the
 * fixture builder against itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snappyLiteralBytes, varint } from "./binary-fixtures";

/** The magic that ends every table footer, little-endian. */
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

/** A data block: prefix-compressed entries followed by the restart array. Keys here share no prefix. */
export function levelDbBlock(entries: Array<{ key: Buffer; value: Buffer }>): Buffer {
  const body: Buffer[] = [];
  for (const entry of entries) {
    body.push(
      varint(0), // shared prefix length
      varint(entry.key.length),
      varint(entry.value.length),
      entry.key,
      entry.value,
    );
  }
  // One restart point at offset 0, then the restart count.
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(1, 4);
  return Buffer.concat([...body, restarts]);
}

/**
 * Appends the five-byte block trailer. `compressed` stores the block as a single snappy literal,
 * which is what makes the reader's decompression path run at all.
 *
 * The handle records the size of what is *stored*, not of the uncompressed content — leveldb
 * compresses first and then writes the handle — so the two sizes come back separately.
 */
function withTrailer(content: Buffer, compressed: boolean): { stored: Buffer; size: number } {
  const body = compressed ? snappyLiteralBytes(content) : content;
  const trailer = Buffer.alloc(5);
  trailer[0] = compressed ? 1 : 0;
  return { stored: Buffer.concat([body, trailer]), size: body.length };
}

export interface TableBlock {
  /** Keys in this block, in order, as leveldb's internal keys (user key + 8-byte sequence suffix). */
  entries: Array<{ key: Buffer; value: Buffer }>;
  compressed?: boolean;
}

/** One table file: data blocks, an index block pointing at them, and the footer. */
export function sstFile(blocks: TableBlock[]): Buffer {
  const parts: Buffer[] = [];
  const handles: Array<{ offset: number; size: number }> = [];
  let offset = 0;

  for (const block of blocks) {
    const { stored, size } = withTrailer(levelDbBlock(block.entries), block.compressed === true);
    handles.push({ offset, size });
    parts.push(stored);
    offset += stored.length;
  }

  // The index maps each block's last key to its handle. Keys sort the reader's way, so they have
  // to be written in order.
  const indexEntries = blocks.map((block, i) => ({
    key: block.entries[block.entries.length - 1].key,
    value: Buffer.concat([varint(handles[i].offset), varint(handles[i].size)]),
  }));
  const indexBlock = withTrailer(levelDbBlock(indexEntries), false);
  const indexHandle = { offset, size: indexBlock.size };
  parts.push(indexBlock.stored);
  offset += indexBlock.stored.length;

  // An empty metaindex, then the index handle, then padding and the magic.
  const metaindexHandle = { offset, size: 0 };
  const footer = Buffer.alloc(48);
  let at = 0;
  for (const value of [
    metaindexHandle.offset,
    metaindexHandle.size,
    indexHandle.offset,
    indexHandle.size,
  ]) {
    const encoded = varint(value);
    encoded.copy(footer, at);
    at += encoded.length;
  }
  TABLE_MAGIC.copy(footer, 40);
  parts.push(footer);

  return Buffer.concat(parts);
}

/** A log file holding each payload as one whole (FULL) record. */
export function logFile(payloads: Buffer[]): Buffer {
  return Buffer.concat(
    payloads.map((payload) => {
      const header = Buffer.alloc(7);
      header.writeUInt16LE(payload.length, 4);
      header[6] = 1; // kFullType
      return Buffer.concat([header, payload]);
    }),
  );
}

/** A write batch: the sequence/count header, then one put per entry, keyed by user key. */
export function writeBatch(entries: Array<{ key: string; value: string | Buffer | null }>): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(entries.length, 8);
  const body: Buffer[] = [];
  for (const entry of entries) {
    const key = Buffer.from(entry.key, "utf8");
    if (entry.value === null) {
      body.push(Buffer.from([0]), varint(key.length), key);
      continue;
    }
    const value = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value, "utf8");
    body.push(Buffer.from([1]), varint(key.length), key, varint(value.length), value);
  }
  return Buffer.concat([header, ...body]);
}

/**
 * A Local Storage value as Chromium stores it: one byte saying how the text was encoded, then the
 * text. Latin-1 is what it picks for the ASCII these tests use; UTF-16 shows up for anything else.
 */
export function storedValue(text: string, encoding: "latin1" | "utf16" = "latin1"): Buffer {
  return encoding === "utf16"
    ? Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")])
    : Buffer.concat([Buffer.from([1]), Buffer.from(text, "latin1")]);
}

const fixtureDirs: string[] = [];

/** Writes the named leveldb files into a throwaway directory and hands back its path. */
export function levelDbFixtureDir(files: Record<string, Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-leveldb-"));
  fixtureDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

/** Call from `afterEach` so the fixture directories do not pile up across a run. */
export function removeLevelDbFixtureDirs(): void {
  while (fixtureDirs.length > 0) {
    rmSync(fixtureDirs.pop() as string, { recursive: true, force: true });
  }
}

/**
 * A user key as it is stored inside a table: the user key followed by the eight-byte trailer that
 * packs the sequence number and the entry type (`0` = deletion, `1` = value).
 */
export function internalKey(userKey: string, sequence: number, type: 0 | 1 = 1): Buffer {
  // (sequence << 8) | type, little-endian, which puts the type in the first byte and the sequence
  // in the seven that follow.
  const suffix = Buffer.alloc(8);
  suffix[0] = type;
  let rest = sequence;
  for (let i = 1; i <= 7; i++) {
    suffix[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return Buffer.concat([Buffer.from(userKey, "utf8"), suffix]);
}
