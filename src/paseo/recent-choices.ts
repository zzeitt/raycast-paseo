/**
 * What the Ask command remembers about where you last asked.
 *
 * The working directory used to be a setting; now it is a workspace on a host, and there is nothing
 * on the daemon to rank workspaces by — the activity timestamps it sends back are null, and its
 * project list has no order the protocol admits to. So "the one you were last in" is taken
 * literally: it is the workspace this command was last used with, remembered per host.
 *
 * Kept to a plain JSON object of host id to `{ id, path }`, so a stored value that is missing,
 * stale, or written by another version costs a default rather than an error.
 */

export interface ChoiceStore {
  /** Raycast's LocalStorage hands back whatever it stored, and `undefined` for a key it never saw. */
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: string): Promise<void>;
}

export interface WorkspaceChoice {
  id: string;
  /** The directory the agent starts in. */
  path: string;
}

export const RECENT_WORKSPACES_KEY = "@paseo-raycast:recent-workspaces";

export function recentWorkspace(stored: string | null, serverId: string): WorkspaceChoice | null {
  const remembered = readStored(stored)[serverId];
  if (typeof remembered !== "object" || remembered === null) return null;
  const choice = remembered as Record<string, unknown>;
  const id = typeof choice.id === "string" ? choice.id : "";
  const path = typeof choice.path === "string" ? choice.path : "";
  return id.length > 0 && path.length > 0 ? { id, path } : null;
}

export function withRecentWorkspace(
  stored: string | null,
  serverId: string,
  choice: WorkspaceChoice,
): string {
  return JSON.stringify({ ...readStored(stored), [serverId]: choice });
}

export async function recallWorkspace(store: ChoiceStore, serverId: string): Promise<WorkspaceChoice | null> {
  return recentWorkspace(await read(store), serverId);
}

export async function rememberWorkspace(
  store: ChoiceStore,
  serverId: string,
  choice: WorkspaceChoice,
): Promise<void> {
  await store.setItem(RECENT_WORKSPACES_KEY, withRecentWorkspace(await read(store), serverId, choice));
}

async function read(store: ChoiceStore): Promise<string | null> {
  try {
    const stored = await store.getItem(RECENT_WORKSPACES_KEY);
    return typeof stored === "string" ? stored : null;
  } catch {
    return null;
  }
}

function readStored(stored: string | null): Record<string, unknown> {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
