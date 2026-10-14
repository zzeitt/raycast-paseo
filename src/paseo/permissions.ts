// When an agent asks a question or asks for permission, the daemon pushes a
// `permission` event carrying a few "buttons". This module turns the daemon's
// raw shape into something the UI can render, and translates the user's answer
// back into the response the daemon expects.
// Duck-typed like agents.ts: the SDK's union types are not exported from an
// importable path.

export type PermissionBehavior = "allow" | "deny";
export type PermissionVariant = "primary" | "secondary" | "danger";

export interface PermissionAction {
  id: string;
  label: string;
  behavior: PermissionBehavior;
  variant?: PermissionVariant;
}

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface Question {
  /** The tool keys its `answers` map by this exact string, so it is carried verbatim. */
  prompt: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export interface PermissionRequest {
  id: string;
  kind?: string;
  title: string;
  description?: string;
  actions: PermissionAction[];
  /** Present when the agent asked a question instead of asking for permission. */
  questions?: Question[];
  /** The raw tool input, echoed back verbatim if the request turns out to be a question. */
  input?: Record<string, unknown>;
}

// Some providers ask for permission with a bare sentence and no buttons at all.
// Without options there is nothing to pick, so offer the plain yes/no.
export const FALLBACK_ACTIONS: PermissionAction[] = [
  { id: "", label: "Allow", behavior: "allow", variant: "primary" },
  { id: "", label: "Deny", behavior: "deny", variant: "danger" },
];

const BEHAVIORS = new Set<string>(["allow", "deny"]);
const VARIANTS = new Set<string>(["primary", "secondary", "danger"]);

function toAction(raw: unknown): PermissionAction | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const behavior = String(value.behavior ?? "");
  if (!BEHAVIORS.has(behavior)) return null; // Drop what we cannot honour rather than render a dead button.

  const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : behavior;
  const variant = typeof value.variant === "string" && VARIANTS.has(value.variant) ? (value.variant as PermissionVariant) : undefined;

  return {
    id: typeof value.id === "string" ? value.id : "",
    label,
    behavior: behavior as PermissionBehavior,
    ...(variant ? { variant } : {}),
  };
}

function toQuestionOption(raw: unknown): QuestionOption | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!label) return null; // An option with no label is unclickable.

  const description = typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined;
  const preview = typeof value.preview === "string" && value.preview.trim() ? value.preview : undefined;

  return { label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) };
}

function toQuestion(raw: unknown): Question | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  // The daemon labels the prompt `question`, and that same string is the key the
  // tool reads its answers under, so a question we cannot name is unusable.
  const prompt = typeof value.question === "string" ? value.question.trim() : "";
  if (!prompt) return null;

  const header = typeof value.header === "string" && value.header.trim() ? value.header.trim() : undefined;
  const options = (Array.isArray(value.options) ? value.options : []).map(toQuestionOption).filter((o): o is QuestionOption => o !== null);

  return {
    prompt,
    ...(header ? { header } : {}),
    options,
    multiSelect: value.multiSelect === true,
    allowOther: value.allowOther === true,
  };
}

function toQuestions(input: unknown): Question[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  return raw.map(toQuestion).filter((q): q is Question => q !== null);
}

export function toPermissionRequest(raw: unknown): PermissionRequest {
  const value = (raw ?? {}) as Record<string, unknown>;

  const actions = (Array.isArray(value.actions) ? value.actions : []).map(toAction).filter((a): a is PermissionAction => a !== null);
  const questions = toQuestions(value.input);

  const title = [value.title, value.name].find((t) => typeof t === "string" && t.trim().length > 0) as string | undefined;
  const description = typeof value.description === "string" && value.description.trim() ? value.description : undefined;

  return {
    id: typeof value.id === "string" ? value.id : "",
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    title: title ? title.trim() : "The agent needs your confirmation",
    ...(description ? { description } : {}),
    // A question is not a yes/no prompt: answering one with allow/deny makes the
    // tool tell the agent "The user did not answer the questions." So the
    // Allow/Deny fallback only applies when there is genuinely nothing to ask.
    actions: questions.length > 0 ? [] : actions.length > 0 ? actions : FALLBACK_ACTIONS,
    ...(questions.length > 0 ? { questions } : {}),
    ...(value.input && typeof value.input === "object" ? { input: value.input as Record<string, unknown> } : {}),
  };
}

export interface PermissionResponse {
  behavior: PermissionBehavior;
  selectedActionId?: string;
  /** Carries the answers when the request was a question. */
  updatedInput?: Record<string, unknown>;
}

// The SDK's respondToPermission(agentId, requestId, response)
export interface PermissionsClient {
  respondToPermission(agentId: string, requestId: string, response: PermissionResponse): Promise<void>;
}

export async function respondToPermission(
  client: PermissionsClient,
  agentId: string,
  requestId: string,
  action: PermissionAction,
): Promise<void> {
  // The fallback buttons have no id: the daemon never offered any, so we can only
  // report the behaviour.
  await client.respondToPermission(agentId, requestId, {
    behavior: action.behavior,
    ...(action.id ? { selectedActionId: action.id } : {}),
  });
}

/** Each entry lists the labels picked for the question at that index. */
export type QuestionPicks = Record<number, string[]>;

/**
 * Build the `answers` map the tool reads: keyed by the question's own text, with
 * several picks joined by a comma. Free text goes through this untouched — the
 * "Other" field is just a pick the user typed.
 */
export function buildAnswers(questions: Question[], picks: QuestionPicks): Record<string, string> {
  const answers: Record<string, string> = {};

  questions.forEach((question, index) => {
    const picked = (picks[index] ?? []).map((pick) => pick.trim()).filter(Boolean);
    if (picked.length === 0) return; // A blank question is left unanswered, not answered with "".
    answers[question.prompt] = picked.join(", ");
  });

  return answers;
}

/**
 * Questions are answered through `updatedInput`, not `selectedActionId`: the
 * response must carry the tool's own input back, plus an `answers` map. Only
 * the answers change, so every other key of the input is echoed verbatim.
 */
export async function respondWithAnswers(
  client: PermissionsClient,
  agentId: string,
  requestId: string,
  input: Record<string, unknown> | undefined,
  answers: Record<string, string>,
): Promise<void> {
  await client.respondToPermission(agentId, requestId, {
    behavior: "allow",
    updatedInput: { ...(input ?? {}), answers },
  });
}
