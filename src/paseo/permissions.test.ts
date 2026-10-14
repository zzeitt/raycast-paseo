import { describe, expect, it } from "vitest";
import { buildAnswers, respondToPermission, respondWithAnswers, toPermissionRequest } from "./permissions";
import type { PermissionsClient, Question } from "./permissions";

const fullRequest = {
  id: "req-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: "Wants to run rm -rf build",
  description: "Delete the build output",
  actions: [
    { id: "a1", label: "Allow once", behavior: "allow", variant: "primary" },
    { id: "a2", label: "Allow for this session", behavior: "allow" },
    { id: "a3", label: "Deny", behavior: "deny", variant: "danger" },
  ],
};

describe("toPermissionRequest", () => {
  it("maps the daemon's request onto the fields the UI needs", () => {
    expect(toPermissionRequest(fullRequest)).toEqual({
      id: "req-1",
      kind: "tool",
      title: "Wants to run rm -rf build",
      description: "Delete the build output",
      actions: [
        { id: "a1", label: "Allow once", behavior: "allow", variant: "primary" },
        { id: "a2", label: "Allow for this session", behavior: "allow" },
        { id: "a3", label: "Deny", behavior: "deny", variant: "danger" },
      ],
    });
  });

  it("falls back to Allow / Deny when the agent offered no buttons", () => {
    const request = toPermissionRequest({ id: "req-2", kind: "question", title: "Which branch?" });
    expect(request.actions.map((a) => a.label)).toEqual(["Allow", "Deny"]);
    expect(request.actions.map((a) => a.behavior)).toEqual(["allow", "deny"]);
  });

  it("drops buttons whose behaviour it does not recognise", () => {
    const request = toPermissionRequest({
      id: "req-3",
      actions: [{ id: "x", label: "Maybe", behavior: "maybe" }, { id: "y", label: "OK", behavior: "allow" }],
    });
    expect(request.actions.map((a) => a.label)).toEqual(["OK"]);
  });

  it("still has something to say without a title, and an empty id without an id", () => {
    const request = toPermissionRequest({ name: "Bash" });
    expect(request.title).toBe("Bash");
    expect(request.id).toBe("");
    expect(toPermissionRequest({}).title).toBe("The agent needs your confirmation");
  });
});

describe("respondToPermission", () => {
  function fakeClient() {
    const calls: unknown[] = [];
    const client: PermissionsClient = {
      respondToPermission: async (agentId, requestId, response) => {
        calls.push([agentId, requestId, response]);
      },
    };
    return { client, calls };
  }

  it("sends the picked button back together with its behaviour", async () => {
    const { client, calls } = fakeClient();
    await respondToPermission(client, "a1", "req-1", { id: "a2", label: "Allow for this session", behavior: "allow" });
    expect(calls).toEqual([["a1", "req-1", { behavior: "allow", selectedActionId: "a2" }]]);
  });

  it("sends only the behaviour when a fallback button has no id", async () => {
    const { client, calls } = fakeClient();
    await respondToPermission(client, "a1", "req-2", { id: "", label: "Deny", behavior: "deny" });
    expect(calls).toEqual([["a1", "req-2", { behavior: "deny" }]]);
  });
});

// The shapes below are copied verbatim from a live capture of a Claude
// AskUserQuestion request; the daemon sends options inside `input.questions`
// and no `actions` at all.
const fruit = {
  question: "Which fruit do you prefer?",
  header: "Fruit",
  options: [{ label: "Apple", description: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: false,
  allowOther: true,
};

const editors = {
  question: "Which editors do you use?",
  header: "Editors",
  options: [{ label: "Vim" }, { label: "VS Code", description: "Microsoft's editor" }, { label: "Emacs" }],
  multiSelect: true,
  allowOther: true,
};

const askUserQuestion = {
  id: "req-q",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: { questions: [fruit, editors] },
};

describe("toPermissionRequest: questions", () => {
  it("reads the questions out of the tool input", () => {
    expect(toPermissionRequest(askUserQuestion).questions).toEqual([
      { prompt: "Which fruit do you prefer?", header: "Fruit", options: fruit.options, multiSelect: false, allowOther: true },
      { prompt: "Which editors do you use?", header: "Editors", options: editors.options, multiSelect: true, allowOther: true },
    ]);
  });

  it("keeps the raw tool input so the answers can be echoed back with it", () => {
    expect(toPermissionRequest(askUserQuestion).input).toEqual(askUserQuestion.input);
  });

  // Allow/Deny is the wrong answer to a question: the tool then replies
  // "The user did not answer the questions." to the agent.
  it("offers no allow/deny fallback once questions are present", () => {
    expect(toPermissionRequest(askUserQuestion).actions).toEqual([]);
  });

  it("drops questions and options it cannot render", () => {
    const request = toPermissionRequest({
      kind: "question",
      input: {
        questions: [
          { question: "", options: [{ label: "x" }] },
          "nonsense",
          { question: "Keep me?", options: [{ label: "yes" }, { description: "no label" }] },
        ],
      },
    });
    expect(request.questions).toEqual([
      { prompt: "Keep me?", options: [{ label: "yes" }], multiSelect: false, allowOther: false },
    ]);
  });

  it("keeps the degenerate question request on the allow/deny fallback", () => {
    // A `kind: "question"` request with no parseable questions leaves us nothing
    // to ask; the fallback is all the UI has to offer.
    expect(toPermissionRequest({ id: "req-3", kind: "question", title: "Which branch?" }).actions.map((a) => a.label)).toEqual([
      "Allow",
      "Deny",
    ]);
  });
});

describe("buildAnswers", () => {
  const questions: Question[] = toPermissionRequest(askUserQuestion).questions ?? [];

  it("keys each answer by the question text and joins multi-select with a comma", () => {
    expect(buildAnswers(questions, { 0: ["Apple"], 1: ["Vim", "VS Code"] })).toEqual({
      "Which fruit do you prefer?": "Apple",
      "Which editors do you use?": "Vim, VS Code",
    });
  });

  it("sends free text through unchanged", () => {
    expect(buildAnswers(questions, { 0: ["Pomelo, but only the pink one"] })).toEqual({
      "Which fruit do you prefer?": "Pomelo, but only the pink one",
    });
  });

  it("omits questions the user left blank rather than answering them with nothing", () => {
    expect(buildAnswers(questions, { 0: [], 1: ["Emacs"] })).toEqual({ "Which editors do you use?": "Emacs" });
  });
});

describe("respondWithAnswers", () => {
  function fakeClient() {
    const calls: unknown[] = [];
    const client: PermissionsClient = {
      respondToPermission: async (agentId, requestId, response) => {
        calls.push([agentId, requestId, response]);
      },
    };
    return { client, calls };
  }

  it("echoes the tool input back with the answers alongside it", async () => {
    const { client, calls } = fakeClient();
    await respondWithAnswers(client, "a1", "req-q", { questions: [fruit] }, { "Which fruit do you prefer?": "Apple" });
    expect(calls).toEqual([
      [
        "a1",
        "req-q",
        {
          behavior: "allow",
          updatedInput: {
            questions: [fruit],
            answers: { "Which fruit do you prefer?": "Apple" },
          },
        },
      ],
    ]);
  });

  it("keeps the input keys the tool did not ask us about", async () => {
    const { client, calls } = fakeClient();
    await respondWithAnswers(client, "a1", "req-q", { questions: [fruit], extra: "keep me" }, {});
    expect(calls[0]).toEqual([
      "a1",
      "req-q",
      { behavior: "allow", updatedInput: { questions: [fruit], extra: "keep me", answers: {} } },
    ]);
  });
});
