/**
 * Read-only lookup in a leveldb directory.
 *
 * Chromium keeps Local Storage in a leveldb database, and the only way to that data from outside
 * the browser is to read its files. This walks just enough of the format to answer "what is the
 * newest value for this key": the tables (.ldb) hold compacted state, the logs (.log) hold what
 * was written since the last compaction, and the highest-numbered file that mentions the key wins.
 *
 * Nothing is locked and nothing is written — Chromium can keep the database open while we read.
 * Checksums are not verified; a record that does not decode cleanly is skipped, which is also how
 * a file that turns out not to be leveldb at all gets ignored.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSnappyBlock } from "./snappy";

export type LevelDbEntry =
  | { kind: "value"; value: Buffer }
  /** The newest write for this key was a delete. */
  | { kind: "deleted" }
  /** No file in the directory mentions this key. */
  | { kind: "missing" };

export function readLevelDbEntry(dir: string, key: string): LevelDbEntry {
  for (const file of dataFilesNewestFirst(dir)) {
    const entry = file.endsWith(".log") ? readLog(file, key) : readTable(file, key);
    if (entry) return entry;
  }
  return { kind: "missing" };
}

/** Log and table numbers rise together over the life of the database, so the biggest is the newest. */
function dataFilesNewestFirst(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".log") || name.endsWith(".ldb"))
    .map((name) => ({ name, number: Number.parseInt(name, 10) }))
    .filter((file) => Number.isFinite(file.number))
    .sort((a, b) => b.number - a.number)
    .map((file) => join(dir, file.name));
}

// --- tables ------------------------------------------------------------------------------------

const FOOTER_LENGTH = 48;
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

function readTable(file: string, key: string): LevelDbEntry | null {
  const buf = readFile(file);
  if (!buf || buf.length < FOOTER_LENGTH) return null;
  if (!buf.subarray(buf.length - 8).equals(TABLE_MAGIC)) return null;

  const footer = buf.length - FOOTER_LENGTH;
  const metaindexOffset = readVarint(buf, footer);
  if (!metaindexOffset) return null;
  const metaindexSize = readVarint(buf, metaindexOffset.next);
  if (!metaindexSize) return null;
  const indexOffset = readVarint(buf, metaindexSize.next);
  if (!indexOffset) return null;
  const indexSize = readVarint(buf, indexOffset.next);
  if (!indexSize) return null;

  const index = readBlock(buf, indexOffset.value, indexSize.value);
  if (!index) return null;

  for (const { value } of blockEntries(index) ?? []) {
    const handle = readBlockHandle(value);
    if (!handle) continue;
    const block = readBlock(buf, handle.offset, handle.size);
    if (!block) continue;
    const found = entryInBlock(blockEntries(block), key);
    if (found) return found;
  }
  return null;
}

/** A block's stored form is its content plus a compression byte; leveldb snappy-compresses data blocks. */
function readBlock(buf: Buffer, offset: number, size: number): Buffer | null {
  if (offset < 0 || size < 0 || offset + size + 5 > buf.length) return null;
  const contents = buf.subarray(offset, offset + size);
  const compression = buf[offset + size];
  if (compression === 0) return contents;
  if (compression === 1) return decodeSnappyBlock(contents, 0);
  return null;
}

/** Block entries share a prefix with the entry before them; keys also carry leveldb's 8-byte suffix. */
function blockEntries(content: Buffer): Array<{ key: Buffer; value: Buffer }> | null {
  if (content.length < 4) return null;
  const restartCount = content.readUInt32LE(content.length - 4);
  const bodyEnd = content.length - 4 - restartCount * 4;
  if (bodyEnd < 0) return null;

  const entries: Array<{ key: Buffer; value: Buffer }> = [];
  let at = 0;
  let previousKey = Buffer.alloc(0);

  while (at < bodyEnd) {
    const shared = readVarint(content, at);
    if (!shared) return null;
    const unshared = readVarint(content, shared.next);
    if (!unshared) return null;
    const valueLength = readVarint(content, unshared.next);
    if (!valueLength) return null;

    const keyStart = valueLength.next;
    const valueStart = keyStart + unshared.value;
    const end = valueStart + valueLength.value;
    if (shared.value > previousKey.length || end > bodyEnd) return null;

    const key = Buffer.concat([previousKey.subarray(0, shared.value), content.subarray(keyStart, valueStart)]);
    entries.push({ key, value: content.subarray(valueStart, end) });
    previousKey = key;
    at = end;
  }

  return entries;
}

