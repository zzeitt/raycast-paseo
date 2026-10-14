import { describe, expect, it, vi } from "vitest";
import type { AgentRow } from "./agents";
import {
  groupAgentsByWorkspace,
  includeArchivedFor,
  listWorkspaces,
  scopeAgents,
  sortWorkspaceRows,
  toWorkspaceRow,
} from "./workspaces";

const agent = (overrides: Partial<AgentRow> & { id: string }): AgentRow => ({
  title: overrides.id,
  status: "idle",
  cwd: "/x",
  updatedAt: "2026-10-09T00:00:00.000Z",
  archivedAt: null,
  workspaceId: "wks_1",
  ...overrides,
});

describe("toWorkspaceRow", () => {
  it("maps the daemon descriptor to the fields the list view needs", () => {
    expect(
      toWorkspaceRow({
        id: "wks_1",
        name: "raycast-paseo",
        title: "new icon, OOM fix",
        projectDisplayName: "Workshop",
        projectCustomName: "Acme",
        projectRootPath: "D:\\Acme\\Workshop",
        workspaceDirectory: "D:\\Acme\\Workshop\\raycast-paseo",
        status: "attention",
        pinnedAt: "2026-10-09T02:00:00.000Z",
        activityAt: "2026-10-09T03:00:00.000Z",
      }),
    ).toEqual({
      id: "wks_1",
      title: "new icon, OOM fix",
      project: "Acme",
      directory: "D:\\Acme\\Workshop\\raycast-paseo",
      status: "attention",
      pinned: true,
      activityAt: "2026-10-09T03:00:00.000Z",
    });
  });

  it("falls back to the workspace name when the user has not renamed it", () => {
    expect(toWorkspaceRow({ id: "w", name: "main", title: null }).title).toBe("main");
  });

  it("falls back to the project root when there is no workspace directory", () => {
    expect(toWorkspaceRow({ id: "w", name: "n", projectRootPath: "/repo" }).directory).toBe("/repo");
  });

  it("treats a missing or blank pinnedAt as not pinned", () => {
    expect(toWorkspaceRow({ id: "w", name: "n", pinnedAt: null }).pinned).toBe(false);
    expect(toWorkspaceRow({ id: "w", name: "n", pinnedAt: "   " }).pinned).toBe(false);
  });

  it("survives a descriptor with nothing on it", () => {
    expect(toWorkspaceRow({})).toEqual({
      id: "",
      title: "",
      project: "",
      directory: "",
      status: "unknown",
      pinned: false,
      activityAt: "",
    });
  });
});

describe("sortWorkspaceRows", () => {
  const row = (id: string, overrides: Partial<ReturnType<typeof toWorkspaceRow>> = {}) => ({
    id,
    title: id,
    project: "",
    directory: "",
    status: "done",
    pinned: false,
    activityAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  });

  it("keeps pinned workspaces in front of everything else", () => {
    const rows = sortWorkspaceRows([
      row("recent", { activityAt: "2026-10-09T09:00:00.000Z" }),
      row("pinned", { pinned: true, activityAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["pinned", "recent"]);
  });

  it("orders the rest by most recent activity", () => {
    const rows = sortWorkspaceRows([
      row("older", { activityAt: "2026-10-08T00:00:00.000Z" }),
      row("newer", { activityAt: "2026-10-09T00:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("breaks a tie by title so the order does not wobble between refreshes", () => {
    const rows = sortWorkspaceRows([row("b-title", { title: "beta" }), row("a-title", { title: "alpha" })]);
    expect(rows.map((r) => r.title)).toEqual(["alpha", "beta"]);
  });
});

describe("groupAgentsByWorkspace", () => {
  const wks = (id: string) => toWorkspaceRow({ id, name: id });

  it("puts each tab under its workspace and keeps the workspace order it was given", () => {
    const groups = groupAgentsByWorkspace(
      [agent({ id: "a1", workspaceId: "wks_a" }), agent({ id: "b1", workspaceId: "wks_b" })],
      [wks("wks_b"), wks("wks_a")],
    );
    expect(groups.map((g) => g.workspace?.id)).toEqual(["wks_b", "wks_a"]);
    expect(groups[0].tabs.map((t) => t.id)).toEqual(["b1"]);
  });

  it("leaves out workspaces that have no tabs at all", () => {
    const groups = groupAgentsByWorkspace([agent({ id: "a1", workspaceId: "wks_a" })], [wks("wks_a"), wks("wks_empty")]);
    expect(groups.map((g) => g.workspace?.id)).toEqual(["wks_a"]);
  });

  it("shows the most recently updated tab first inside a workspace", () => {
    const groups = groupAgentsByWorkspace(
      [
        agent({ id: "old", updatedAt: "2026-10-08T00:00:00.000Z" }),
        agent({ id: "new", updatedAt: "2026-10-09T00:00:00.000Z" }),
      ],
      [wks("wks_1")],
    );
    expect(groups[0].tabs.map((t) => t.id)).toEqual(["new", "old"]);
  });

  // An agent can outlive the workspace entry we can see: the workspace is archived, or it never
  // made it into the list we fetched. Dropping those tabs would hide exactly the ones that need
  // attention, so they get a trailing group instead.
  it("keeps tabs whose workspace is not in the list, in a trailing group", () => {
    const groups = groupAgentsByWorkspace(
      [agent({ id: "a1", workspaceId: "wks_a" }), agent({ id: "orphan", workspaceId: "wks_gone" })],
      [wks("wks_a")],
    );
    expect(groups.map((g) => g.workspace)).toEqual([expect.objectContaining({ id: "wks_a" }), null]);
    expect(groups[1].tabs.map((t) => t.id)).toEqual(["orphan"]);
  });

  it("keeps tabs that carry no workspace id at all in that same trailing group", () => {
    const groups = groupAgentsByWorkspace(
      [agent({ id: "a1" }), agent({ id: "loose", workspaceId: undefined })],
      [wks("wks_1")],
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].tabs.map((t) => t.id)).toEqual(["loose"]);
  });
});

describe("listWorkspaces", () => {
  it("maps and sorts what the daemon returned", async () => {
    const fetchWorkspaces = vi.fn(async () => ({
      entries: [
        { id: "old", name: "old", activityAt: "2026-10-08T00:00:00.000Z" },
        { id: "new", name: "new", activityAt: "2026-10-09T00:00:00.000Z" },
      ],
    }));
    const rows = await listWorkspaces({ fetchWorkspaces } as never);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

// The daemon can only be asked for "include archived or not" — it has no archived-only filter — so
// the archived scope is the two together, trimmed on our side. Both list levels share this.
describe("scopeAgents", () => {
  const live = agent({ id: "live", workspaceId: "wks_1", archivedAt: null });
  const gone = agent({ id: "gone", workspaceId: "wks_1", archivedAt: "2026-10-01T00:00:00.000Z" });

  it("keeps only the live tabs in the active scope, whatever arrived", () => {
    expect(scopeAgents([live, gone], "active").map((a) => a.id)).toEqual(["live"]);
  });

  it("keeps both in the all scope", () => {
    expect(scopeAgents([live, gone], "all").map((a) => a.id)).toEqual(["live", "gone"]);
  });

  it("keeps only the archived tabs in the archived scope", () => {
    expect(scopeAgents([live, gone], "archived").map((a) => a.id)).toEqual(["gone"]);
  });

  it("tells the caller whether the daemon needs to include archived tabs at all", () => {
    expect(includeArchivedFor("active")).toBe(false);
    expect(includeArchivedFor("all")).toBe(true);
    expect(includeArchivedFor("archived")).toBe(true);
  });
});
