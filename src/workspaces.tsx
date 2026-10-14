import { Action, ActionPanel, Color, Icon, Keyboard, List, Toast, showToast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import ConversationDetail from "./components/conversation-detail";
import { hostIcon } from "./components/host-icon";
import { useConversation } from "./hooks/use-conversation";
import { usePaseoHome, usePaseoHosts, usePreferences } from "./hooks/use-paseo-hosts";
import { archiveAgent, listAgents, stopAgent } from "./paseo/agents";
import type { AgentRow, AgentsClient } from "./paseo/agents";
import { connectPaseo, describeConnectionError } from "./paseo/client";
import type { PaseoEndpoint } from "./paseo/client";
import { openAgentInDesktop } from "./paseo/desktop";
import type { HostRow } from "./paseo/hosts";
import { createOpenDesktopAction } from "./paseo/open-desktop";
import { describeStatus, describeWorkspaceStatus } from "./paseo/status";
import type { StatusTone } from "./paseo/status";
import { groupAgentsByWorkspace, includeArchivedFor, listWorkspaces, scopeAgents } from "./paseo/workspaces";
import type { AgentScope, WorkspaceRow, WorkspacesClient } from "./paseo/workspaces";

// Colour carries the status at a glance, so the leading circle and the status tag use the same one.
const TONE_COLOR: Record<StatusTone, Color> = {
  active: Color.Orange,
  ready: Color.Green,
  failed: Color.Red,
  unknown: Color.SecondaryText,
};

const TONE_ICON: Record<StatusTone, Icon> = {
  active: Icon.CircleProgress,
  ready: Icon.Circle,
  failed: Icon.Circle,
  unknown: Icon.Circle,
};

/** The "every host" dropdown item, which is also the sentinel the list filters on. */
const HOST_ALL = "host:all";
const ALL_HOSTS = "all";

const SCOPE_LABEL: Record<AgentScope, string> = {
  active: "Active",
  archived: "Archived",
  all: "Active and Archived",
};

const WORKSPACE_TITLE_FALLBACK = "Untitled workspace";

function workspaceTitle(workspace: WorkspaceRow | null | undefined): string {
  return workspace?.title || WORKSPACE_TITLE_FALLBACK;
}

/** A host that answered, with what it had to say. */
interface LoadedHost {
  host: HostRow;
  endpoint: PaseoEndpoint;
  workspaces: WorkspaceRow[];
  tabs: AgentRow[];
}

/** A host that could not be listed, and why — shown in its place so the gap is visible. */
interface FailedHost {
  host: HostRow;
  reason: string;
}

interface HostListing {
  loaded: LoadedHost[];
  failed: FailedHost[];
}

/**
 * Every host is asked in parallel and answers for itself: one daemon being unreachable — a tunnel
 * that is down, a machine that is asleep — must not cost you the tabs on the others.
 */
async function loadHosts(hosts: HostRow[], params: { home: string; scope: AgentScope }): Promise<HostListing> {
  const results = await Promise.all(hosts.map((host) => loadHost(host, params)));
  return {
    loaded: results.filter((result): result is LoadedHost => "endpoint" in result),
    failed: results.filter((result): result is FailedHost => "reason" in result),
  };
}

async function loadHost(host: HostRow, params: { home: string; scope: AgentScope }): Promise<LoadedHost | FailedHost> {
  if (!host.endpoint) {
    return { host, reason: host.unavailable ?? "This host has no address this extension can connect to." };
  }

  const endpoint: PaseoEndpoint = { host: host.endpoint, home: params.home };
  try {
    const client = await connectPaseo(endpoint);
    try {
      const workspaces = await listWorkspaces(client as unknown as WorkspacesClient);
      const agents = await listAgents(client as unknown as AgentsClient, {
        includeArchived: includeArchivedFor(params.scope),
      });
      return { host, endpoint, workspaces, tabs: scopeAgents(agents, params.scope) };
    } finally {
      await client.close();
    }
  } catch (loadError) {
    return { host, reason: describeConnectionError(loadError, endpoint) };
  }
}

/**
 * One dropdown, two independent questions: which host, and whether archived tabs count.
 *
 * Raycast gives a list a single search-bar accessory, so the two filters share it as two sections,
 * each item value naming the filter it belongs to; choosing one leaves the other alone. The
 * collapsed label can only show the choice that was made last, which is why the list title spells
 * out both.
 */
function FilterDropdown(props: { hosts: HostRow[]; chosen: string; onChoose: (value: string) => void }) {
  return (
    <List.Dropdown
      tooltip="Choose a host, and whether to show archived tabs"
      value={props.chosen}
      onChange={props.onChoose}
    >
      <List.Dropdown.Section title="Host">
        <List.Dropdown.Item title="All Hosts" value={HOST_ALL} icon={Icon.Globe} />
        {props.hosts.map((host) => (
          <List.Dropdown.Item
            key={host.serverId}
            title={host.label}
            value={`host:${host.serverId}`}
            icon={hostIcon(host)}
          />
        ))}
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Tabs">
        <List.Dropdown.Item title="Active" value="scope:active" />
        <List.Dropdown.Item title="Archived" value="scope:archived" />
        <List.Dropdown.Item title="Active and Archived" value="scope:all" />
      </List.Dropdown.Section>
    </List.Dropdown>
  );
}

function AgentDetail({ tab, serverId, endpoint }: { tab: AgentRow; serverId: string; endpoint: PaseoEndpoint }) {
  const prefs = usePreferences();
  const conversation = useConversation({ endpoint, agentId: tab.id });

  return (
    <ConversationDetail
      agentId={tab.id}
      state={conversation.state}
      onFollowUp={(text) => void conversation.send(text)}
      onStop={() => void conversation.stop()}
      onArchive={() => void conversation.archive()}
      onPermissionResponse={(requestId, action) => void conversation.respond(requestId, action)}
      onQuestionAnswers={(requestId, input, answers) => void conversation.answer(requestId, input, answers)}
      onOpenDesktop={createOpenDesktopAction(
        { serverId, agentId: tab.id, preferredPath: prefs.paseoAppPath },
        {
          open: openAgentInDesktop,
          notify: (message) => void showToast({ style: Toast.Style.Failure, title: "Could not open Paseo Desktop", message }),
        },
      )}
    />
  );
}

/**
 * One tab row. `workspace` is set only in the workspace-grouped list: there it buys the extra
 * action that narrows the list down to that one workspace, which is how you search inside a single
 * workspace rather than across all of them.
 */
function AgentTabItem(props: {
  tab: AgentRow;
  workspace?: WorkspaceRow;
  serverId: string;
  endpoint: PaseoEndpoint;
  paseoAppPath?: string;
  /** Carried into the workspace list so it opens on the scope you were already looking at. */
  scope: AgentScope;
  onChanged: () => void;
}) {
  const { tab, workspace, serverId, endpoint, paseoAppPath, scope, onChanged } = props;
  const status = describeStatus(tab.status);

  /** Every action needs its own connection; the list holds none open. */
  async function withClient(run: (client: AgentsClient) => Promise<void>) {
    const client = await connectPaseo(endpoint);
    try {
      await run(client as unknown as AgentsClient);
    } finally {
      await client.close();
    }
    onChanged();
  }

  return (
    <List.Item
      icon={{ source: TONE_ICON[status.tone], tintColor: TONE_COLOR[status.tone] }}
      title={tab.title}
      accessories={[
        { tag: { value: status.label, color: TONE_COLOR[status.tone] } },
        { text: tab.cwd },
      ]}
      // The workspace name is in here on purpose: Raycast's own filtering indexes item titles and
      // keywords only, never the section title, so this is what makes a search for a workspace name
      // list every tab inside it.
      keywords={[tab.cwd, tab.id, ...(workspace ? [workspace.title, workspace.project, workspace.directory] : [])]}
      actions={
        <ActionPanel>
          <Action.Push
            title="Open Agent"
            icon={Icon.Message}
            target={<AgentDetail tab={tab} serverId={serverId} endpoint={endpoint} />}
          />
          {workspace ? (
            <Action.Push
              title="Show Workspace Tabs"
              icon={Icon.Folder}
              shortcut={{ modifiers: ["cmd"], key: "]" }}
              target={
                <WorkspaceTabs
                  workspace={workspace}
                  serverId={serverId}
                  endpoint={endpoint}
                  initialScope={scope}
                  onChanged={onChanged}
                />
              }
            />
          ) : null}
          <Action
            title="Stop"
            icon={Icon.Stop}
            shortcut={{ modifiers: ["cmd"], key: "." }}
            onAction={() =>
              withClient(async (client) => {
                await stopAgent(client, tab.id);
                await showToast({ style: Toast.Style.Success, title: "Stopped" });
              })
            }
          />
          <Action
            title="Open in Paseo Desktop"
            icon={Icon.Window}
            shortcut={Keyboard.Shortcut.Common.Open}
            onAction={createOpenDesktopAction(
              { serverId, agentId: tab.id, preferredPath: paseoAppPath },
              {
                open: openAgentInDesktop,
                notify: (message) =>
                  void showToast({ style: Toast.Style.Failure, title: "Could not open Paseo Desktop", message }),
              },
            )}
          />
          <Action.CopyToClipboard title="Copy Agent ID" content={tab.id} shortcut={Keyboard.Shortcut.Common.Copy} />
          <Action
            title="Archive"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={() =>
              withClient(async (client) => {
                await archiveAgent(client, tab.id);
                await showToast({ style: Toast.Style.Success, title: "Archived" });
              })
            }
          />
          <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={() => onChanged()} />
        </ActionPanel>
      }
    />
  );
}

/** The second level: only the tabs of one workspace, so the search bar searches inside it. */
function WorkspaceTabs(props: {
  workspace: WorkspaceRow;
  serverId: string;
  endpoint: PaseoEndpoint;
  initialScope: AgentScope;
  onChanged: () => void;
}) {
  const { workspace, serverId, endpoint, initialScope, onChanged } = props;
  const [scope, setScope] = useState<AgentScope>(initialScope);

  const { data, isLoading, error, revalidate } = useCachedPromise(
    async (host: string, home: string, workspaceId: string, currentScope: AgentScope) => {
      const client = await connectPaseo({ host, home });
      try {
        const agents = await listAgents(client as unknown as AgentsClient, {
          includeArchived: includeArchivedFor(currentScope),
        });
        return { tabs: scopeAgents(agents, currentScope).filter((agent) => agent.workspaceId === workspaceId) };
      } finally {
        await client.close();
      }
    },
    [endpoint.host, endpoint.home, workspace.id, scope],
  );

  const changed = () => {
    revalidate();
    onChanged();
  };

  if (error) {
    return (
      <List>
        <List.EmptyView icon={Icon.Warning} title="Cannot Reach Paseo" description={describeConnectionError(error, endpoint)} />
      </List>
    );
  }

  const tabs = data?.tabs ?? [];

  return (
    <List
      isLoading={isLoading}
      navigationTitle={workspaceTitle(workspace)}
      searchBarPlaceholder={`Search tabs in ${workspaceTitle(workspace)}…`}
      searchBarAccessory={<ScopeDropdown value={scope} onChange={setScope} />}
    >
      {tabs.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="No Tabs Here"
          description={`${workspaceTitle(workspace)} has no tabs in this view. Start one with Ask Paseo.`}
        />
      ) : null}
      {tabs.map((tab) => (
        <AgentTabItem key={tab.id} tab={tab} serverId={serverId} endpoint={endpoint} scope={scope} onChanged={changed} />
      ))}
    </List>
  );
}