function readBlockHandle(value: Buffer): { offset: number; size: number } | null {
  const offset = readVarint(value, 0);
  if (!offset) return null;
  const size = readVarint(value, offset.next);
  if (!size) return null;
  return { offset: offset.value, size: size.value };
}

function entryInBlock(entries: Array<{ key: Buffer; value: Buffer }> | null, key: string): LevelDbEntry | null {
  if (!entries) return null;
  const wanted = Buffer.from(key, "utf8");
  for (const entry of entries) {
    // The suffix packs the sequence number and the entry type, so that last byte says which it is.
    if (entry.key.length < 8) continue;
    const userKey = entry.key.subarray(0, entry.key.length - 8);
    if (!userKey.equals(wanted)) continue;
    // A table holds every version of a key, newest first: the first match is the one to answer with.
    return entry.key[entry.key.length - 8] === 0
      ? { kind: "deleted" }
      : { kind: "value", value: entry.value };
  }
  return null;
}

// --- logs --------------------------------------------------------------------------------------

const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;

function readLog(file: string, key: string): LevelDbEntry | null {
  const buf = readFile(file);
  if (!buf) return null;

  let answer: LevelDbEntry | null = null;
  for (const record of logRecords(buf)) {
    const fromRecord = entryInBatch(record, key);
    // Records are in write order, so anything later replaces what came before.
    if (fromRecord) answer = fromRecord;
  }
  return answer;
}

/** Records split across a block boundary arrive as FIRST/MIDDLE/LAST fragments that have to be rejoined. */
function logRecords(buf: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let partial: Buffer | null = null;

  for (let base = 0; base + LOG_HEADER_SIZE <= buf.length; base += LOG_BLOCK_SIZE) {
    const limit = Math.min(base + LOG_BLOCK_SIZE, buf.length);
    let at = base;
    while (at + LOG_HEADER_SIZE <= limit) {
      const length = buf.readUInt16LE(at + 4);
      const type = buf[at + 6];
      const end = at + LOG_HEADER_SIZE + length;
      // A zero type marks the padding leveldb leaves at the end of a block.
      if (type === 0) break;
      if (end > limit) break;
      const payload = buf.subarray(at + LOG_HEADER_SIZE, end);

      if (type === 1) {
        partial = null;
        records.push(payload);
      } else if (type === 2) {
        partial = payload;
      } else if (type === 3) {
        partial = partial ? Buffer.concat([partial, payload]) : null;
      } else if (type === 4) {
        if (partial) records.push(Buffer.concat([partial, payload]));
        partial = null;
      }
      at = end;
    }
  }
  return records;
}

/** A batch header holds a sequence number and a count; each entry after it is a put or a delete. */
function entryInBatch(batch: Buffer, key: string): LevelDbEntry | null {
  if (batch.length < 12) return null;
  let at = 12;
  let answer: LevelDbEntry | null = null;

  while (at < batch.length) {
    const tag = batch[at++];
    const length = readVarint(batch, at);
    if (!length) return answer;
    const start = length.next;
    const end = start + length.value;
    if (end > batch.length) return answer;

    const sameKey = batch.subarray(start, end).equals(Buffer.from(key, "utf8"));
    at = end;

    if (tag === 0) {
      if (sameKey) answer = { kind: "deleted" };
      continue;
    }
    const valueLength = readVarint(batch, at);
    if (!valueLength) return answer;
    const valueEnd = valueLength.next + valueLength.value;
    if (valueEnd > batch.length) return answer;
    if (sameKey) {
      answer = { kind: "value", value: batch.subarray(valueLength.next, valueEnd) };
    }
    at = valueEnd;
  }

  return answer;
}

// --- shared ------------------------------------------------------------------------------------

function readFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let read = at;
  for (;;) {
    if (read >= buf.length) return null;
    const byte = buf[read++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: read };
    shift += 7;
    if (shift > 35) return null;
  }
}
