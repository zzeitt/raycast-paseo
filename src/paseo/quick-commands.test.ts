import { describe, expect, it } from "vitest";
import {
  argumentHintOf,
  expandQuickCommand,
  findQuickCommand,
  parseInvocation,
  readQuickSlots,
} from "./quick-commands";
import type { QuickCommand } from "./quick-commands";

const command = (name: string, prompt: string): QuickCommand => ({ name, prompt });

describe("readQuickSlots", () => {
  it("reads the configured slots in order, skipping the empty ones", () => {
    const prefs = {
      quick1Name: "summarize",
      quick1Prompt: "Summarize {{{link}}}",
      quick2Name: "",
      quick2Prompt: "",
      quick3Name: "review",
      quick3Prompt: "Review the current diff",
    };
    expect(readQuickSlots(prefs, 4)).toEqual([
      command("summarize", "Summarize {{{link}}}"),
      command("review", "Review the current diff"),
    ]);
  });

  // Half a command is not a command: without a prompt there is nothing to send, and without a name
  // there is nothing to type.
  it("skips a slot that names a command but does not say what to send", () => {
    expect(readQuickSlots({ quick1Name: "summarize", quick1Prompt: "   " }, 4)).toEqual([]);
  });

  it("skips a slot with a prompt but no name", () => {
    expect(readQuickSlots({ quick1Prompt: "do something" }, 4)).toEqual([]);
  });

  it("trims what the fields hold", () => {
    expect(readQuickSlots({ quick1Name: "  summarize ", quick1Prompt: " x " }, 1)).toEqual([
      command("summarize", "x"),
    ]);
  });

  it("has nothing to offer when nothing is configured", () => {
    expect(readQuickSlots({}, 4)).toEqual([]);
  });
});

describe("argumentHintOf", () => {
  it("names the argument after the placeholder", () => {
    expect(argumentHintOf(command("a", "Summarize {{{link}}}"))).toBe("link");
  });

  it("has nothing to say when the prompt takes no argument", () => {
    expect(argumentHintOf(command("a", "Review the current diff"))).toBeUndefined();
  });

  it("ignores braces that are not a placeholder", () => {
    expect(argumentHintOf(command("a", 'Render {"a": 1}'))).toBeUndefined();
  });

  // Whitespace inside the braces is the author's formatting, not part of the name.
  it("trims the placeholder's own name", () => {
    expect(argumentHintOf(command("a", "归档 {{{ 链接 }}}"))).toBe("链接");
  });
});

describe("findQuickCommand", () => {
  it("finds a command whatever the case", () => {
    expect(findQuickCommand([command("summarize", "x")], "Summarize")?.prompt).toBe("x");
  });

  it("finds nothing for an unknown name", () => {
    expect(findQuickCommand([command("summarize", "x")], "sum")).toBeNull();
  });
});

describe("parseInvocation", () => {
  it("splits a slash name from what follows it", () => {
    expect(parseInvocation("/summarize https://example.com/a?b=c")).toEqual({
      name: "summarize",
      args: "https://example.com/a?b=c",
    });
  });

  it("accepts a command with nothing after it", () => {
    expect(parseInvocation("/summarize")).toEqual({ name: "summarize", args: "" });
  });

  it("keeps the argument as one piece, spaces and all", () => {
    expect(parseInvocation("/note  the   link   is here ")?.args).toBe("the   link   is here");
  });

  // A question that merely starts with a slash is a question: the caller decides by looking the
  // name up, so anything that is not a slash-prefixed word never gets that far.
  it("ignores text that does not start with a slash", () => {
    expect(parseInvocation("归档 /summarize x")).toBeNull();
    expect(parseInvocation("   ")).toBeNull();
    expect(parseInvocation("/ leading space")).toBeNull();
  });
});

describe("expandQuickCommand", () => {
  it("puts the argument where the placeholder is", () => {
    expect(expandQuickCommand(command("a", "Summarize {{{link}}}"), "https://x")).toBe("Summarize https://x");
  });

  it("fills every placeholder, so a repeated one does not surprise anyone", () => {
    expect(expandQuickCommand(command("a", "{{{x}}} and {{{x}}}"), "here")).toBe("here and here");
  });

  // A prompt written without a placeholder is still a prompt; the argument goes after it rather
  // than being silently dropped.
  it("appends the argument when the prompt has no placeholder", () => {
    expect(expandQuickCommand(command("a", "Check the diff"), "in the current branch")).toBe(
      "Check the diff in the current branch",
    );
  });

  it("leaves a prompt with no placeholder alone when nothing was typed", () => {
    expect(expandQuickCommand(command("a", "Check the diff"), "  ")).toBe("Check the diff");
  });

  it("does not mind braces that are not the placeholder", () => {
    expect(expandQuickCommand(command("a", 'Render {"a": 1} from {{{x}}}'), "the config")).toBe(
      'Render {"a": 1} from the config',
    );
  });
});
