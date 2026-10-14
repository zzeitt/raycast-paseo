import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readLocalCredentialFor } from "./credential";

export interface PaseoEndpoint {
  /** host:port, for example 127.0.0.1:6767 */
  host: string;
  /** paseo home directory, used to read paseo.pid and local-credential */
  home: string;
}

export const CLIENT_ID = "raycast-paseo";
export const APP_VERSION = "0.1.0";

export async function connectPaseo(
  endpoint: PaseoEndpoint,
  options: { connectTimeoutMs?: number } = {},
): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://${endpoint.host}/ws`,
    clientId: CLIENT_ID,
    clientType: "cli",
    appVersion: APP_VERSION,
    localCredential: () => readLocalCredentialFor(endpoint.home, endpoint.host),
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5000 },
  });
  await client.connect();
  return client;
}

export function describeConnectionError(error: unknown, endpoint: PaseoEndpoint): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect timeout/i.test(raw)) {
    // The address may belong to another machine, where "open the desktop app" is the wrong advice:
    // a tunnel or port forward to that host has to be up too.
    return `Cannot connect to the Paseo daemon (${endpoint.host}). Check that its daemon is running — the Paseo desktop app on this machine, or whatever reaches the address above for a host on another one — and try again.`;
  }
  if (/unauthor|forbidden|401|403/i.test(raw)) {
    return `The daemon refused this connection. Most likely ${endpoint.home}\\local-credential cannot be read or does not match paseo.pid (did the daemon restart?). Check that file, or change the "Daemon address" setting to the address the daemon is actually listening on.`;
  }
  return `Failed to connect to Paseo: ${raw}`;
}
