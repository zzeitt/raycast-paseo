import { describe, expect, it } from "vitest";
import { resolveMode, resolveProviderChoice, targetDefaults } from "./preferences";

describe("resolveMode", () => {
  it("passes the session mode through", () => {
    expect(resolveMode("auto")).toBe("auto");
  });

  it("trims it", () => {
    expect(resolveMode("  bypassPermissions ")).toBe("bypassPermissions");
  });

  // An empty field has to mean "let the daemon decide", not "send an empty mode id" — which the
  // daemon would either reject or read as a mode that does not exist.
  it("says nothing when the field is empty", () => {
    expect(resolveMode(undefined)).toBeUndefined();
    expect(resolveMode("   ")).toBeUndefined();
  });
});

describe("resolveProviderChoice", () => {
  it("defaults to claude with no model when nothing is configured", () => {
    expect(resolveProviderChoice(undefined, undefined)).toEqual({ provider: "claude" });
  });

  it("passes a plain provider and a separate model through", () => {
    expect(resolveProviderChoice("codex", "gpt-5.4")).toEqual({ provider: "codex", model: "gpt-5.4" });
  });

  it("keeps a provider/model composite untouched", () => {
    expect(resolveProviderChoice("claude/deepseek-v4-pro[1m]", undefined)).toEqual({
      provider: "claude/deepseek-v4-pro[1m]",
    });
  });

  it("drops the separate model when the provider already names one", () => {
    // When the two fields contradict each other the provider wins; both package.json and the README state this rule.
    expect(resolveProviderChoice("claude/deepseek-v4-pro[1m]", "gpt-5")).toEqual({
      provider: "claude/deepseek-v4-pro[1m]",
    });
  });

  it("treats whitespace as empty", () => {
    expect(resolveProviderChoice("  ", "   ")).toEqual({ provider: "claude" });
    expect(resolveProviderChoice(" claude ", " gpt-5 ")).toEqual({ provider: "claude", model: "gpt-5" });
  });
});

describe("targetDefaults", () => {
  it("gives Ask the fields named after it", () => {
    expect(targetDefaults({ defaultWorkspace: "D:\\ask-ws", defaultCwd: "D:\\ask-cwd" }, "ask")).toEqual({
      workspace: "D:\\ask-ws",
      cwd: "D:\\ask-cwd",
    });
  });

  it("gives Quick the fields named after it", () => {
    expect(targetDefaults({ quickWorkspace: "D:\\quick-ws", quickCwd: "D:\\quick-cwd" }, "quick")).toEqual({
      workspace: "D:\\quick-ws",
      cwd: "D:\\quick-cwd",
    });
  });

  // The point of two sets: a Quick slot left unconfigured goes wherever Quick goes, not where Ask goes.
  // A fallback here would make Quick impossible to leave unset while Ask has a default, which is the
  // coupling the split exists to remove.
  it("never lets Quick fall back to Ask's fields", () => {
    expect(targetDefaults({ defaultWorkspace: "D:\\ask-ws", defaultCwd: "D:\\ask" }, "quick")).toEqual({});
  });

  it("never lets Ask fall back to Quick's fields", () => {
    expect(targetDefaults({ quickWorkspace: "D:\\quick-ws", quickCwd: "D:\\quick" }, "ask")).toEqual({});
  });

  // Which host to start on is one answer, not two: the same machine is no less this machine when a
  // Quick slot runs.
  it("keeps the host shared between the two", () => {
    const prefs = { defaultHost: "desk" };
    expect(targetDefaults(prefs, "ask").host).toBe("desk");
    expect(targetDefaults(prefs, "quick").host).toBe("desk");
  });

  it("trims, and reads a blank field as unset", () => {
    expect(targetDefaults({ defaultWorkspace: "  ", defaultCwd: "  D:\\b  " }, "ask")).toEqual({ cwd: "D:\\b" });
    expect(targetDefaults({}, "ask")).toEqual({});
  });
});
