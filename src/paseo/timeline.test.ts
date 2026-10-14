import { describe, expect, it } from "vitest";
import { canSendFollowUp, createConversationState, pendingPermission, reduceTimeline, toMarkdown } from "./timeline";

function stream(event: unknown) {
  return {
    type: "agent_stream",
    payload: { agentId: "a1", event, timestamp: "2026-10-09T00:00:00.000Z" },
  } as never;
}

function item(value: unknown) {
  return stream({ type: "timeline", provider: "claude", item: value });
}

describe("reduceTimeline", () => {
  it("concatenates assistant pieces into one block", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "assistant_message", text: "Hello" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: ", world" }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].text).toBe("Hello, world");
  });

  it("starts a new assistant block after a user message", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "assistant_message", text: "first turn" }));
    state = reduceTimeline(state, item({ type: "user_message", text: "again" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "second turn" }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["assistant", "user", "assistant"]);
    expect(state.blocks[2].text).toBe("second turn");
  });

  it("marks the turn finished only on turn_completed", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    expect(state.running).toBe(true);
    state = reduceTimeline(state, item({ type: "assistant_message", text: "ok" }));
    expect(state.running).toBe(true);
    state = reduceTimeline(state, stream({ type: "turn_completed", provider: "claude" }));
    expect(state.running).toBe(false);
    expect(state.blocks.every((b) => b.done)).toBe(true);
  });

  it("records a failed turn as an error block and stops running", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    state = reduceTimeline(state, stream({ type: "turn_failed", provider: "claude", error: "quota exhausted" }));
    expect(state.running).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "error", text: "quota exhausted" });
  });

  it("updates a tool call block in place instead of appending", () => {
    let state = createConversationState();
    state = reduceTimeline(
      state,
      item({
        type: "tool_call",
        callId: "c1",
        name: "Read",
        status: "running",
        detail: { type: "unknown", input: {}, output: null },
      }),
    );
    expect(state.blocks[0]).toMatchObject({ kind: "tool", toolName: "Read", toolStatus: "running" });
    state = reduceTimeline(
      state,
      item({
        type: "tool_call",
        callId: "c1",
        name: "Read",
        status: "completed",
        detail: { type: "unknown", input: {}, output: "ok" },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].toolStatus).toBe("completed");
  });

  it("blocks follow-ups while a turn is running", () => {
    let state = createConversationState();
    expect(canSendFollowUp(state)).toBe(true);
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    expect(canSendFollowUp(state)).toBe(false);
    state = reduceTimeline(state, stream({ type: "turn_completed", provider: "claude" }));
    expect(canSendFollowUp(state)).toBe(true);
  });

  it("surfaces subscription lifecycle messages as notices without breaking the stream", () => {
    let state = createConversationState();
    state = reduceTimeline(state, {
      type: "agent.timeline.subscription_restored",
      payload: { agentId: "a1", subscriptionId: "s1" },
    } as never);
    state = reduceTimeline(state, item({ type: "assistant_message", text: "continue" }));
    expect(state.blocks.at(-1)?.text).toBe("continue");
    expect(state.notices.join()).toContain("reconnect");
  });

  it("reports an observation error", () => {
    const state = reduceTimeline(createConversationState(), {
      type: "agent.timeline.error",
      payload: { agentId: "a1", error: "boom" },
    } as never);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "error", text: "boom" });
  });
});

describe("toMarkdown", () => {
  it("renders the user's question and the assistant answer", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "user_message", text: "workdir is ?" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "it is .paseo" }));
    const markdown = toMarkdown(state);
    expect(markdown).toContain("workdir is ?");
    expect(markdown).toContain("it is .paseo");
  });
});

describe("reasoning fragments", () => {
  it("merges streamed reasoning pieces into one block", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "reasoning", text: "look at " }));
    state = reduceTimeline(state, item({ type: "reasoning", text: "how fragments arrive" }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "reasoning", text: "look at how fragments arrive" });
  });

  it("starts a new reasoning block after the answer", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "reasoning", text: "think" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "answer" }));
    state = reduceTimeline(state, item({ type: "reasoning", text: "think again" }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["reasoning", "assistant", "reasoning"]);
  });
});

