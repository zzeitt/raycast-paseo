import { describe, expect, it } from "vitest";
import { normalizeTarget, readLocalCredentialFor, resolvePaseoHome } from "./credential";

const TOKEN = "a".repeat(43);

function fakeFs(files: Record<string, string>) {
  return (path: string): string => {
    const key = path.replace(/\\/g, "/");
    const value = files[key];
    if (value === undefined) throw new Error(`ENOENT: ${key}`);
    return value;
  };
}

const HOME = "C:/home/.paseo";
const PID = JSON.stringify({ listen: "127.0.0.1:6767" });

describe("resolvePaseoHome", () => {
  it("prefers PASEO_HOME", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "D:/paseo" })).toBe("D:/paseo");
  });

  it("treats blank PASEO_HOME as unset", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "   " })).toMatch(/\.paseo$/);
  });
});

describe("normalizeTarget", () => {
  it("treats localhost and 127.0.0.1 as the same", () => {
    expect(normalizeTarget("localhost:6767")).toBe(normalizeTarget("127.0.0.1:6767"));
  });

  it("strips the tcp:// scheme", () => {
    expect(normalizeTarget("tcp://127.0.0.1:6767")).toBe(normalizeTarget("127.0.0.1:6767"));
  });

  it("expands a bare port", () => {
    expect(normalizeTarget("6767")).toBe(normalizeTarget("localhost:6767"));
  });

  it("returns null for junk", () => {
    expect(normalizeTarget("")).toBeNull();
    expect(normalizeTarget(":::")).toBeNull();
  });
});

describe("readLocalCredentialFor", () => {
  it("reads the token when the pid lock listens on the same target", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: PID,
      [`${HOME}/local-credential`]: `${TOKEN}\n`,
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBe(TOKEN);
  });

  it("returns undefined when the pid lock listens elsewhere", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: JSON.stringify({ listen: "127.0.0.1:7000" }),
      [`${HOME}/local-credential`]: `${TOKEN}\n`,
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });

  it("rejects a token that is not 43 base64url chars", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: PID,
      [`${HOME}/local-credential`]: "too-short\n",
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });

  it("returns undefined when the credential file is missing", () => {
    const readFile = fakeFs({ [`${HOME}/paseo.pid`]: PID });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });
});
