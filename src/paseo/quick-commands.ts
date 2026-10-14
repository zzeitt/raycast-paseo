/**
 * Shortcuts for prompts you send often.
 *
 * A quick command is a name, a prompt, and one place in that prompt where what you type goes. It is
 * written as `/name <argument>` — in the Ask command's question argument, or by running the slot
 * command that holds it — and expands into the prompt before anything is sent.
 *
 * The slots are fixed: Raycast only knows the commands it was packaged with, so "one shortcut, one
 * command, its own alias and hotkey" means declaring a few commands up front and letting the user
 * configure the ones they want. Their settings are extension preferences rather than per-command
 * ones so that Ask can see every slot's name, which is what makes `/name` work there.
 *
 * The placeholder is `{{{…}}}` rather than a single pair of braces so that a prompt can still carry
 * braces of its own — JSON, a diff, a template.
 */

export interface QuickCommand {
  /** What you type after the slash. */
  name: string;
  /** The prompt to send, with `{{{…}}}` standing where the argument goes. */
  prompt: string;
}

/** How many slots the manifest declares. */
export const QUICK_SLOTS = 4;

const PLACEHOLDER = /\{\{\{([^}]*)\}\}\}/g;

/** Every placeholder written with the argument's text. */
export function expandQuickCommand(command: QuickCommand, args: string): string {
  const argument = args.trim();
  const filled = command.prompt.replace(PLACEHOLDER, argument);
  const expanded = filled === command.prompt && argument ? `${filled} ${argument}` : filled;
  return expanded.trim();
}

/**
 * What the prompt calls its argument, taken from the placeholder itself.
 *
 * It is the prompt's own word for the thing, so it reads better on the field than anything the
 * extension could invent — and it means one less setting per slot.
 */
export function argumentHintOf(command: QuickCommand): string | undefined {
  const match = new RegExp(PLACEHOLDER.source).exec(command.prompt);
  const name = match?.[1]?.trim();
  return name ? name : undefined;
}

/**
 * The `/name argument` form, or null when the text is not one.
 *
 * Anything after the name is the argument, kept whole: a link has no spaces, and a sentence the user
 * meant as one argument should not be split up.
 */
export function parseInvocation(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const separator = body.search(/\s/);
  const name = separator === -1 ? body : body.slice(0, separator);
  if (name.length === 0) return null;
  if (/\s/.test(name[0])) return null;
  return { name, args: separator === -1 ? "" : body.slice(separator).trim() };
}

export function findQuickCommand(commands: QuickCommand[], name: string): QuickCommand | null {
  const wanted = name.trim().toLowerCase();
  return commands.find((command) => command.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * The configured slots, in slot order.
 *
 * A slot with a name but no prompt, or the other way round, is skipped: half a command cannot be
 * run, and offering it would only move the failure to the moment it is used.
 */
export function readQuickSlots(prefs: Record<string, unknown>, slots: number = QUICK_SLOTS): QuickCommand[] {
  const commands: QuickCommand[] = [];
  for (let slot = 1; slot <= slots; slot++) {
    const name = text(prefs[`quick${slot}Name`]);
    const prompt = text(prefs[`quick${slot}Prompt`]);
    if (name && prompt) commands.push({ name, prompt });
  }
  return commands;
}

/** The preferences of one slot, for the command that stands for it. */
export function quickSlot(commands: QuickCommand[], slot: number): QuickCommand | null {
  return commands[slot - 1] ?? null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
