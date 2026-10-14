import { describe, expect, it, vi } from "vitest";
import { listAgents, startAgent, stopAgent, toAgentRow } from "./agents";

describe("toAgentRow", () => {
  it("maps the daemon snapshot to the fields the list view needs", () => {
    const row = toAgentRow({
      id: "abc123",
      title: "ask about the paseo workdir",
      status: "idle",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      workspaceId: "wks_4e03",
      updatedAt: "2026-10-09T03:00:00.000Z",
      archivedAt: null,
    });
    expect(row).toEqual({
      id: "abc123",
      title: "ask about the paseo workdir",
      status: "idle",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      workspaceId: "wks_4e03",
      updatedAt: "2026-10-09T03:00:00.000Z",
      archivedAt: null,
    });
  });

  it("falls back to the short id when the agent has no title", () => {
    expect(toAgentRow({ id: "abcdef123456", title: null }).title).toBe("abcdef1");
  });

  it("leaves workspaceId unset when the daemon did not send one", () => {
    expect(toAgentRow({ id: "a" }).workspaceId).toBeUndefined();
  });
});

describe("listAgents", () => {
  it("drops archived agents by default", async () => {
    const client = {
      fetchAgents: vi.fn(async () => ({
        entries: [
          { agent: { id: "a", title: "keep", status: "idle", cwd: "/x", updatedAt: "t", archivedAt: null } },
          {
            agent: {
              id: "b",
              title: "gone",
              status: "idle",
              cwd: "/x",
              updatedAt: "t",
              archivedAt: "2026-10-01T00:00:00.000Z",
            },
          },
        ],
      })),
    };
    const rows = await listAgents(client as never);
    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("keeps archived agents when asked", async () => {
    const client = {
      fetchAgents: vi.fn(async () => ({
        entries: [
          {
            agent: {
              id: "b",
              title: "gone",
              status: "idle",
              cwd: "/x",
              updatedAt: "t",
              archivedAt: "2026-10-01T00:00:00.000Z",
            },
          },
        ],
      })),
    };
    const rows = await listAgents(client as never, { includeArchived: true });
    expect(rows).toHaveLength(1);
  });
});

describe("startAgent", () => {
  it("passes provider, cwd and prompt through", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-1" }));
    const id = await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      prompt: "workdir is ?",
    });
    expect(id).toBe("new-1");
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude",
        cwd: "D:\\Acme\\Workshop\\.paseo",
        initialPrompt: "workdir is ?",
      }),
    );
  });

  // CreateAgentRequestOptions.labels is declared at daemon-client.d.ts:187 and
  // forwarded at daemon-client.js:1659, so the tag actually reaches the daemon.
  it("passes labels through so the daemon can tell where the agent came from", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-3" }));
    await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "/x",
      prompt: "hi",
      labels: { source: "raycast" },
    });
    expect((createAgent.mock.calls[0][0] as Record<string, unknown>).labels).toEqual({ source: "raycast" });
  });

  // CreateAgentRequestOptions.workspaceId (daemon-client.d.ts:174) is how a new agent joins the
  // workspace you meant rather than being placed by its cwd.
  it("puts the agent in the workspace it was given", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-4" }));
    await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "/repo/worktrees/a",
      workspaceId: "wks_a",
      prompt: "hi",
    });
    expect(createAgent.mock.calls[0][0]).toMatchObject({ workspaceId: "wks_a", cwd: "/repo/worktrees/a" });
  });

  // AgentSessionConfig.modeId (messages.js:299) is the session mode: "auto" is one of the ids the
  // claude provider lists, alongside plan, default, acceptEdits and bypassPermissions.
  it("starts the agent in the session mode it was given", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-6" }));
    await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "/x",
      mode: "auto",
      prompt: "hi",
    });
    expect(createAgent.mock.calls[0][0]).toMatchObject({ modeId: "auto" });
  });

  it("leaves the session mode to the daemon when none was given", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-7" }));
    await startAgent({ createAgent } as never, { provider: "claude", cwd: "/x", prompt: "hi" });
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("modeId");
  });

  it("leaves the placement to the daemon when no workspace was given", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-5" }));
    await startAgent({ createAgent } as never, { provider: "claude", cwd: "/x", prompt: "hi" });
    expect(createAgent.mock.calls[0][0]).not.toHaveProperty("workspaceId");
  });

  it("omits model, title and labels entirely when they are not given", async () => {
    const createAgent = vi.fn(async (_options: Record<string, unknown>) => ({ id: "new-2" }));
    await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "/x",
      prompt: "hi",
      model: "   ",
    });
    const options = createAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("model");
    expect(options).not.toHaveProperty("title");
    expect(options).not.toHaveProperty("labels");
  });

  it("refuses a daemon response with no agent id", async () => {
    const createAgent = vi.fn(async () => ({}));
    await expect(startAgent({ createAgent } as never, { provider: "claude", cwd: "/x", prompt: "hi" })).rejects.toThrow(
      /agent id/,
    );
  });
});

describe("stopAgent", () => {
  it("calls cancelAgent", async () => {
    const cancelAgent = vi.fn(async () => undefined);
    await stopAgent({ cancelAgent } as never, "a1");
    expect(cancelAgent).toHaveBeenCalledWith("a1");
  });
});