/** Inside one workspace there is nothing else to filter by, so the scope dropdown stands alone. */
function ScopeDropdown(props: { value: AgentScope; onChange: (scope: AgentScope) => void }) {
  return (
    <List.Dropdown tooltip="Show live tabs, archived tabs, or both" value={props.value} onChange={(value) => props.onChange(value as AgentScope)}>
      <List.Dropdown.Item title="Active" value="active" />
      <List.Dropdown.Item title="Archived" value="archived" />
      <List.Dropdown.Item title="All" value="all" />
    </List.Dropdown>
  );
}

export default function Command() {
  const prefs = usePreferences();
  const home = usePaseoHome();
  const lookup = usePaseoHosts();
  const hosts = lookup.kind === "hosts" ? lookup.hosts : [];

  const [scope, setScope] = useState<AgentScope>("active");
  const [hostFilter, setHostFilter] = useState<string>(ALL_HOSTS);
  // The dropdown shows one selection at a time, so it shows the last filter that was touched.
  const [chosen, setChosen] = useState(HOST_ALL);

  const choose = (value: string) => {
    setChosen(value);
    if (value.startsWith("host:")) setHostFilter(value.slice("host:".length));
    else setScope(value.slice("scope:".length) as AgentScope);
  };

  const { data, isLoading, revalidate } = useCachedPromise(
    async (currentScope: AgentScope) => loadHosts(hosts, { home, scope: currentScope }),
    [scope],
  );

  if (lookup.kind === "unreadable") {
    return (
      <List>
        <List.EmptyView icon={Icon.Warning} title="Cannot Read Paseo's Host List" description={lookup.reason} />
      </List>
    );
  }

  if (hosts.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Plug}
          title="No Hosts"
          description="Paseo has no hosts stored yet. Add one in the Paseo desktop app, then open this command again."
        />
      </List>
    );
  }

  const visible = (host: HostRow) => hostFilter === ALL_HOSTS || host.serverId === hostFilter;
  const loaded = (data?.loaded ?? []).filter((entry) => visible(entry.host));
  const failed = (data?.failed ?? []).filter((entry) => visible(entry.host));
  // A header names its host only once more than one host is on screen; a single host's rows are
  // already only its own.
  const nameTheHost = loaded.length + failed.length > 1;

  const sectionTitle = (host: HostRow, title: string | undefined) =>
    nameTheHost ? `${host.label} · ${title ?? "Other"}` : title;

  // One dropdown, two independent choices: the collapsed label can only show the one that was
  // picked last, so the title carries both and neither selection is ever hidden.
  const hostLabel = hostFilter === ALL_HOSTS ? "All Hosts" : (hosts.find((host) => host.serverId === hostFilter)?.label ?? hostFilter);

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`${hostLabel} · ${SCOPE_LABEL[scope]}`}
      searchBarPlaceholder="Search workspaces and tabs…"
      searchBarAccessory={<FilterDropdown hosts={hosts} chosen={chosen} onChoose={choose} />}
      filtering={{ keepSectionOrder: true }}
    >
      {loaded.length === 0 && failed.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.List}
          title={scope === "archived" ? "No Archived Tabs" : "No Active Tabs"}
          description={hostFilter === ALL_HOSTS ? "Start one with Ask Paseo" : "This host has none in this view."}
        />
      ) : null}

      {failed.map((entry) => (
        <List.Section key={`failed:${entry.host.serverId}`} title={nameTheHost ? entry.host.label : undefined}>
          <List.Item
            icon={{ source: Icon.Warning, tintColor: Color.Red }}
            title={`Cannot reach ${entry.host.label}`}
            subtitle={entry.reason}
            actions={
              <ActionPanel>
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => revalidate()} />
              </ActionPanel>
            }
          />
        </List.Section>
      ))}

      {loaded.flatMap((entry) =>
        groupAgentsByWorkspace(entry.tabs, entry.workspaces).map((group) => {
          const workspace = group.workspace;
          const count = group.tabs.length === 1 ? "1 tab" : `${group.tabs.length} tabs`;
          // A section has no accessory of its own, so the workspace's own status rides along in the
          // subtitle — it is the reason to group by workspace in the first place.
          const subtitle = workspace
            ? [workspace.project, count, describeWorkspaceStatus(workspace.status).label].filter(Boolean).join(" · ")
            : `Tabs whose workspace is not in this list · ${count}`;

          // Most workspaces hold exactly one tab, and a header above a single row only repeats what
          // the row already says. Title the section only when it actually groups something; the
          // loose-tabs section keeps its header because "Other" is information the rows don't carry.
          const groupTitle =
            workspace === null ? "Other" : group.tabs.length > 1 ? workspaceTitle(workspace) : undefined;

          return (
            <List.Section
              key={`${entry.host.serverId}:${workspace?.id ?? "loose"}`}
              title={sectionTitle(entry.host, groupTitle)}
              subtitle={subtitle}
            >
              {group.tabs.map((tab) => (
                <AgentTabItem
                  key={tab.id}
                  tab={tab}
                  workspace={workspace ?? undefined}
                  serverId={entry.host.serverId}
                  endpoint={entry.endpoint}
                  paseoAppPath={prefs.paseoAppPath}
                  scope={scope}
                  onChanged={() => revalidate()}
                />
              ))}
            </List.Section>
          );
        }),
      )}
    </List>
  );
}
