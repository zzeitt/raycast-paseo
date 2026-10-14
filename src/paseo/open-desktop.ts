/**
 * Action wrapper for "open in the Paseo desktop app".
 *
 * Three entry points (the ask page, the session list, the session detail) all need to do the same
 * thing, and they all used to be `void openAgentInDesktop(...)` — a failure made no sound at all, and
 * the user would just think the button was broken. Here "a failure must say something" is pinned down
 * as a testable function: it does not import @raycast/api, and the caller injects how the toast is
 * shown (that package has no resolvable entry point, so it cannot be pulled into a unit test).
 */

import { describeDesktopOpenError } from "./desktop";

export interface OpenDesktopTarget {
  serverId: string;
  agentId: string;
  preferredPath?: string;
}

export interface OpenDesktopDeps {
  open: (target: OpenDesktopTarget) => Promise<void>;
  /** The one line shown to the user on failure. */
  notify: (message: string) => Promise<void> | void;
}

export function createOpenDesktopAction(target: OpenDesktopTarget, deps: OpenDesktopDeps): () => Promise<void> {
  return async () => {
    try {
      if (!target.serverId.trim()) {
        throw new Error("The daemon has not reported a server id yet; try again shortly.");
      }
      await deps.open(target);
    } catch (error) {
      await deps.notify(describeDesktopOpenError(error));
    }
  };
}
