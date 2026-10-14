/**
 * The hosts Paseo knows about.
 *
 * Paseo's desktop app keeps its own list of daemons — label, colour, and every way it can reach
 * each one — in the app's Local Storage. Reading that list is what lets the extension offer the
 * hosts the user already configured instead of asking for the same addresses a second time.
 *
 * Only the parts the extension can use are carried over: a host is reachable here when it lists a
 * direct TCP address. A relay would need the SDK's encrypted transport, and a socket or a named
 * pipe is not something this client can dial, so those hosts are reported as unreachable with the
 * reason rather than quietly left out.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLocalStorageItem } from "./chrome-local-storage";

const ORIGIN = "paseo://app";
const REGISTRY_KEY = "@paseo:daemon-registry";

export interface HostRow {
  serverId: string;
  label: string;
  /** Chromium colour name from the host's Paseo appearance, or null when it has none. */
  color: string | null;
  /** The `host:port` to connect to, or null when this host cannot be reached from here. */
  endpoint: string | null;
  /** Present only alongside a null endpoint: why this host is out of reach. */
  unavailable?: string;
}

export type HostsLookup =
  | { kind: "hosts"; hosts: HostRow[] }
  | { kind: "unreadable"; reason: string };

/** Where the desktop app keeps its Local Storage. Names differ per platform; the layout does not. */
export function paseoLocalStorageDirectory(
  options: { platform?: string; home?: string; appData?: string } = {},
): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "win32") {
    const appData = options.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Paseo", "Local Storage", "leveldb");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Paseo", "Local Storage", "leveldb");
  }
  return join(home, ".config", "Paseo", "Local Storage", "leveldb");
}

export function listPaseoHosts(options: { databaseDirectory?: string } = {}): HostsLookup {
  const directory = options.databaseDirectory ?? paseoLocalStorageDirectory();
  if (!existsSync(directory)) {
    return {
      kind: "unreadable",
      reason: `Paseo keeps its host list in ${directory}, which is not there. Has the Paseo desktop app run on this machine?`,
    };
  }

  const item = readLocalStorageItem(directory, ORIGIN, REGISTRY_KEY);
  // No registry yet is not a failure: the app writes one the first time it has a host to remember.
  if (item.kind !== "value") return { kind: "hosts", hosts: [] };

  let entries: unknown;
  try {
    entries = JSON.parse(item.value);
  } catch {
    return { kind: "unreadable", reason: "Paseo's host list is not readable as JSON." };
  }
  if (!Array.isArray(entries)) {
    return {
      kind: "unreadable",
      reason: "Paseo's host list is not the list of hosts this extension expects (it may have changed shape in a Paseo update).",
    };
  }

  return { kind: "hosts", hosts: toHostRows(entries) };
}

/**
 * Which of the stored hosts is the daemon on this machine.
 *
 * The Paseo home carries the id of the daemon it was written by, so a tunnel to another machine —
 * which also answers on a loopback address — is not mistaken for the local one.
 */
export function readLocalServerId(home: string): string | null {
  try {
    const id = readFileSync(join(home, "server-id"), "utf8").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The host a typed name refers to, or null when it does not name exactly one.
 *
 * Ask takes the host as an argument, and an argument is text: what the user types is matched here
 * rather than chosen from a list. An ambiguous name is deliberately not resolved — creating an
 * agent on the wrong machine is worse than being asked which one was meant.
 */
export function matchHost(hosts: HostRow[], query: string): HostRow | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  const exact = hosts.find(
    (host) => host.label.toLowerCase() === needle || host.serverId.toLowerCase() === needle,
  );
  if (exact) return exact;

  const partial = hosts.filter((host) => host.label.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Where a command starts when it was not told: the host named in the settings, then this machine,
 * then the first host that answers.
 *
 * The settings come first because naming one there is a decision, while "this machine" is only a
 * sensible guess. A host that is named but unreachable falls through like any other — being asked
 * to pick beats being unable to ask at all.
 */
export function pickDefaultHost(
  hosts: HostRow[],
  localServerId: string | null,
  preferredName?: string,
): HostRow | null {
  const reachable = hosts.filter((host) => host.endpoint !== null);
  const preferred = preferredName?.trim() ? matchHost(reachable, preferredName) : null;
  return preferred ?? reachable.find((host) => host.serverId === localServerId) ?? reachable[0] ?? null;
}

/** Tolerant by design: Paseo's stored shape is its own, so anything unrecognized is skipped, not thrown on. */
export function toHostRows(entries: unknown[]): HostRow[] {
  const rows: HostRow[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const serverId = text(raw.serverId);
    if (!serverId) continue;

    const endpoint = directEndpoint(raw.connections);
    rows.push({
      serverId,
      label: text(raw.label) ?? serverId,
      color: appearanceColor(raw.appearance),
      endpoint,
      ...(endpoint ? {} : { unavailable: describeMissingEndpoint(raw.connections) }),
    });
  }
  return rows;
}

function directEndpoint(connections: unknown): string | null {
  for (const connection of asArray(connections)) {
    if (typeof connection !== "object" || connection === null) continue;
    const raw = connection as Record<string, unknown>;
    if (raw.type !== "directTcp") continue;
    const endpoint = text(raw.endpoint);
    if (endpoint) return endpoint;
  }
  return null;
}

function describeMissingEndpoint(connections: unknown): string {
  const kinds = asArray(connections)
    .map((connection) =>
      typeof connection === "object" && connection !== null
        ? (connection as Record<string, unknown>).type
        : null,
    )
    .filter((kind): kind is string => typeof kind === "string");

  return kinds.includes("relay")
    ? "This host is reachable only through Paseo's relay, which this extension does not support yet."
    : "This host lists no address this extension can connect to.";
}

function appearanceColor(appearance: unknown): string | null {
  if (typeof appearance !== "object" || appearance === null) return null;
  return text((appearance as Record<string, unknown>).color);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
