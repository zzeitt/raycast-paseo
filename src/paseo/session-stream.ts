/**
 * Orchestration for "connect to the daemon → subscribe to the timeline → fetch one page of
 * history → flush to the UI on a throttle".
 *
 * Extracted as a plain function-style one-shot task (not a hook) so it can be tested directly with a
 * fake client: get the order wrong once here and the user sees history upside down and content
 * duplicated — and that kind of bug cannot be caught by eye inside React. Once extracted, this file
 * does not depend on React and does not own the connection's lifecycle (the caller closes the
 * connection; this file only unsubscribes).
 */

import { createConversationState, reduceTimeline } from "./timeline";
import type { ConversationState, TimelineInput } from "./timeline";

export const FLUSH_INTERVAL_MS = 80;
const HISTORY_LIMIT = 200;
const RESTORED = "agent.timeline.subscription_restored";

/**
 * Only three methods of the daemon client are used. Deliberately duck-typed instead of `DaemonClient`:
 * the SDK's `TimelineMessage` union type is not exported from any accessible subpath, and importing it by
 * name would drag in version churn (the same reasoning as the assertion in timeline.ts).
 */
export interface StreamClient {
  subscribeAgentTimeline(
    agentId: string,
    handler: (message: TimelineInput) => void,
  ): { ready: Promise<void>; release: () => void | Promise<void> };
  fetchAgentTimeline(agentId: string, options?: { direction?: string; limit?: number; projection?: string }): Promise<unknown>;
  fetchAgent(agentId: string): Promise<unknown>;
}

/** Injecting "flush the accumulated state" here lets the test decide when the flush happens. */
export type FlushScheduler = (flush: () => void, intervalMs: number) => () => void;

const defaultScheduler: FlushScheduler = (flush, intervalMs) => {
  const timer = setInterval(flush, intervalMs);
  return () => clearInterval(timer);
};

export interface SeqWindow {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

/** The seq range the history page covers; returns null when the cursors are unavailable (in which case nothing is deduplicated). */
export function seqWindow(page: unknown): SeqWindow | null {
  const value = page as { startCursor?: { epoch?: unknown; seq?: unknown } | null; endCursor?: { epoch?: unknown; seq?: unknown } | null } | null;
  const start = value?.startCursor;
  const end = value?.endCursor;
  if (!start || !end) return null;
  const startSeq = Number(start.seq);
  const endSeq = Number(end.seq);
  if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) return null;
  return { epoch: String(end.epoch ?? start.epoch ?? ""), startSeq, endSeq };
}

/**
 * Whether this live message is already present in the history page.
 *
 * Only messages whose `payload.seq` falls inside the page range are dropped: anything earlier than
 * startSeq (the page only holds the last 200), later than endSeq (it happened after the page was
 * fetched), from a different epoch, or with no seq at all must be kept — better to duplicate once
 * than to swallow the user's content.
 */
export function isRedundant(message: TimelineInput, window: SeqWindow | null): boolean {
  if (!window) return false;
  const payload = message.payload as { epoch?: unknown; seq?: unknown } | undefined;
  const seq = Number(payload?.seq);
  if (!Number.isFinite(seq)) return false;
  const epoch = payload?.epoch;
  if (epoch !== undefined && epoch !== null && String(epoch) !== window.epoch) return false;
  return seq >= window.startSeq && seq <= window.endSeq;
}

export interface StreamParams {
  client: StreamClient;
  agentId: string;
  onState: (state: ConversationState) => void;
  /** Takes the raw error; formatting is left to the caller (the wording of connection errors is the UI's concern). */
  onError: (error: unknown) => void;
  schedule?: FlushScheduler;
  flushIntervalMs?: number;
}

export interface ConversationStream {
  /** Idempotent. Stops the timer and unsubscribes; does not close the connection. */
  stop: () => void;
  /** Resolves once history loading finishes (or fails midway / is stopped); the test uses it to wait for the first frame. */
  settled: Promise<void>;
}

export function startConversationStream(params: StreamParams): ConversationStream {
  const { client, agentId, onState, onError } = params;
  const schedule = params.schedule ?? defaultScheduler;
  const flushIntervalMs = params.flushIntervalMs ?? FLUSH_INTERVAL_MS;

  let stopped = false;
  let release: (() => void) | undefined;
  let stopTimer: (() => void) | undefined;

  let current = createConversationState();
  let flushed: ConversationState | null = null;
  // Until history is loaded, live messages are buffered in their original order — land history first, then replay, so the order is not reversed.
  let live = false;
  const buffer: TimelineInput[] = [];

  const flush = (): void => {
    if (current === flushed) return;
    flushed = current;
    onState(current);
  };

  const resyncRunning = async (): Promise<void> => {
    try {
      const result = (await client.fetchAgent(agentId)) as { agent?: { status?: unknown } } | null;
      if (stopped) return;
      const status = String(result?.agent?.status ?? "");
      if (!status) return;
      current = { ...current, running: status === "running" };
    } catch {
      // If the probe fails, keep things as they are: a failed liveness check after a reconnect should not turn a still-viewable session into an error page.
    }
  };

  const handler = (message: TimelineInput): void => {
    if (!live) {
      buffer.push(message);
      return;
    }
    current = reduceTimeline(current, message);
    // After a reconnect, running may stay stuck on true forever (a reconnect does not replay history), so the daemon must be asked again.
    if (message.type === RESTORED) void resyncRunning();
  };

  const settled = (async (): Promise<void> => {
    try {
      const subscription = client.subscribeAgentTimeline(agentId, handler);
      release = () => void subscription.release();
      await subscription.ready;
      if (stopped) return;

      const page = await client.fetchAgentTimeline(agentId, {
        direction: "before",
        limit: HISTORY_LIMIT,
        projection: "projected",
      });
      if (stopped) return;

      const entries = ((page as { entries?: unknown[] } | null)?.entries ?? []) as Array<{ provider?: unknown; item?: unknown }>;
      let rebuilt = createConversationState();
      for (const entry of entries) {
        // A history entry is isomorphic to the item in a stream event, so wrapping it lets us reuse the same reducer.
        rebuilt = reduceTimeline(rebuilt, {
          type: "agent_stream",
          payload: { agentId, event: { type: "timeline", provider: entry.provider, item: entry.item } },
        });
      }

      // Among the live messages that arrived while buffering, drop any the page already contains, or they would repeat.
      const window = seqWindow(page);
      for (const message of buffer) {
        if (!isRedundant(message, window)) rebuilt = reduceTimeline(rebuilt, message);
      }
      buffer.length = 0;
      live = true;

      current = rebuilt;
      flush();
      stopTimer = schedule(flush, flushIntervalMs);
    } catch (error) {
      if (!stopped) onError(error);
    }
  })();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopTimer?.();
      stopTimer = undefined;
      release?.();
      release = undefined;
    },
    settled,
  };
}
