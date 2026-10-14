import { getPreferenceValues } from "@raycast/api";
import { useMemo } from "react";
import { resolvePaseoHome } from "../paseo/credential";
import { listPaseoHosts } from "../paseo/hosts";
import type { HostsLookup } from "../paseo/hosts";

/**
 * A type rather than an interface so that it still satisfies `Record<string, unknown>` — which is
 * how the quick-command slots are read, since they are preference fields like any other.
 */
type Preferences = {
  paseoHome?: string;
  provider: string;
  model?: string;
  mode?: string;
  defaultHost?: string;
  /** A path from the folder picker, resolved against the host's workspaces by matchWorkspace. */
  defaultWorkspace?: string;
  defaultCwd?: string;
  /** The Quick slots' own target, kept apart from Ask's so neither has to undo the other's choice. */
  quickWorkspace?: string;
  quickCwd?: string;
  paseoAppPath?: string;
  quick1Name?: string;
  quick1Prompt?: string;
  quick2Name?: string;
  quick2Prompt?: string;
  quick3Name?: string;
  quick3Prompt?: string;
  quick4Name?: string;
  quick4Prompt?: string;
};

export function usePreferences(): Preferences {
  return getPreferenceValues<Preferences>();
}

/** The directory holding `paseo.pid` and `local-credential` for the daemon on this machine. */
export function usePaseoHome(): string {
  const prefs = usePreferences();
  return prefs.paseoHome?.trim() || resolvePaseoHome();
}

/**
 * The hosts Paseo has stored, read once when a command opens.
 *
 * Reading Paseo's own database is synchronous file work, so the commands get the list on their
 * first render rather than a frame of loading state; it does not change while a command is open.
 */
export function usePaseoHosts(): HostsLookup {
  return useMemo(() => listPaseoHosts(), []);
}
