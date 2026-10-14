/**
 * Reduce paseo's timeline event stream into a block sequence that can be rendered directly.
 * Pure: the same input always yields the same output, which helps unit tests and React incremental refresh.
 */

import { toPermissionRequest } from "./permissions";
import type { PermissionAction, Question } from "./permissions";

export type BlockKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice" | "permission";

export interface Block {
  key: string;
  kind: BlockKind;
  text: string;
  done: boolean;
  toolName?: string;
  toolStatus?: string;
  /** Permission block: the request id given by the daemon, echoed back as-is when answering */
  requestId?: string;
  requestKind?: string;
  description?: string;
  actions?: PermissionAction[];
  /** Set when the agent asked a question: the questions to render, and the tool input to echo back with the answers. */
  questions?: Question[];
  input?: Record<string, unknown>;
  /** Already answered. To tell whether a request is still pending, look at this field, not done — done is set to true uniformly when a turn ends. */
  resolution?: "allow" | "deny";
}

export interface ConversationState {
  blocks: Block[];
  running: boolean;
  notices: string[];
}

/**
 * The reducer's input type. Deliberately loose: the SDK's event union type (`TimelineMessage`) is not
 * exported from any accessible subpath, so it cannot be imported by name, and it moves between versions.
 * This only relies on the `type` and `payload.event/item` fields — each has been checked against the
 * 0.11.1 `AgentStreamEvent` / `AgentTimelineItem` definitions. The caller asserts at the boundary (see Task 8).
 */
export type TimelineInput = { type: string; payload?: Record<string, unknown> };

export function createConversationState(): ConversationState {
  return { blocks: [], running: false, notices: [] };
}

/**
 * Follow-ups are not allowed while an answer is in progress: the daemon interrupts the current turn when
 * it receives a new message (omitting SendMessageOptions' activeTurnBehavior means interrupt), and a silent
 * interrupt is not what the user wants. To cut in, stop explicitly first.
 */
export function canSendFollowUp(state: ConversationState): boolean {
  return !state.running;
}

function append(state: ConversationState, block: Block): ConversationState {
  return { ...state, blocks: [...state.blocks, block] };
}

function replaceLast(state: ConversationState, patch: Partial<Block>): ConversationState {
  if (state.blocks.length === 0) return state;
  const blocks = state.blocks.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...patch };
  return { ...state, blocks };
}

/** An assistant_message that arrives in fragments is appended to the previous assistant block; otherwise a new block is started. */
function appendAssistant(state: ConversationState, text: string): ConversationState {
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === "assistant" && !last.done) {
    return replaceLast(state, { text: last.text + text });
  }
  return append(state, { key: `assistant-${state.blocks.length}`, kind: "assistant", text, done: false });
}

/** Reasoning also arrives in fragments: like assistant, it merges into the previous block, and a new one starts only if another block sits in between. */
function appendReasoning(state: ConversationState, text: string): ConversationState {
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === "reasoning" && !last.done) {
    return replaceLast(state, { text: last.text + text });
  }
  return append(state, { key: `reasoning-${state.blocks.length}`, kind: "reasoning", text, done: false });
}

function upsertTool(state: ConversationState, callId: string, name: string, status: string): ConversationState {
  const index = state.blocks.findIndex((block) => block.key === `tool-${callId}`);
  const done = status === "completed" || status === "failed" || status === "canceled";
  if (index === -1) {
    return append(state, {
      key: `tool-${callId}`,
      kind: "tool",
      text: "",
      done,
      toolName: name,
      toolStatus: status,
    });
  }
  const blocks = state.blocks.slice();
  blocks[index] = { ...blocks[index], toolName: name, toolStatus: status, done };
  return { ...state, blocks };
}

function handleItem(state: ConversationState, itemValue: Record<string, unknown>): ConversationState {
  const itemType = String(itemValue.type ?? "");
  switch (itemType) {
    case "user_message":
      return append(state, {
        key: `user-${state.blocks.length}`,
        kind: "user",
        text: String(itemValue.text ?? ""),
        done: true,
      });
    case "assistant_message":
      return appendAssistant(state, String(itemValue.text ?? ""));
    case "reasoning":
      return appendReasoning(state, String(itemValue.text ?? ""));
    case "tool_call":
      return upsertTool(
        state,
        String(itemValue.callId ?? ""),
        String(itemValue.name ?? "tool"),
        String(itemValue.status ?? "running"),
      );
    case "error":
      return append(state, {
        key: `error-${state.blocks.length}`,
        kind: "error",
        text: String(itemValue.message ?? "agent error"),
        done: true,
      });
    case "notification":
      return append(state, {
        key: `notice-${state.blocks.length}`,
        kind: "notice",
        text: String(itemValue.message ?? ""),
        done: true,
      });
    default:
      return state;
  }
}

