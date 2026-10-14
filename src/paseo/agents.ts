/**
 * Thin wrapper around agent operations — an agent is one conversation, and its tab in the
 * workspace is that agent. It only shuttles arguments and maps DTOs, so unit tests can use a fake
 * client.
 */

export interface AgentsClient {
  fetchAgents(options?: unknown): Promise<{ entries: Array<{ agent: unknown }> }>;
  createAgent(options: unknown): Promise<unknown>;
  sendAgentMessage(agentId: string, text: string, options?: unknown): Promise<void>;
  cancelAgent(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
}

export interface AgentRow {
  id: string;
  title: string;
  status: string;
  cwd: string;
  /** Which workspace this tab belongs to; absent for an agent the daemon did not place anywhere. */
  workspaceId?: string;
  updatedAt: string;
  archivedAt: string | null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function toAgentRow(agent: unknown): AgentRow {
  const raw = (agent ?? {}) as Record<string, unknown>;
  const id = asString(raw.id);
  return {
    id,
    title: asString(raw.title) || id.slice(0, 7),
    status: asString(raw.status, "unknown"),
    cwd: asString(raw.cwd),
    workspaceId: typeof raw.workspaceId === "string" && raw.workspaceId.length > 0 ? raw.workspaceId : undefined,
    updatedAt: asString(raw.updatedAt),
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
  };
}

export async function listAgents(
  client: AgentsClient,
  options: { includeArchived?: boolean } = {},
): Promise<AgentRow[]> {
  const result = await client.fetchAgents({ filter: { includeArchived: options.includeArchived === true } });
  return result.entries
    .map((entry) => toAgentRow(entry.agent))
    .filter((row) => options.includeArchived === true || row.archivedAt === null);
}

/**
 * `labels` is an explicit field on `CreateAgentRequestOptions` (daemon-client.d.ts:187)
 * and is forwarded to the daemon as-is at runtime (daemon-client.js:1659). Use it to
 * mark the origin of an agent started from Raycast.
 *
 * `workspaceId` (daemon-client.d.ts:174) places the agent in a workspace the user named, rather
 * than leaving the daemon to infer one from the cwd.
 */
export async function startAgent(
  client: AgentsClient,
  params: {
    provider: string;
    model?: string;
    /** Session mode id, from the provider's own list; omitted to let the daemon decide. */
    mode?: string;
    cwd: string;
    workspaceId?: string;
    prompt: string;
    title?: string;
    labels?: Record<string, string>;
  },
): Promise<string> {
  const agent = (await client.createAgent({
    provider: params.provider,
    ...(params.model?.trim() ? { model: params.model.trim() } : {}),
    ...(params.mode ? { modeId: params.mode } : {}),
    cwd: params.cwd,
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.labels ? { labels: params.labels } : {}),
    initialPrompt: params.prompt,
  })) as { id?: unknown };
  const id = asString(agent?.id);
  if (!id) throw new Error("The daemon did not return an agent id");
  return id;
}

/** Deliberately no options: the default behavior (interrupt) is what we want, and a follow-up is only offered while idle. */
export function sendFollowUp(client: AgentsClient, agentId: string, text: string): Promise<void> {
  return client.sendAgentMessage(agentId, text);
}

export function stopAgent(client: AgentsClient, agentId: string): Promise<void> {
  return client.cancelAgent(agentId);
}

export function archiveAgent(client: AgentsClient, agentId: string): Promise<{ archivedAt: string }> {
  return client.archiveAgent(agentId);
}
