import { describe, expect, it } from "vitest";
import {
  RECENT_WORKSPACES_KEY,
  recallWorkspace,
  recentWorkspace,
  rememberWorkspace,
  withRecentWorkspace,
} from "./recent-choices";
import type { ChoiceStore } from "./recent-choices";

/** A stand-in for Raycast's LocalStorage, which is the only thing the real code touches. */
function fakeStore(initial: Record<string, string> = {}): ChoiceStore & { items: Record<string, string> } {
  const items = { ...initial };
  return {
    items,
    getItem: async (key) => items[key] ?? null,
    setItem: async (key, value) => {
      items[key] = value;
    },
  };
}

const choice = (id: string, path = `/repo/${id}`) => ({ id, path });

describe("recentWorkspace", () => {
  it("reads back the workspace remembered for that host", () => {
    expect(recentWorkspace('{"srv_one":{"id":"wks_a","path":"/a"}}', "srv_one")).toEqual(choice("wks_a", "/a"));
  });

  it("has nothing to say about a host it has never seen", () => {
    expect(recentWorkspace('{"srv_one":{"id":"wks_a","path":"/a"}}', "srv_two")).toBeNull();
  });

  it("shrugs off whatever is in storage when it is not the shape it wrote", () => {
    expect(recentWorkspace("not json at all", "srv_one")).toBeNull();
    expect(recentWorkspace("[1,2]", "srv_one")).toBeNull();
    expect(recentWorkspace(null, "srv_one")).toBeNull();
    // An id with no path is of no use: the path is what the agent starts in.
    expect(recentWorkspace('{"srv_one":{"id":"wks_a"}}', "srv_one")).toBeNull();
  });
});

describe("withRecentWorkspace", () => {
  it("records the workspace under its host", () => {
    expect(JSON.parse(withRecentWorkspace(null, "srv_one", choice("wks_a")))).toEqual({
      srv_one: { id: "wks_a", path: "/repo/wks_a" },
    });
  });

  it("keeps what other hosts remember", () => {
    const stored = '{"srv_one":{"id":"wks_a","path":"/a"}}';
    expect(JSON.parse(withRecentWorkspace(stored, "srv_two", choice("wks_b")))).toEqual({
      srv_one: { id: "wks_a", path: "/a" },
      srv_two: { id: "wks_b", path: "/repo/wks_b" },
    });
  });

  it("replaces the previous choice for the same host", () => {
    const stored = '{"srv_one":{"id":"wks_a","path":"/a"}}';
    expect(JSON.parse(withRecentWorkspace(stored, "srv_one", choice("wks_c")))).toEqual({
      srv_one: { id: "wks_c", path: "/repo/wks_c" },
    });
  });

  it("starts over rather than throwing when what is stored is unreadable", () => {
    expect(JSON.parse(withRecentWorkspace("junk", "srv_one", choice("wks_a")))).toEqual({
      srv_one: { id: "wks_a", path: "/repo/wks_a" },
    });
  });
});

describe("rememberWorkspace / recallWorkspace", () => {
  it("round-trips a choice through the store", async () => {
    const store = fakeStore();
    await rememberWorkspace(store, "srv_one", choice("wks_a"));
    expect(await recallWorkspace(store, "srv_one")).toEqual(choice("wks_a"));
    expect(store.items[RECENT_WORKSPACES_KEY]).toBeTruthy();
  });

  it("remembers nothing before anything has been asked", async () => {
    expect(await recallWorkspace(fakeStore(), "srv_one")).toBeNull();
  });

  it("carries on when the store itself fails", async () => {
    const failing: ChoiceStore = {
      getItem: async () => {
        throw new Error("no storage");
      },
      setItem: async () => {
        throw new Error("no storage");
      },
    };
    await expect(recallWorkspace(failing, "srv_one")).resolves.toBeNull();
  });
});
