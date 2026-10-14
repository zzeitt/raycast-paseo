import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Matches the paseo server side: base64url encoding of a 32-byte token */
export const LOCAL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PASEO_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".paseo");
}

/**
 * Normalize to `host:port`, used to compare "the address the daemon listens on in
 * the pid lock" with "the address we want to connect to". Returns null when it cannot
 * be recognized. localhost / 127.0.0.1 are treated as the same address (matching
 * paseo's own normalizeLoopbackToLocalhost behavior).
 */
export function normalizeTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) return normalizeTarget(`localhost:${trimmed}`);

  const withoutScheme = trimmed.replace(/^tcp:\/\//i, "");
  const withoutSlash = withoutScheme.replace(/\/+$/, "");
  const lastColon = withoutSlash.lastIndexOf(":");
  if (lastColon <= 0) return null;

  const host = withoutSlash
    .slice(0, lastColon)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const port = withoutSlash.slice(lastColon + 1);
  if (!host || !/^\d+$/.test(port)) return null;

  const normalizedHost = LOOPBACK_NAMES.has(host) ? "localhost" : host;
  return `${normalizedHost}:${port}`;
}

export interface ReadLocalCredentialDeps {
  readFile?: (path: string) => string;
}

/** Only hand out the token when the target is exactly the local daemon in the pid lock; otherwise return undefined. */
export function readLocalCredentialFor(
  home: string,
  target: string,
  deps: ReadLocalCredentialDeps = {},
): string | undefined {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const lock = JSON.parse(readFile(join(home, "paseo.pid"))) as { listen?: unknown };
    if (typeof lock.listen !== "string") return undefined;
    const selected = normalizeTarget(target);
    const listening = normalizeTarget(lock.listen);
    if (!selected || !listening || selected !== listening) return undefined;

    const token = readFile(join(home, "local-credential")).trim();
    return LOCAL_CREDENTIAL_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