describe("permission events", () => {
  const request = {
    id: "req-1",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    title: "Wants to run rm -rf build",
    description: "Delete the build output",
    actions: [
      { id: "a1", label: "Allow once", behavior: "allow", variant: "primary" },
      { id: "a2", label: "Deny", behavior: "deny", variant: "danger" },
    ],
  };

  it("records a permission request as a pending block", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "permission_requested", provider: "claude", request }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "permission", requestId: "req-1", text: "Wants to run rm -rf build" });
    expect(state.blocks[0].actions?.map((a) => a.label)).toEqual(["Allow once", "Deny"]);
    expect(pendingPermission(state)?.requestId).toBe("req-1");
  });

  it("ignores a duplicate request for the same id", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "permission_requested", provider: "claude", request }));
    state = reduceTimeline(state, stream({ type: "permission_requested", provider: "claude", request }));
    expect(state.blocks).toHaveLength(1);
  });

  it("marks the block resolved and stops being pending", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "permission_requested", provider: "claude", request }));
    state = reduceTimeline(
      state,
      stream({ type: "permission_resolved", provider: "claude", requestId: "req-1", resolution: { behavior: "allow" } }),
    );
    expect(state.blocks[0].resolution).toBe("allow");
    expect(pendingPermission(state)).toBeUndefined();
  });

  it("survives a resolved event for an unknown request", () => {
    const state = reduceTimeline(
      createConversationState(),
      stream({ type: "permission_resolved", provider: "claude", requestId: "nope", resolution: { behavior: "deny" } }),
    );
    expect(state.blocks).toHaveLength(0);
  });

  it("carries the questions and the raw input onto the block", () => {
    const request = {
      id: "req-q",
      kind: "question",
      name: "AskUserQuestion",
      input: {
        questions: [
          { question: "Which fruit?", options: [{ label: "Apple" }, { label: "Banana" }], multiSelect: false, allowOther: true },
        ],
      },
    };
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "permission_requested", provider: "claude", request }));

    const block = pendingPermission(state);
    expect(block?.questions?.map((q) => q.prompt)).toEqual(["Which fruit?"]);
    expect(block?.input).toEqual(request.input);
  });
});

describe("toMarkdown collapsing", () => {
  function answered() {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "user_message", text: "what is the workdir?" }));
    state = reduceTimeline(state, item({ type: "reasoning", text: "The user is asking about the workdir; I should check the settings" }));
    state = reduceTimeline(state, item({ type: "tool_call", callId: "c1", name: "Read", status: "completed" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "it is .paseo" }));
    return state;
  }

  it("keeps the answer and hides the reasoning text by default", () => {
    const markdown = toMarkdown(answered());
    expect(markdown).toContain("it is .paseo");
    expect(markdown).toContain("Reasoning");
    expect(markdown).not.toContain("The user is asking about the workdir");
  });

  it("shows the full reasoning when activity is expanded", () => {
    const markdown = toMarkdown(answered(), { showActivity: true });
    expect(markdown).toContain("The user is asking about the workdir");
    expect(markdown).toContain("it is .paseo");
  });

  it("keeps each tool call on its own compact line", () => {
    const markdown = toMarkdown(answered());
    expect(markdown).toContain("Read");
    expect(markdown).toContain("completed");
  });

  it("does not chop the body with horizontal rules", () => {
    expect(toMarkdown(answered())).not.toContain("\n---\n");
  });

  it("always shows a pending permission request, collapsed or not", () => {
    let state = createConversationState();
    state = reduceTimeline(
      state,
      stream({
        type: "permission_requested",
        provider: "claude",
        request: { id: "req-2", kind: "question", title: "Which branch?", description: "main or feature", actions: [{ id: "x", label: "main", behavior: "allow" }] },
      }),
    );
    for (const options of [{}, { showActivity: true }]) {
      const markdown = toMarkdown(state, options);
      expect(markdown).toContain("Which branch?");
      expect(markdown).toContain("main");
    }
  });
});
