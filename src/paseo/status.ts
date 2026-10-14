/**
 * The pure half of how a status is displayed: the daemon's status string becomes a label and a
 * tone. `@raycast/api` has no runtime entry point outside the app, so it cannot be imported here —
 * the component maps the tone onto a colour and an icon.
 */

export type StatusTone = "active" | "ready" | "failed" | "unknown";

export interface StatusDisplay {
  label: string;
  tone: StatusTone;
}

/** The statuses the daemon reports, per its own agent-status enum. */
export function describeStatus(status: string): StatusDisplay {  switch (status) {
    case "initializing":
      return { label: "Starting", tone: "active" };
    case "running":
      return { label: "Running", tone: "active" };
    case "idle":
      return { label: "Idle", tone: "ready" };
    case "error":
      return { label: "Failed", tone: "failed" };
    case "closed":
      return { label: "Closed", tone: "unknown" };
    default:
      // An unfamiliar status is still worth showing as itself rather than hiding.
      return { label: status || "Unknown", tone: "unknown" };
  }
}

/**
 * A workspace has its own status enum, which the daemon derives from the tabs inside it. A
 * workspace that wants something from you and one that is merely busy both read as "active": the
 * label tells them apart, and the colour is there to make the group stand out either way.
 */
export function describeWorkspaceStatus(status: string): StatusDisplay {
  switch (status) {
    case "running":
      return { label: "Running", tone: "active" };
    case "attention":
      return { label: "Attention", tone: "active" };
    case "needs_input":
      return { label: "Needs Input", tone: "active" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "done":
      return { label: "Done", tone: "ready" };
    default:
      return { label: status || "Unknown", tone: "unknown" };
  }
}

