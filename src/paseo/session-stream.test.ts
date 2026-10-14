import { describe, expect, it, vi } from "vitest";
import { isRedundant, seqWindow, startConversationStream } from "./session-stream";
import type { ConversationState, TimelineInput } from "./timeline";

type Handler = (message: TimelineInput) => void;

function historyPage(entries: Array<{ provider?: string; item: unknown }>, startSeq: number, endSeq: number, epoch = "e1") {
  return { entries, startCursor: { epoch, seq: startSeq }, endCursor: { epoch, seq: endSeq }, epoch };
}

function liveItem(seq: number, item: unknown, epoch = "e1"): TimelineInput {
  return { type: "agent_stream", payload: { seq, epoch, event: { type: "timeline", item } } };
}

/** A controllable throttler: the test decides when the accumulated state is flushed. */
function manualScheduler() {
  const flushes: Array<() => void> = [];
  return {
    flushes,
    schedule: (flush: () => void) => {
      flushes.push(flush);
      return () => {
        const index = flushes.indexOf(flush);
        if (index >= 0) flushes.splice(index, 1);
      };
    },
    run: () => {
      for (const flush of [...flushes]) flush();
    },
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeClientOptions {
  onSubscribe?: (handler: Handler) => void;
  ready?: Promise<void>;
  release?: () => void;
  fetchTimeline?: () => Promise<unknown>;
  fetchAgent?: () => Promise<unknown>;
}

function fakeClient(options: FakeClientOptions = {}) {
  return {
    subscribeAgentTimeline: vi.fn((_agentId: string, handler: Handler) => {
      options.onSubscribe?.(handler);
      return { ready: options.ready ?? Promise.resolve(), release: options.release ?? (() => undefined) };
    }),
    fetchAgentTimeline: vi.fn(options.fetchTimeline ?? (async () => historyPage([], 1, 1))),
    fetchAgent: vi.fn(options.fetchAgent ?? (async () => ({ agent: { status: "idle" } }))),
  };
}

describe("seqWindow", () => {
  it("spans the page's cursor range", () => {
    expect(seqWindow(historyPage([], 10, 20))).toEqual({ epoch: "e1", startSeq: 10, endSeq: 20 });
  });

  it("is null when the page carries no cursors", () => {
    expect(seqWindow({ entries: [] })).toBeNull();
  });
});

describe("isRedundant", () => {
  const window = { epoch: "e1", startSeq: 10, endSeq: 20 };

  it("drops a live message the history page already covers", () => {
    expect(isRedundant(liveItem(15, { type: "assistant_message", text: "x" }), window)).toBe(true);
  });

  it("keeps a live message past the page's end", () => {
    expect(isRedundant(liveItem(21, { type: "assistant_message", text: "x" }), window)).toBe(false);
  });

  it("keeps a live message from before the page's start", () => {
    // The page only holds the last 200; earlier events are not on this page and must not be dropped as duplicates.
    expect(isRedundant(liveItem(3, { type: "assistant_message", text: "x" }), window)).toBe(false);
  });

  it("keeps a live message from another epoch", () => {
    expect(isRedundant(liveItem(15, { type: "assistant_message", text: "x" }, "e2"), window)).toBe(false);
  });

  it("keeps a message with no seq at all — it cannot be matched", () => {
    expect(isRedundant({ type: "agent.timeline.subscription_restored", payload: {} }, window)).toBe(false);
  });

  it("keeps everything when there is no window", () => {
    expect(isRedundant(liveItem(15, { type: "assistant_message", text: "x" }), null)).toBe(false);
  });
});

describe("startConversationStream", () => {
  it("lands history first, and does not re-count a live fragment the history page already covers", async () => {
    const assistant = { type: "assistant_message", text: "new fragment" };
    const client = fakeClient({
      onSubscribe: (handler) => {
        // While history was being fetched, the live stream arrived first — and this one is also inside the seq range the history page covers.
        queueMicrotask(() => handler(liveItem(10005, assistant)));
      },
      fetchTimeline: async () =>
        historyPage([{ provider: "claude", item: { type: "user_message", text: "hi" } }, { provider: "claude", item: assistant }], 9984, 10009),
    });
    const scheduler = manualScheduler();
    const states: ConversationState[] = [];

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState: (state) => states.push(state),
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    await handle.settled;

    expect(states).toHaveLength(1);
    expect(states[0].blocks.map((block) => [block.kind, block.text])).toEqual([
      ["user", "hi"],
      ["assistant", "new fragment"],
    ]);
  });

  it("appends live fragments that arrive after the history page", async () => {
    const client = fakeClient({
      onSubscribe: (handler) => {
        (client as unknown as { handler: Handler }).handler = handler;
      },
      fetchTimeline: async () => historyPage([{ provider: "claude", item: { type: "assistant_message", text: "first half" } }], 1, 5),
    });
    const scheduler = manualScheduler();
    const states: ConversationState[] = [];

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState: (state) => states.push(state),
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    await handle.settled;

    (client as unknown as { handler: Handler }).handler(liveItem(6, { type: "assistant_message", text: "second half" }));
    scheduler.run();

    expect(states.at(-1)?.blocks.map((block) => block.text)).toEqual(["first halfsecond half"]);
  });

  it("tears down without painting or starting a timer when stopped before the subscription is ready", async () => {
    let resolveReady: () => void = () => undefined;
    const release = vi.fn();
    const client = fakeClient({
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
      release,
    });
    const scheduler = manualScheduler();
    const onState = vi.fn();

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState,
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    handle.stop();
    resolveReady();
    await handle.settled;

    expect(onState).not.toHaveBeenCalled();
    expect(scheduler.flushes).toHaveLength(0);
    expect(client.fetchAgentTimeline).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("tears down when stopped while the history page is still in flight", async () => {
    let resolvePage: (page: unknown) => void = () => undefined;
    const release = vi.fn();
    const client = fakeClient({
      release,
      fetchTimeline: () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    });
    const scheduler = manualScheduler();
    const onState = vi.fn();

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState,
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    await tick();
    handle.stop();
    resolvePage(historyPage([{ provider: "claude", item: { type: "user_message", text: "hi" } }], 1, 5));
    await handle.settled;

    expect(onState).not.toHaveBeenCalled();
    expect(scheduler.flushes).toHaveLength(0);
    expect(release).toHaveBeenCalled();
  });

  it("re-derives running from the daemon after a reconnect instead of staying stuck on", async () => {
    let handler: Handler = () => undefined;
    const client = fakeClient({
      onSubscribe: (next) => {
        handler = next;
      },
      fetchTimeline: async () => historyPage([], 1, 5),
      fetchAgent: async () => ({ agent: { status: "idle" } }),
    });
    const scheduler = manualScheduler();
    const states: ConversationState[] = [];

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState: (state) => states.push(state),
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    await handle.settled;

    handler({ type: "agent_stream", payload: { event: { type: "turn_started" } } });
    scheduler.run();
    expect(states.at(-1)?.running).toBe(true);

    handler({ type: "agent.timeline.subscription_restored", payload: { agentId: "a1", subscriptionId: "s1" } });
    await tick();
    scheduler.run();

    expect(states.at(-1)?.running).toBe(false);
    expect(states.at(-1)?.notices.join("")).toContain("reconnect");
  });

  it("keeps the last known state when the post-reconnect probe fails", async () => {
    let handler: Handler = () => undefined;
    const client = fakeClient({
      onSubscribe: (next) => {
        handler = next;
      },
      fetchTimeline: async () => historyPage([], 1, 5),
      fetchAgent: async () => {
        throw new Error("the daemon went down again");
      },
    });
    const scheduler = manualScheduler();
    const states: ConversationState[] = [];
    const onError = vi.fn();

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState: (state) => states.push(state),
      onError,
      schedule: scheduler.schedule,
    });
    await handle.settled;

    handler({ type: "agent_stream", payload: { event: { type: "turn_started" } } });
    scheduler.run();
    handler({ type: "agent.timeline.subscription_restored", payload: { agentId: "a1", subscriptionId: "s1" } });
    await tick();
    scheduler.run();

    expect(onError).not.toHaveBeenCalled();
    expect(states.at(-1)?.running).toBe(true);
  });

  it("paints history even when nothing arrives over the wire", async () => {
    const client = fakeClient({
      fetchTimeline: async () =>
        historyPage(
          [
            { provider: "claude", item: { type: "user_message", text: "first question" } },
            { provider: "claude", item: { type: "assistant_message", text: "first answer" } },
          ],
          1,
          2,
        ),
    });
    const scheduler = manualScheduler();
    const states: ConversationState[] = [];

    const handle = startConversationStream({
      client: client as never,
      agentId: "a1",
      onState: (state) => states.push(state),
      onError: () => undefined,
      schedule: scheduler.schedule,
    });
    await handle.settled;

    expect(states[0].blocks.map((block) => block.text)).toEqual(["first question", "first answer"]);
  });
});
