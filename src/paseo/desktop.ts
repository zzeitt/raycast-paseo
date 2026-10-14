import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Byte-for-byte identical to the output of paseo's own `@getpaseo/protocol/agent-deep-link`,
 * including the trim on both ends and the throw on empty values. Note it is `paseo://` — **two**
 * slashes: paseo's template is `paseo:/${route}` while route itself starts with `/`. This is not
 * a cosmetic issue: its own `parseAgentDeepLink` goes through `new URL()`, and with two slashes
 * the hostname is `h` and the pathname splits into 3 segments, which parses; with one slash the
 * hostname is empty and it splits into 4 segments, returning null and silently breaking the link.
 *
 * Deliberately not importing that one: the protocol's exports are the `./*` wildcard, which
 * exposes every internal file with no stability promise, while the URL format itself is a
 * contract that must stay stable. The tests cross-check and round-trip it, so format drift
 * blows up at test time.
 */
export function buildAgentDeepLink(serverId: string, agentId: string): string {
  const server = serverId.trim();
  const agent = agentId.trim();
  if (!server || !agent) {
    throw new Error("The deep link needs a server id and an agent id, but received an empty value.");
  }
  return `paseo://h/${encodeURIComponent(server)}/agent/${encodeURIComponent(agent)}`;
}

/** The location the CLI looks in on the same platform; an install somewhere else is reached by setting the preference. */
export function paseoAppCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData ? [join(localAppData, "Programs", "Paseo", "Paseo.exe")] : [];
}

export interface OpenAgentInDesktopParams {
  serverId: string;
  agentId: string;
  preferredPath?: string;
  launch?: (command: string, args: string[]) => Promise<void>;
  exists?: (path: string) => boolean;
}

function defaultLaunch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // The desktop app must have ELECTRON_RUN_AS_NODE removed from the CLI's environment, or it starts as a plain Node process.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * The one line to show the user when "open in desktop" fails.
 *
 * This step used to be `void openAgentInDesktop(...)` — a failure made no sound at all, and the user
 * would just think the button was broken. The reason for a launch failure is almost always in the
 * error message (no path set, exe not there), so passing it through as-is is most useful; fall back
 * to a single line only when there is no information to pass.
 */
export function describeDesktopOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "Failed to open in desktop: could not find Paseo.exe, and could not launch it.";
}

export async function openAgentInDesktop(params: OpenAgentInDesktopParams): Promise<void> {
  const exists = params.exists ?? existsSync;
  const launch = params.launch ?? defaultLaunch;

  // Compute the link first: with an empty id we must fail before launching any process.
  const link = buildAgentDeepLink(params.serverId, params.agentId);

  const preferred = params.preferredPath?.trim();
  const candidates = [...(preferred ? [preferred] : []), ...paseoAppCandidates()];
  const app = candidates.find((candidate) => exists(candidate));
  if (!app) {
    throw new Error(
      "Paseo.exe was not found. Set the \"Paseo.exe path\" in the extension settings (it was not under %LOCALAPPDATA%\\Programs\\Paseo).",
    );
  }
  await launch(app, [link]);
}
