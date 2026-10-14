/**
 * Workspaces are the container: every agent (a tab) and every terminal hangs off one, and the
 * daemon hands us the workspace's own summary — status, activity — already aggregated from them.
 * These helpers read that summary, and put a flat agent list back into per-workspace groups.
 */
import type { AgentRow } from "./agents";

export interface WorkspaceRow {
  id: string;
  title: string;
  project: string;
  directory: string;
  status: string;
  pinned: boolean;
  activityAt: string;
}

export interface WorkspacesClient {
  fetchWorkspaces(options?: unknown): Promise<{ entries: Array<unknown> }>;
}

export interface WorkspaceGroup {
  /** null for tabs whose workspace is not in the list we fetched — see groupAgentsByWorkspace */
  workspace: WorkspaceRow | null;
  tabs: AgentRow[];
}

/** What the tab list is showing: live tabs, archived ones, or both. */
export type AgentScope = "active" | "all" | "archived";

export function includeArchivedFor(scope: AgentScope): boolean {
  return scope !== "active";
}

export function scopeAgents(agents: AgentRow[], scope: AgentScope): AgentRow[] {
  if (scope === "active") return agents.filter((agent) => agent.archivedAt === null);
  if (scope === "archived") return agents.filter((agent) => agent.archivedAt !== null);
  return agents;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nonEmpty(value: unknown): string | null {
  const text = asString(value).trim();
  return text.length > 0 ? text : null;
}

export function toWorkspaceRow(workspace: unknown): WorkspaceRow {
  const raw = (workspace ?? {}) as Record<string, unknown>;
  return {
    id: asString(raw.id),
    // The user's own title wins; `name` is the daemon's derived one (branch or directory name).
    title: nonEmpty(raw.title) ?? asString(raw.name),
    project: nonEmpty(raw.projectCustomName) ?? asString(raw.projectDisplayName),
    directory: nonEmpty(raw.workspaceDirectory) ?? asString(raw.projectRootPath),
    status: asString(raw.status, "unknown"),
    pinned: nonEmpty(raw.pinnedAt) !== null,
    activityAt: asString(raw.activityAt),
  };
}

export function sortWorkspaceRows(rows: WorkspaceRow[]): WorkspaceRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.activityAt !== b.activityAt) return b.activityAt.localeCompare(a.activityAt);
    return a.title.localeCompare(b.title);
  });
}

export async function listWorkspaces(client: WorkspacesClient): Promise<WorkspaceRow[]> {
  const result = await client.fetchWorkspaces();
  return sortWorkspaceRows((result.entries ?? []).map(toWorkspaceRow));
}

/** The last segment of a directory, whichever separator the host uses: that is the branch or repo name. */
function directoryName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/**
 * The workspace a name refers to, or null when it does not name exactly one.
 *
 * What the user types is resolved here rather than chosen from a list: the title they see in the
 * list, the directory's own name, or the whole directory when they have a path to hand. An
 * ambiguous name resolves to nothing on purpose — the caller falls back to letting them pick.
 *
 * A path matches only when it is the whole path: two workspaces can live under the same parent, so
 * a path that is merely a prefix of one — or of several — decides nothing.
 */
export function matchWorkspace(rows: WorkspaceRow[], query: string): WorkspaceRow | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  const at = rows.find((row) => row.directory.toLowerCase() === needle);
  if (at) return at;

  const names = (row: WorkspaceRow) => [row.title.toLowerCase(), directoryName(row.directory).toLowerCase()];
  const exact = rows.filter((row) => names(row).some((name) => name === needle));
  if (exact.length > 0) return exact[0];

  const partial = rows.filter((row) => names(row).some((name) => name.includes(needle)));
  return partial.length === 1 ? partial[0] : null;
}

/** Most recently touched first, so the tab you were just in sits at the top of its workspace. */
function sortTabs(tabs: AgentRow[]): AgentRow[] {
  return [...tabs].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.title.localeCompare(b.title);
  });
}

/**
 * Turns the flat agent list into one group per workspace, in the order `workspaces` already has.
 *
 * Workspaces with no tabs are left out — an empty section only adds noise to the list, and the
 * search that reaches a workspace through its tabs has nothing to show for it anyway.
 *
 * Tabs whose workspace is missing from `workspaces` (an archived one, or one that fell outside the
 * page we fetched) are not dropped: they end up in a trailing group with a null workspace, which
 * the view labels as coming from nowhere in particular. Hiding them would hide precisely the tabs
 * most likely to need attention.
 */
export function groupAgentsByWorkspace(agents: AgentRow[], workspaces: WorkspaceRow[]): WorkspaceGroup[] {
  const byWorkspace = new Map<string, AgentRow[]>();
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const loose: AgentRow[] = [];

  for (const agent of agents) {
    if (!agent.workspaceId || !known.has(agent.workspaceId)) {
      loose.push(agent);
      continue;
    }
    const bucket = byWorkspace.get(agent.workspaceId);
    if (bucket) {
      bucket.push(agent);
    } else {
      byWorkspace.set(agent.workspaceId, [agent]);
    }
  }

  const groups: WorkspaceGroup[] = [];
  for (const workspace of workspaces) {
    const tabs = byWorkspace.get(workspace.id);
    if (tabs) groups.push({ workspace, tabs: sortTabs(tabs) });
  }
  if (loose.length > 0) groups.push({ workspace: null, tabs: sortTabs(loose) });

  return groups;
}
