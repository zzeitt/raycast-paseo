import { afterEach, describe, expect, it } from "vitest";
import { readLevelDbEntry } from "./leveldb";
import type { LevelDbEntry } from "./leveldb";
import {
  internalKey,
  levelDbFixtureDir as levelDbDir,
  logFile,
  removeLevelDbFixtureDirs,
  sstFile,
  writeBatch,
} from "./test-utils/leveldb-fixtures";

afterEach(removeLevelDbFixtureDirs);

const KEY = "the-key";

/** The entry's value as text, or the state name when it is not a value. */
function valueOf(entry: LevelDbEntry): string {
  return entry.kind === "value" ? entry.value.toString("utf8") : entry.kind;
}

describe("readLevelDbEntry", () => {
  it("reads a value out of a table", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([{ entries: [{ key: internalKey(KEY, 1), value: Buffer.from("stored") }] }]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("stored");
  });

  it("reads a value out of a compressed table block", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([
        { entries: [{ key: internalKey(KEY, 1), value: Buffer.from("squeezed") }], compressed: true },
      ]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("squeezed");
  });

  it("keeps whole values, including the spaces inside them", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([
        { entries: [{ key: internalKey(KEY, 1), value: Buffer.from('{"a": "b c", "d": 1}') }] },
      ]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe('{"a": "b c", "d": 1}');
  });

  it("finds the key in whichever block of the table holds it", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([
        { entries: [{ key: internalKey("aaa", 1), value: Buffer.from("first") }] },
        { entries: [{ key: internalKey(KEY, 1), value: Buffer.from("second") }], compressed: true },
        { entries: [{ key: internalKey("zzz", 1), value: Buffer.from("third") }] },
      ]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("second");
  });

  it("reads a value that is only in the log", () => {
    const dir = levelDbDir({
      "000009.log": logFile([writeBatch([{ key: KEY, value: "from the log" }])]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("from the log");
  });

  it("prefers the newer file, whichever kind it is", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([{ entries: [{ key: internalKey(KEY, 1), value: Buffer.from("old") }] }]),
      "000009.log": logFile([writeBatch([{ key: KEY, value: "new" }])]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("new");
  });

  it("reports a deletion recorded after the value instead of resurrecting the value", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([{ entries: [{ key: internalKey(KEY, 1), value: Buffer.from("gone") }] }]),
      "000009.log": logFile([writeBatch([{ key: KEY, value: null }])]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("deleted");
  });

  it("returns the newest version when a table holds several of them", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([
        {
          entries: [
            { key: internalKey(KEY, 9), value: Buffer.from("newer") },
            { key: internalKey(KEY, 4), value: Buffer.from("older") },
          ],
        },
      ]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("newer");
  });

  it("skips over files it cannot make sense of", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([{ entries: [{ key: internalKey(KEY, 1), value: Buffer.from("real") }] }]),
      "000009.ldb": Buffer.from("not a leveldb file at all"),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("real");
  });

  it("says the key is missing when no file holds it", () => {
    const dir = levelDbDir({
      "000007.ldb": sstFile([{ entries: [{ key: internalKey("other", 1), value: Buffer.from("x") }] }]),
    });
    expect(valueOf(readLevelDbEntry(dir, KEY))).toBe("missing");
  });

  it("says the key is missing when there is nothing to read", () => {
    expect(valueOf(readLevelDbEntry(levelDbDir({}), KEY))).toBe("missing");
  });
});