/** The agent asked a question / requested permission. A repeated push of the same request keeps only one block. */
function appendPermission(state: ConversationState, rawRequest: unknown): ConversationState {
  const request = toPermissionRequest(rawRequest);
  const key = request.id ? `permission-${request.id}` : `permission-${state.blocks.length}`;
  if (state.blocks.some((block) => block.key === key)) return state;

  return append(state, {
    key,
    kind: "permission",
    text: request.title,
    done: false,
    requestId: request.id,
    ...(request.kind ? { requestKind: request.kind } : {}),
    ...(request.description ? { description: request.description } : {}),
    actions: request.actions,
    ...(request.questions ? { questions: request.questions } : {}),
    ...(request.input ? { input: request.input } : {}),
  });
}

function resolvePermission(state: ConversationState, requestId: string, rawResolution: unknown): ConversationState {
  const index = state.blocks.findIndex((block) => block.requestId === requestId && block.requestId !== "");
  if (index === -1) return state; // another session / an earlier request, unrelated to this timeline

  const resolution = (rawResolution ?? {}) as Record<string, unknown>;
  const behavior = resolution.behavior === "allow" ? "allow" : "deny";
  const blocks = state.blocks.slice();
  blocks[index] = { ...blocks[index], resolution: behavior, done: true };
  return { ...state, blocks };
}

/** The still-pending permission request — the UI uses it to decide whether to pin the buttons to the top. */
export function pendingPermission(state: ConversationState): Block | undefined {
  return state.blocks.find((block) => block.kind === "permission" && !block.resolution);
}

function finishTurn(state: ConversationState): ConversationState {
  return {
    ...state,
    running: false,
    blocks: state.blocks.map((block) => ({ ...block, done: true })),
  };
}

export function reduceTimeline(state: ConversationState, message: TimelineInput): ConversationState {
  switch (message.type) {
    case "agent_stream": {
      const payload = (message.payload ?? {}) as { event?: Record<string, unknown> };
      const event = (payload.event ?? {}) as Record<string, unknown>;
      switch (String(event.type ?? "")) {
        case "timeline":
          return handleItem(state, (event.item ?? {}) as Record<string, unknown>);
        case "turn_started":
          return { ...state, running: true };
        case "turn_completed":
        case "turn_canceled":
          return finishTurn(state);
        case "turn_failed":
          return append(finishTurn(state), {
            key: `error-${state.blocks.length}`,
            kind: "error",
            text: String(event.error ?? "This turn failed"),
            done: true,
          });
        case "permission_requested":
          return appendPermission(state, event.request);
        case "permission_resolved":
          return resolvePermission(state, String(event.requestId ?? ""), event.resolution);
        default:
          return state;
      }
    }
    case "agent.timeline.subscription_restored":
      return {
        ...state,
        notices: [...state.notices, "The connection reconnected; content may have been missed in between. Reopen this session to see the full history."],
      };
    case "agent.timeline.error":
      return append(state, {
        key: `error-${state.blocks.length}`,
        kind: "error",
        text: String((message.payload ?? {}).error ?? "Timeline subscription failed"),
        done: true,
      });
    case "agent.timeline.replacement":
      return {
        ...state,
        notices: [...state.notices, "The session was replaced elsewhere; reopen it to see the latest content."],
      };
    default:
      return state;
  }
}

const KIND_LABEL: Record<BlockKind, string> = {
  user: "🧑 You",
  assistant: "🐾 Paseo",
  reasoning: "💭 Reasoning",
  tool: "🔧 Tool",
  error: "⚠️ Error",
  notice: "ℹ️ Notice",
  permission: "🔐 Needs your confirmation",
};

export interface MarkdownOptions {
  /** Expand reasoning and tool calls (Raycast's Detail does not support <details>, so collapsing works only by re-rendering different markdown). */
  showActivity?: boolean;
}

function renderPermission(block: Block): string {
  const lines = [`**${KIND_LABEL.permission}**`, "", block.text];
  if (block.description) lines.push("", block.description);
  if (block.resolution) {
    lines.push("", block.resolution === "allow" ? "✅ Allowed" : "🚫 Denied");
  } else if (block.actions?.length) {
    lines.push("", ...block.actions.map((action) => `- \`${action.label}\``));
  }
  return lines.join("\n");
}

function renderBlock(block: Block, showActivity: boolean): string {
  switch (block.kind) {
    case "tool":
      return `\`${block.toolName ?? "tool"}\` — ${block.toolStatus ?? "running"}`;
    case "user":
      return `> **${KIND_LABEL.user}**: ${block.text}`;
    case "assistant":
      return `**${KIND_LABEL.assistant}**\n\n${block.text}`;
    case "reasoning":
      // By default keep only a one-line summary so the final answer is the star; press ⌥T to expand the full text.
      if (!showActivity) {
        return block.text ? `${KIND_LABEL.reasoning} · ${block.text.length} chars (⌥T to expand)` : KIND_LABEL.reasoning;
      }
      return `**${KIND_LABEL.reasoning}**\n\n${block.text}`;
    case "permission":
      return renderPermission(block);
    default:
      return `**${KIND_LABEL[block.kind]}**: ${block.text}`;
  }
}

export function toMarkdown(state: ConversationState, options: MarkdownOptions = {}): string {
  if (state.blocks.length === 0) {
    return state.running ? "Waiting for the agent to start…" : "No content yet.";
  }
  return state.blocks.map((block) => renderBlock(block, options.showActivity === true)).join("\n\n");
}
