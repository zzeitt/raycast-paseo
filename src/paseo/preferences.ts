/**
 * Conversion from preference fields to daemon parameters.
 *
 * The daemon accepts two forms for the Provider field (`CreateAgentRequestOptions.provider` is a
 * "provider/model pair", for example `codex/gpt-5.4`): either a bare provider (with the model given
 * separately) or `provider/model` written directly. Which one wins when both are filled in needs an
 * explicit rule, or the contradiction is just handed to the daemon to guess at.
 */

export interface ProviderChoice {
  provider: string;
  /** Present only when the provider does not already name a model. */
  model?: string;
}

/**
 * The session mode new agents start in.
 *
 * A mode id is the daemon's own vocabulary (`auto`, `plan`, `acceptEdits`, `default`,
 * `bypassPermissions` for the claude provider), and nothing here validates it: the ids belong to the
 * provider, not to this extension, and a wrong one should come back as the daemon's error rather
 * than as a silent fallback to a mode the user did not ask for. Empty means let the daemon decide.
 */
export function resolveMode(modePref?: string): string | undefined {
  const mode = modePref?.trim() ?? "";
  return mode.length > 0 ? mode : undefined;
}

export function resolveProviderChoice(providerPref?: string, modelPref?: string): ProviderChoice {
  const provider = providerPref?.trim() || "claude";
  const model = modelPref?.trim() || "";
  // The provider already carries a `/model`, so it alone represents the pair; adding a model would contradict itself.
  // When both fields are filled, the provider wins — that is the one the user just typed into Provider.
  if (provider.includes("/")) return { provider };
  return model ? { provider, model } : { provider };
}

/** Which command's settings to read: Ask's, or the Quick slots'. */
export type TargetScope = "ask" | "quick";

/** Where a command starts, once the settings have been read and normalized. */
export interface TargetDefaults {
  host?: string;
  workspace?: string;
  cwd?: string;
}

/**
 * The preference fields this reads. Declared here rather than imported from the hook so that the
 * mapping below stays testable without Raycast, and so the hook's own `Preferences` need only satisfy
 * it structurally.
 *
 * A workspace is named by one field holding a path, not by a name field and a directory field: a
 * directory picker can only produce a path, and anything the name field could say the path field
 * resolves just as well through `matchWorkspace`, so the second field was one way of saying the same
 * thing and a stale value in either could silently overrule the other.
 */
export interface TargetPreferences {
  defaultHost?: string;
  defaultWorkspace?: string;
  defaultCwd?: string;
  quickWorkspace?: string;
  quickCwd?: string;
}

function setting(value?: string): string | undefined {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : undefined;
}

/**
 * The settings that say where a given command starts.
 *
 * Ask and the Quick slots each get their own workspace and working directory, because the two are
 * used for different kinds of work and a single pair forced one to keep undoing the other's choice.
 * They deliberately do not fall back to each other: a Quick slot with nothing configured has to be
 * able to stay that way while Ask has a default, or the split would not have bought anything.
 *
 * The host is the one setting that stays shared — the machine to start on is the same question
 * whichever command asks it.
 */
export function targetDefaults(prefs: TargetPreferences, scope: TargetScope): TargetDefaults {
  const own =
    scope === "ask"
      ? [prefs.defaultWorkspace, prefs.defaultCwd]
      : [prefs.quickWorkspace, prefs.quickCwd];
  const [workspace, cwd] = own;
  return {
    host: setting(prefs.defaultHost),
    workspace: setting(workspace),
    cwd: setting(cwd),
  };
}
