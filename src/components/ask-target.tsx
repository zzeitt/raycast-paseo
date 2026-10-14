/**
 * Where an agent is about to run: which host, and which workspace on it.
 *
 * Both entry points need the same answer — Ask, from its host and workspace arguments, and the
 * Quick Commands list, from nothing but the defaults — so the resolution lives here once. The rules
 * it encodes are:
 *
 * - a host named in the arguments must match exactly one, or the caller is asked to pick;
 * - a workspace named in the arguments must match exactly one, for the same reason;
 * - an unnamed workspace means the one the settings name, then the one last used on that host, then
 *   this machine's default working directory — but only on this machine, since that setting is a
 *   path. Which settings are the command's own: Ask and the Quick slots each keep their own
 *   workspace and working directory, and read them through `targetDefaults`;
 * - anything else is the picker's problem, and the picker can also point at a directory that is not
 *   a workspace at all.
 */
import { Form, LocalStorage } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect, useMemo, useState } from "react";
import { usePaseoHome, usePaseoHosts, usePreferences } from "../hooks/use-paseo-hosts";
import { connectPaseo } from "../paseo/client";
import { matchHost, pickDefaultHost, readLocalServerId } from "../paseo/hosts";
import type { HostRow } from "../paseo/hosts";
import { targetDefaults } from "../paseo/preferences";
import type { TargetScope } from "../paseo/preferences";
import { recallWorkspace } from "../paseo/recent-choices";
import type { WorkspaceChoice } from "../paseo/recent-choices";
import { listWorkspaces, matchWorkspace } from "../paseo/workspaces";
import type { WorkspaceRow, WorkspacesClient } from "../paseo/workspaces";
import { hostIcon } from "./host-icon";

/** The workspace dropdown's value while the host's workspaces are still on their way. */
export const LOADING_WORKSPACE = "__loading";

/** The dropdown item that leaves the workspace list for the file system. */
export const OTHER_DIRECTORY = "__other";

export interface TargetChoice {
  cwd: string;
  workspaceId?: string;
}

export interface AskTarget {
  /** Reachable hosts, for the picker to offer. */
  hosts: HostRow[];
  host?: HostRow;
  chooseHost: (serverId: string) => void;
  workspaces: WorkspaceRow[];
  workspacesLoading: boolean;
  /** The picker's current selection, or "" before the list has arrived. */
  workspaceId: string;
  chooseWorkspace: (workspaceId: string) => void;
  defaultCwd: string;
  /** The Paseo home these endpoints belong to. */
  home: string;
  /** True while the host's workspaces, or the last-used memory, are still being read. */
  loading: boolean;
  /** Set when nothing can be asked: the body of the Detail to show instead. */
  unavailable?: string;
  /** The workspace the arguments settled on, if they named one that exists. */
  settled: WorkspaceRow | null;
  /** A directory standing in for a workspace: this machine's Default Working Directory. */
  localDirectory?: string;
  /** What stopped the arguments from settling this; each one is a reason to pick instead. */
  problems: string[];
  /** Worth knowing, but not a reason to stop. */
  hints: string[];
  /** The directory and workspace a submitted form means, or null when it named neither. */
  choiceFrom: (values: { workspace: string; directory?: string[] }) => TargetChoice | null;
}

function sameId(workspace: WorkspaceRow, id: string): boolean {
  return workspace.id === id;
}

