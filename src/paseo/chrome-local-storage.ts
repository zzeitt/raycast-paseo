/**
 * Reading Chromium's Local Storage from outside the browser.
 *
 * Local Storage is a leveldb database, and Chromium wraps each item in two conventions on top of
 * the plain key/value pair: the key gains a `_<origin>` prefix followed by two bytes, and the value
 * gains one byte saying how its text was encoded. Both were read off a real Paseo database rather
 * than taken from documentation, so the constants below are observations, not standards.
 */
import { readLevelDbEntry } from "./leveldb";

export type LocalStorageEntry =
  | { kind: "value"; value: string }
  | { kind: "deleted" }
  | { kind: "missing" };

export function localStorageKey(origin: string, key: string): string {
  return `_${origin}\u0000\u0001${key}`;
}

export function readLocalStorageItem(dir: string, origin: string, key: string): LocalStorageEntry {
  const entry = readLevelDbEntry(dir, localStorageKey(origin, key));
  if (entry.kind !== "value") return entry;
  return { kind: "value", value: decodeValue(entry.value) };
}

/** Byte 0 marks UTF-16 text; anything else is Latin-1, which is what ASCII JSON arrives as. */
function decodeValue(value: Buffer): string {
  const text = value.subarray(1);
  return value[0] === 0 ? text.toString("utf16le") : text.toString("latin1");
}
