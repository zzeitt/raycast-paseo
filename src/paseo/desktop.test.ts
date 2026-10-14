import { describe, expect, it, vi } from "vitest";
import { buildAgentDeepLink, describeDesktopOpenError, openAgentInDesktop, paseoAppCandidates } from "./desktop";

describe("buildAgentDeepLink", () => {
  it("matches paseo's own deep link format", () => {
    expect(buildAgentDeepLink("srv_0123456789ab", "abc123")).toBe("paseo://h/srv_0123456789ab/agent/abc123");
  });

  it("percent-encodes both ids", () => {
    expect(buildAgentDeepLink("srv/a", "id b")).toBe("paseo://h/srv%2Fa/agent/id%20b");
  });

  it("agrees with the deep link builder paseo itself ships", async () => {
    const { buildAgentDeepLink: theirs } = await import("@getpaseo/protocol/agent-deep-link");
    for (const [serverId, agentId] of [
      ["srv_0123456789ab", "abc123"],
      ["srv/a", "id b"],
      ["  padded  ", "  also padded  "],
    ]) {
      expect(buildAgentDeepLink(serverId, agentId)).toBe(theirs({ serverId, agentId }));
    }
  });

  it("builds a link paseo's own parser can read back", async () => {
    const { parseAgentDeepLink } = await import("@getpaseo/protocol/agent-deep-link");
    for (const [serverId, agentId] of [
      ["srv_0123456789ab", "abc123"],
      ["srv/a", "id b"],
    ]) {
      expect(parseAgentDeepLink(buildAgentDeepLink(serverId, agentId))).toEqual({ serverId, agentId });
    }
  });

  it("refuses an empty id instead of building a link nothing can parse", () => {
    expect(() => buildAgentDeepLink("", "a1")).toThrow();
    expect(() => buildAgentDeepLink("srv1", "   ")).toThrow();
  });
});

describe("paseoAppCandidates", () => {
  it("prefers the local app data install", () => {
    const candidates = paseoAppCandidates({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(candidates[0]).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\Paseo.exe");
  });

  it("returns nothing when LOCALAPPDATA is unset", () => {
    expect(paseoAppCandidates({})).toEqual([]);
  });
});

describe("openAgentInDesktop", () => {
  it("launches the preferred executable with the deep link", async () => {
    const launch = vi.fn(async () => undefined);
    await openAgentInDesktop({
      serverId: "srv1",
      agentId: "a1",
      preferredPath: "D:\\Apps\\Paseo\\Paseo.exe",
      launch,
      exists: () => true,
    });
    expect(launch).toHaveBeenCalledWith("D:\\Apps\\Paseo\\Paseo.exe", ["paseo://h/srv1/agent/a1"]);
  });

  it("falls back to a discovered path", async () => {
    const launch = vi.fn(async () => undefined);
    await openAgentInDesktop({
      serverId: "srv1",
      agentId: "a1",
      launch,
      // Named rather than read from the machine: discovery needs LOCALAPPDATA, which a Linux CI
      // runner does not have, so this used to depend on where the test happened to run.
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      exists: (path) => path.endsWith("Programs\\Paseo\\Paseo.exe"),
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("throws a hint when no executable is found", async () => {
    await expect(
      openAgentInDesktop({ serverId: "srv1", agentId: "a1", launch: vi.fn(), exists: () => false }),
    ).rejects.toThrow(/Paseo\.exe/);
  });
});

describe("describeDesktopOpenError", () => {
  it("surfaces the actionable message the opener produced", () => {
    expect(describeDesktopOpenError(new Error("Paseo.exe was not found. Set the \"Paseo.exe path\" in the extension settings."))).toBe(
      "Paseo.exe was not found. Set the \"Paseo.exe path\" in the extension settings.",
    );
  });

  it("falls back to a readable line for a non-Error throw", () => {
    expect(describeDesktopOpenError("boom")).toContain("Failed to open in desktop");
  });

  it("falls back when the error carries no message", () => {
    expect(describeDesktopOpenError(new Error("   "))).toContain("Failed to open in desktop");
  });
});
