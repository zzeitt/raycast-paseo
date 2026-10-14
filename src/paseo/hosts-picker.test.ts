import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pickDefaultHost, readLocalServerId } from "./hosts";
import type { HostRow } from "./hosts";

const dirs: string[] = [];

function paseoHome(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-home-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const host = (serverId: string, endpoint: string | null): HostRow => ({
  serverId,
  label: serverId,
  color: null,
  endpoint,
});

describe("readLocalServerId", () => {
  it("reads the id the local daemon writes into the paseo home", () => {
    expect(readLocalServerId(paseoHome({ "server-id": "srv_local\n" }))).toBe("srv_local");
  });

  it("returns nothing when the file has never been written", () => {
    expect(readLocalServerId(paseoHome({}))).toBeNull();
  });

  it("returns nothing rather than a blank id", () => {
    expect(readLocalServerId(paseoHome({ "server-id": "   " }))).toBeNull();
  });
});

describe("pickDefaultHost", () => {
  it("starts on this machine when it is reachable", () => {
    const hosts = [host("srv_remote", "127.0.0.1:6768"), host("srv_local", "localhost:6767")];
    expect(pickDefaultHost(hosts, "srv_local")?.serverId).toBe("srv_local");
  });

  // A host named in the settings is a decision the user made, so it outranks "this machine".
  it("starts on the host the settings name", () => {
    const hosts = [host("srv_remote", "127.0.0.1:6768"), host("srv_local", "localhost:6767")];
    expect(pickDefaultHost(hosts, "srv_local", "srv_remote")?.serverId).toBe("srv_remote");
  });

  it("still falls back to something reachable when the named host is not", () => {
    const hosts = [host("srv_remote", null), host("srv_local", "localhost:6767")];
    expect(pickDefaultHost(hosts, "srv_local", "srv_remote")?.serverId).toBe("srv_local");
  });

  it("has nothing to offer when the named host is the only one and it is out of reach", () => {
    expect(pickDefaultHost([host("srv_remote", null)], null, "srv_remote")).toBeNull();
  });

  // A dead default is worse than a surprising one: the local daemon being down is common enough
  // (the desktop app closed) that it must not be picked just because it is local.
  it("falls to a reachable host when this machine's daemon is not one of them", () => {
    const hosts = [host("srv_local", null), host("srv_remote", "127.0.0.1:6768")];
    expect(pickDefaultHost(hosts, "srv_local")?.serverId).toBe("srv_remote");
  });

  it("falls back to the first host when the local id is unknown", () => {
    expect(pickDefaultHost([host("srv_a", "1.1.1.1:1"), host("srv_b", "2.2.2.2:2")], null)?.serverId).toBe("srv_a");
  });

  it("has nothing to offer when every host is out of reach", () => {
    expect(pickDefaultHost([host("srv_a", null)], "srv_a")).toBeNull();
  });
});
