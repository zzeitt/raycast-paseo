import { describe, expect, it } from "vitest";
import { describeStatus, describeWorkspaceStatus } from "./status";

describe("describeStatus", () => {
  it("names every status the daemon can report", () => {
    expect(describeStatus("initializing")).toEqual({ label: "Starting", tone: "active" });
    expect(describeStatus("running")).toEqual({ label: "Running", tone: "active" });
    expect(describeStatus("idle")).toEqual({ label: "Idle", tone: "ready" });
    expect(describeStatus("error")).toEqual({ label: "Failed", tone: "failed" });
    expect(describeStatus("closed")).toEqual({ label: "Closed", tone: "unknown" });
  });

  it("passes an unfamiliar status through as its own label", () => {
    expect(describeStatus("paused")).toEqual({ label: "paused", tone: "unknown" });
  });

  it("still has a label when the daemon never reported a status", () => {
    expect(describeStatus("")).toEqual({ label: "Unknown", tone: "unknown" });
  });
});

// Workspaces carry their own status enum, summarised by the daemon from the tabs inside them:
// running/attention/needs_input/failed/done. It is not the agent enum, so it needs its own mapping.
describe("describeWorkspaceStatus", () => {
  it("names every status a workspace can be in", () => {
    expect(describeWorkspaceStatus("running")).toEqual({ label: "Running", tone: "active" });
    expect(describeWorkspaceStatus("attention")).toEqual({ label: "Attention", tone: "active" });
    expect(describeWorkspaceStatus("needs_input")).toEqual({ label: "Needs Input", tone: "active" });
    expect(describeWorkspaceStatus("failed")).toEqual({ label: "Failed", tone: "failed" });
    expect(describeWorkspaceStatus("done")).toEqual({ label: "Done", tone: "ready" });
  });

  it("passes an unfamiliar status through as its own label", () => {
    expect(describeWorkspaceStatus("archiving")).toEqual({ label: "archiving", tone: "unknown" });
  });

  it("still has a label when no status arrived", () => {
    expect(describeWorkspaceStatus("")).toEqual({ label: "Unknown", tone: "unknown" });
  });
});
