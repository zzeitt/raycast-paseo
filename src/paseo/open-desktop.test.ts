import { describe, expect, it, vi } from "vitest";
import { createOpenDesktopAction } from "./open-desktop";

function deps(overrides: { open?: (target: unknown) => Promise<void> } = {}) {
  return {
    open: vi.fn(overrides.open ?? (async () => undefined)),
    notify: vi.fn(async () => undefined),
  };
}

describe("createOpenDesktopAction", () => {
  it("opens the agent without notifying when everything works", async () => {
    const d = deps();
    await createOpenDesktopAction({ serverId: "srv_1", agentId: "a1", preferredPath: "D:\\Paseo.exe" }, d)();
    expect(d.open).toHaveBeenCalledWith({ serverId: "srv_1", agentId: "a1", preferredPath: "D:\\Paseo.exe" });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("surfaces the actionable reason when the app cannot be launched", async () => {
    const d = deps({
      open: async () => {
        throw new Error("Paseo.exe was not found. Set the \"Paseo.exe path\" in the extension settings.");
      },
    });
    await createOpenDesktopAction({ serverId: "srv_1", agentId: "a1" }, d)();
    expect(d.notify).toHaveBeenCalledWith("Paseo.exe was not found. Set the \"Paseo.exe path\" in the extension settings.");
  });

  it("says so instead of doing nothing when the server id is still unknown", async () => {
    const d = deps();
    await createOpenDesktopAction({ serverId: "  ", agentId: "a1" }, d)();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("server id"));
  });
});
