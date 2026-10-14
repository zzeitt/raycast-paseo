import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPaseoHosts, paseoLocalStorageDirectory, toHostRows } from "./hosts";
import { localStorageKey } from "./chrome-local-storage";
import {
  internalKey,
  levelDbFixtureDir,
  removeLevelDbFixtureDirs,
  sstFile,
  storedValue,
} from "./test-utils/leveldb-fixtures";

afterEach(removeLevelDbFixtureDirs);

/** The registry exactly as Paseo writes it, with only the fields the reader looks at. */
function registryEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    serverId: "srv_one",
    label: "desk-pc",
    appearance: { color: "sky" },
    connections: [{ id: "direct:localhost:6767", type: "directTcp", endpoint: "localhost:6767" }],
    preferredConnectionId: "direct:localhost:6767",
    ...overrides,
  };
}

/** A database holding the registry, so the tests go through the same path the command does. */
function databaseWithRegistry(registry: unknown): string {
  return levelDbFixtureDir({
    "000007.ldb": sstFile([
      {
        entries: [
          {
            key: internalKey(localStorageKey("paseo://app", "@paseo:daemon-registry"), 1),
            value: storedValue(JSON.stringify(registry)),
          },
        ],
        compressed: true,
      },
    ]),
  });
}

describe("toHostRows", () => {
  it("carries over the label, the colour and the direct address", () => {
    expect(toHostRows([registryEntry({})])).toEqual([
      { serverId: "srv_one", label: "desk-pc", color: "sky", endpoint: "localhost:6767" },
    ]);
  });

  it("takes the direct address even when the relay is the preferred one", () => {
    const rows = toHostRows([
      registryEntry({
        connections: [
          { id: "relay:wss", type: "relay", relayEndpoint: "relay.paseo.sh:443" },
          { id: "direct:127.0.0.1:6768", type: "directTcp", endpoint: "127.0.0.1:6768" },
        ],
        preferredConnectionId: "relay:wss",
      }),
    ]);
    expect(rows[0].endpoint).toBe("127.0.0.1:6768");
  });

  it("marks a host that offers nothing but a relay as unreachable instead of dropping it", () => {
    const rows = toHostRows([
      registryEntry({
        connections: [
          { id: "relay:wss", type: "relay", relayEndpoint: "relay.paseo.sh:443" },
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBeNull();
    expect(rows[0].unavailable).toMatch(/relay/i);
  });

  it("marks a host whose connections are all of an unknown kind as unreachable", () => {
    const rows = toHostRows([registryEntry({ connections: [{ id: "x", type: "carrierPigeon" }] })]);
    expect(rows[0].endpoint).toBeNull();
    expect(rows[0].unavailable).toBeTruthy();
  });

  it("names a host by its server id when it has no label", () => {
    expect(toHostRows([registryEntry({ label: null })])[0].label).toBe("srv_one");
  });

  it("leaves the colour empty when the host has no appearance", () => {
    expect(toHostRows([registryEntry({ appearance: undefined })])[0].color).toBeNull();
  });

  it("ignores entries that are not hosts at all", () => {
    expect(toHostRows([{ label: "no id" }, null, "junk"])).toEqual([]);
  });
});

// The expectations are built with join() so the assertions hold on any platform the extension runs on.
describe("paseoLocalStorageDirectory", () => {
  it("points at the desktop app's storage on Windows", () => {
    const appData = "C:\\Users\\me\\AppData\\Roaming";
    expect(paseoLocalStorageDirectory({ platform: "win32", appData })).toBe(
      join(appData, "Paseo", "Local Storage", "leveldb"),
    );
  });

  it("points at the desktop app's storage on macOS", () => {
    const home = "/Users/me";
    expect(paseoLocalStorageDirectory({ platform: "darwin", home })).toBe(
      join(home, "Library", "Application Support", "Paseo", "Local Storage", "leveldb"),
    );
  });

  it("points at the desktop app's storage on Linux", () => {
    const home = "/home/me";
    expect(paseoLocalStorageDirectory({ platform: "linux", home })).toBe(
      join(home, ".config", "Paseo", "Local Storage", "leveldb"),
    );
  });
});

describe("listPaseoHosts", () => {
  it("reads the hosts Paseo has stored", () => {
    const databaseDirectory = databaseWithRegistry([registryEntry({})]);
    expect(listPaseoHosts({ databaseDirectory })).toEqual({
      kind: "hosts",
      hosts: [
        { serverId: "srv_one", label: "desk-pc", color: "sky", endpoint: "localhost:6767" },
      ],
    });
  });

  it("reports an empty list when Paseo has never stored a host", () => {
    const databaseDirectory = levelDbFixtureDir({ "000007.ldb": sstFile([]) });
    expect(listPaseoHosts({ databaseDirectory })).toEqual({ kind: "hosts", hosts: [] });
  });

  it("says so when the app's storage is not on this machine", () => {
    const result = listPaseoHosts({ databaseDirectory: "D:\\nowhere\\leveldb" });
    expect(result.kind).toBe("unreadable");
  });

  it("says so when what it found is not the registry it expects", () => {
    const databaseDirectory = databaseWithRegistry({ not: "an array" });
    const result = listPaseoHosts({ databaseDirectory });
    expect(result.kind).toBe("unreadable");
  });
});