export function useAskTarget(args: {
  hostArg?: string;
  workspaceArg?: string;
  /** Whose settings say where to start: Ask's, or the Quick slots'. */
  scope: TargetScope;
}): AskTarget {
  const hostArg = args.hostArg?.trim() ?? "";
  const workspaceArg = args.workspaceArg?.trim() ?? "";

  const prefs = usePreferences();
  const defaults = targetDefaults(prefs, args.scope);
  const home = usePaseoHome();
  const lookup = usePaseoHosts();
  const hosts = lookup.kind === "hosts" ? lookup.hosts : [];
  const reachable = useMemo(() => hosts.filter((host) => host.endpoint !== null), [hosts]);

  const namedHost = matchHost(hosts, hostArg);
  const hostProblem = hostArg && !namedHost ? `No host matches “${hostArg}”.` : undefined;

  // The local host is told apart by the id in the Paseo home, not by a loopback address: the tunnel
  // to another machine answers on one of those too.
  const localServerId = useMemo(() => readLocalServerId(home), [home]);
  const startHost = () => pickDefaultHost(hosts, localServerId, defaults.host) ?? undefined;
  const [hostId, setHostId] = useState<string | undefined>(
    () => namedHost?.serverId ?? startHost()?.serverId,
  );
  const host = reachable.find((row) => row.serverId === hostId) ?? startHost();

  const { data: workspaces, isLoading: workspacesLoading } = useCachedPromise(
    async (endpoint: string, paseoHome: string) => {
      if (!endpoint) return [];
      const client = await connectPaseo({ host: endpoint, home: paseoHome });
      try {
        return await listWorkspaces(client as unknown as WorkspacesClient);
      } finally {
        await client.close();
      }
    },
    // No keepPreviousData: the stale list belongs to the host you just left.
    [host?.endpoint ?? "", home],
  );

  const rows = workspaces ?? [];
  // What the settings say to start in, when they say something this host recognizes. It is a path
  // from a folder picker, which this host resolves if it has a workspace there — and does not, when
  // the path belongs to another machine.
  const configuredName = defaults.workspace ?? "";
  const configured = configuredName ? matchWorkspace(rows, configuredName) : null;
  const configuredId = configured?.id;

  // `undefined` means "not read yet", which is different from "this host has no memory".
  const [remembered, setRemembered] = useState<WorkspaceChoice | null>();
  useEffect(() => {
    if (!host) {
      setRemembered(null);
      return;
    }
    let cancelled = false;
    setRemembered(undefined);
    (async () => {
      const choice = await recallWorkspace(LocalStorage, host.serverId);
      if (!cancelled) setRemembered(choice);
    })();
    return () => {
      cancelled = true;
    };
  }, [host?.serverId]);

  const [workspaceId, setWorkspaceId] = useState<string>("");
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    // "Other Directory…" is not a workspace but is still a choice worth keeping across refreshes.
    const known = (id: string) => id === OTHER_DIRECTORY || workspaces.some((row) => sameId(row, id));
    const rememberedHere = remembered && known(remembered.id) ? remembered.id : undefined;
    setWorkspaceId((current) => (known(current) ? current : (configuredId ?? rememberedHere ?? workspaces[0].id)));
  }, [workspaces, remembered, configuredId]);

  const loading = workspacesLoading || remembered === undefined;
  const namedWorkspace = workspaceArg ? matchWorkspace(rows, workspaceArg) : null;
  const workspaceProblem =
    workspaceArg && workspaces && !namedWorkspace ? `No workspace on ${host?.label ?? "this host"} matches “${workspaceArg}”.` : undefined;

  // Only a workspace that was actually used before counts as a default; the first item in the list
  // is a guess, and a guess is exactly what the picker is here to avoid.
  const rememberedHere = remembered ? (rows.find((row) => sameId(row, remembered.id)) ?? null) : null;
  // The setting outranks the memory: a default that is quietly ignored once you have asked elsewhere
  // would not be a default.
  const settled = namedWorkspace ?? configured ?? rememberedHere;
  const localDirectory = host && host.serverId === localServerId ? defaults.cwd : undefined;
  const noDefaultHint =
    rows.length > 0 && !settled && !localDirectory && host
      ? `Nothing has been asked on ${host.label} yet, so pick a workspace — it becomes the default next time.`
      : undefined;
  const misplacedDefaultHint =
    configuredName && workspaces && !configured
      ? `“${configuredName}” from the settings is not a workspace on ${host?.label ?? "this host"}.`
      : undefined;

  const unavailable =
    lookup.kind === "unreadable"
      ? `# Cannot Read Paseo's Host List\n\n${lookup.reason}`
      : !host
        ? hosts.length === 0
          ? "# No Hosts\n\nPaseo has no hosts stored yet. Add one in the Paseo desktop app, then open this command again."
          : "# No Host Is Reachable\n\nEvery host Paseo knows about is out of reach or offers no connection this extension can use. Check the Paseo desktop app, and any tunnel to a host on another machine."
        : undefined;

  return {
    hosts: reachable,
    host,
    chooseHost: setHostId,
    workspaces: rows,
    workspacesLoading,
    workspaceId,
    chooseWorkspace: setWorkspaceId,
    defaultCwd: defaults.cwd ?? "",
    home,
    loading,
    unavailable,
    settled,
    localDirectory,
    problems: [hostProblem, workspaceProblem].filter((problem): problem is string => Boolean(problem)),
    hints: [misplacedDefaultHint, noDefaultHint].filter((hint): hint is string => Boolean(hint)),
    choiceFrom: (values) => {
      const picked =
        values.workspace && values.workspace !== OTHER_DIRECTORY
          ? rows.find((row) => sameId(row, values.workspace))
          : undefined;
      const cwd = picked?.directory ?? values.directory?.[0]?.trim();
      return cwd ? { cwd, workspaceId: picked?.id } : null;
    },
  };
}

/** The host and workspace fields, so both entry points ask the same way. */
export function TargetFields({ target }: { target: AskTarget }) {
  const { host, workspaces, workspaceId, workspacesLoading } = target;
  const hasWorkspaces = workspaces.length > 0;
  const choosingDirectory = workspaceId === OTHER_DIRECTORY || (!workspacesLoading && !hasWorkspaces);

  if (!host) return null;

  return (
    <>
      <Form.Dropdown id="host" title="Host" value={host.serverId} onChange={target.chooseHost}>
        {target.hosts.map((row) => (
          <Form.Dropdown.Item key={row.serverId} value={row.serverId} title={row.label} icon={hostIcon(row)} />
        ))}
      </Form.Dropdown>
      {hasWorkspaces || workspacesLoading ? (
        <Form.Dropdown id="workspace" title="Workspace" value={workspaceId} onChange={target.chooseWorkspace}>
          {hasWorkspaces ? (
            workspaces.map((workspace) => (
              <Form.Dropdown.Item
                key={workspace.id}
                value={workspace.id}
                title={workspace.title}
                keywords={[workspace.directory, workspace.project]}
              />
            ))
          ) : (
            <Form.Dropdown.Item value={LOADING_WORKSPACE} title="Loading workspaces…" />
          )}
          <Form.Dropdown.Item value={OTHER_DIRECTORY} title="Other Directory…" />
        </Form.Dropdown>
      ) : null}
      {choosingDirectory ? (
        <Form.FilePicker
          id="directory"
          title="Directory"
          canChooseFiles={false}
          canChooseDirectories
          allowMultipleSelection={false}
          showHiddenFiles
          defaultValue={target.defaultCwd ? [target.defaultCwd] : []}
          info={
            hasWorkspaces
              ? `Any directory on ${host.label}.`
              : `${host.label} has no workspaces in Paseo, so pick a directory on it.`
          }
        />
      ) : null}
    </>
  );
}
