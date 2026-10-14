import { afterEach, describe, expect, it } from "vitest";
import { localStorageKey, readLocalStorageItem } from "./chrome-local-storage";
import {
  internalKey,
  levelDbFixtureDir,
  removeLevelDbFixtureDirs,
  sstFile,
  storedValue,
  writeBatch,
  logFile,
} from "./test-utils/leveldb-fixtures";

afterEach(removeLevelDbFixtureDirs);

const ORIGIN = "paseo://app";
const KEY = "@paseo:daemon-registry";

/** Puts one Local Storage item where Chromium would keep it. */
function withStoredItem(value: Buffer, options: { compressed?: boolean } = {}): string {
  return levelDbFixtureDir({
    "000007.ldb": sstFile([
      {
        entries: [{ key: internalKey(localStorageKey(ORIGIN, KEY), 1), value }],
        compressed: options.compressed,
      },
    ]),
  });
}

describe("localStorageKey", () => {
  // Read off a real Paseo database: the leading underscore, then the origin, then two bytes, then
  // the item's own key. Getting this wrong means every lookup silently finds nothing.
  it("builds the key the way Chromium lays it out", () => {
    expect(localStorageKey("paseo://app", "@paseo:daemon-registry")).toBe(
      "_paseo://app\u0000\u0001@paseo:daemon-registry",
    );
  });
});

describe("readLocalStorageItem", () => {
  it("strips the encoding byte and returns the text", () => {
    const dir = withStoredItem(storedValue('{"hosts":2}'));
    expect(readLocalStorageItem(dir, ORIGIN, KEY)).toEqual({ kind: "value", value: '{"hosts":2}' });
  });

  it("decodes a value Chromium stored as UTF-16", () => {
    const dir = withStoredItem(storedValue('{"label":"桌面"}', "utf16"));
    expect(readLocalStorageItem(dir, ORIGIN, KEY)).toEqual({ kind: "value", value: '{"label":"桌面"}' });
  });

  it("reads a value that only ever made it to the log", () => {
    const dir = levelDbFixtureDir({
      "000009.log": logFile([
        writeBatch([{ key: localStorageKey(ORIGIN, KEY), value: storedValue("fresh") }]),
      ]),
    });
    expect(readLocalStorageItem(dir, ORIGIN, KEY)).toEqual({ kind: "value", value: "fresh" });
  });

  it("finds the item in a compressed block, as Chromium writes them", () => {
    const dir = withStoredItem(storedValue("[1,2,3]"), { compressed: true });
    expect(readLocalStorageItem(dir, ORIGIN, KEY)).toEqual({ kind: "value", value: "[1,2,3]" });
  });

  it("says the item is missing when the database holds other items only", () => {
    const dir = levelDbFixtureDir({
      "000007.ldb": sstFile([
        { entries: [{ key: internalKey(localStorageKey(ORIGIN, "@paseo:other"), 1), value: storedValue("x") }] },
      ]),
    });
    expect(readLocalStorageItem(dir, ORIGIN, KEY)).toEqual({ kind: "missing" });
  });
});
