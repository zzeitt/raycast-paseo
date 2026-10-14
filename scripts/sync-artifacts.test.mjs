import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldCopy, syncArtifacts } from "./sync-artifacts.mjs";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-artifacts-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write `content` into the scratch tree; `ageSeconds` backdates it. */
function write(relative, content, ageSeconds = 0) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function mtime(file) {
  return fs.statSync(file).mtimeMs;
}

describe("shouldCopy", () => {
  it("copies when there is nothing there yet", () => {
    expect(shouldCopy(write("assets/icon.png", "new"), path.join(dir, "store/icon.png"))).toBe(true);
  });

  it("copies when the size differs", () => {
    const source = write("assets/icon.png", "new-and-longer");
    const dest = write("store/icon.png", "old");

    expect(shouldCopy(source, dest)).toBe(true);
  });

  it("copies a same-size edit, even when the copy on the other side looks newer", () => {
    const source = write("package.json", "aaaa", 10);
    const dest = write("store/package.json", "bbbb", 0);

    expect(shouldCopy(source, dest)).toBe(true);
  });

  it("leaves an identical file alone, so the loop does not churn every second", () => {
    const source = write("package.json", "same", 10);
    const dest = write("store/package.json", "same", 0);

    expect(shouldCopy(source, dest)).toBe(false);
  });
});

describe("syncArtifacts", () => {
  it("copies a file the destination does not have yet", () => {
    const source = write("assets/icon.png", "new");
    const dest = path.join(dir, "store/icon.png");

    expect(syncArtifacts(source, dest)).toBe(1);
    expect(fs.readFileSync(dest, "utf8")).toBe("new");
  });

  it("overwrites a file whose contents changed since it was copied", () => {
    const source = write("assets/icon.png", "new-and-longer", 10);
    const dest = write("store/icon.png", "old", 1);

    expect(syncArtifacts(source, dest)).toBe(1);
    expect(fs.readFileSync(dest, "utf8")).toBe("new-and-longer");
  });

  it("leaves an unchanged file alone", () => {
    const source = write("package.json", "same", 10);
    const dest = write("store/package.json", "same", 0);
    const before = mtime(dest);

    expect(syncArtifacts(source, dest)).toBe(0);
    expect(mtime(dest)).toBe(before);
  });

  it("refreshes files nested inside a directory", () => {
    write("assets/icon.png", "new-icon", 10);
    const destIcon = write("store/icon.png", "old-icon", 0);

    expect(syncArtifacts(path.join(dir, "assets"), path.join(dir, "store"))).toBe(1);
    expect(fs.readFileSync(destIcon, "utf8")).toBe("new-icon");
  });

  it("creates the destination directory when it is missing", () => {
    write("assets/fonts/body.woff2", "font");

    expect(syncArtifacts(path.join(dir, "assets"), path.join(dir, "store"))).toBe(1);
    expect(fs.readFileSync(path.join(dir, "store/fonts/body.woff2"), "utf8")).toBe("font");
  });
});
