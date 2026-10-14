import { describe, expect, it } from "vitest";
import { matchHost } from "./hosts";
import type { HostRow } from "./hosts";
import { matchWorkspace } from "./workspaces";
import type { WorkspaceRow } from "./workspaces";

const host = (label: string, serverId = `srv_${label}`): HostRow => ({
  serverId,
  label,
  color: null,
  endpoint: "127.0.0.1:1",
});

const workspace = (title: string, directory: string, id = title): WorkspaceRow => ({
  id,
  title,
  project: "",
  directory,
  status: "done",
  pinned: false,
  activityAt: "",
});

describe("matchHost", () => {
  it("finds a host by the label shown in Paseo", () => {
    expect(matchHost([host("desk-pc"), host("desk-laptop")], "desk-laptop")?.label).toBe("desk-laptop");
  });

  it("does not care about case", () => {
    expect(matchHost([host("desk-laptop")], "DESK-LAPTOP")?.label).toBe("desk-laptop");
  });

  it("accepts the server id too", () => {
    expect(matchHost([host("desk-laptop", "srv_abcdef123456")], "srv_abcdef123456")?.label).toBe("desk-laptop");
  });

  it("takes a unique prefix, so half a name is enough", () => {
    expect(matchHost([host("desk-pc"), host("desk-laptop")], "desk-l")?.label).toBe("desk-laptop");
  });

  // Two candidates and no exact match means the input did not identify one host, and picking
  // either would be a coin toss the user never asked for.
  it("refuses to choose when the input fits more than one host", () => {
    expect(matchHost([host("desk-pc"), host("desk-laptop")], "desk")).toBeNull();
  });

  it("has no opinion about an empty query", () => {
    expect(matchHost([host("desk-pc")], "   ")).toBeNull();
  });
});

describe("matchWorkspace", () => {
  it("finds a workspace by its title", () => {
    const rows = [workspace("new icon, OOM fix", "/repo/worktrees/a"), workspace("main", "/repo")];
    expect(matchWorkspace(rows, "new icon, OOM fix")?.directory).toBe("/repo/worktrees/a");
  });

  it("finds one by the last part of its directory, which is what the branch is called", () => {
    const rows = [workspace("Untitled workspace", "D:\\Acme\\Workshop\\raycast-paseo")];
    expect(matchWorkspace(rows, "raycast-paseo")?.directory).toContain("raycast-paseo");
  });

  // A path is what you have to hand when you are looking at the directory rather than the list.
  it("finds one by its whole directory", () => {
    const rows = [workspace("new icon", "/home/me/repo")];
    expect(matchWorkspace(rows, "/home/me/repo")?.id).toBe("new icon");
  });

  // Only exactly: two workspaces can live under one parent, and a shared prefix would pick between
  // them arbitrarily.
  it("does not take a partial path", () => {
    const rows = [workspace("a", "/home/me/repo-one"), workspace("b", "/home/me/repo-two")];
    expect(matchWorkspace(rows, "/home/me/repo")).toBeNull();
  });

  it("takes a unique partial title", () => {
    const rows = [workspace("acme timesheet", "/a"), workspace("notes cli", "/b")];
    expect(matchWorkspace(rows, "timesheet")?.id).toBe("acme timesheet");
  });

  it("refuses to choose between several partial matches", () => {
    const rows = [workspace("acme vml", "/a"), workspace("acme hpp", "/b")];
    expect(matchWorkspace(rows, "acme")).toBeNull();
  });

  it("has no opinion about an empty query", () => {
    expect(matchWorkspace([workspace("main", "/repo")], "")).toBeNull();
  });
});
