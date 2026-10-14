/**
 * Creating the agent, then showing the conversation.
 *
 * The request is fixed once this view exists: it is the outcome of a form, and re-deriving it from
 * live state while the agent is being created would just invite it to change underneath.
 */
import { Detail, LocalStorage, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { useConversation } from "../hooks/use-conversation";
import { usePreferences } from "../hooks/use-paseo-hosts";
import { startAgent } from "../paseo/agents";
import type { AgentsClient } from "../paseo/agents";
import { connectPaseo, describeConnectionError } from "../paseo/client";
import type { PaseoEndpoint } from "../paseo/client";
import { openAgentInDesktop } from "../paseo/desktop";
import type { HostRow } from "../paseo/hosts";
import { createOpenDesktopAction } from "../paseo/open-desktop";
import { resolveMode, resolveProviderChoice } from "../paseo/preferences";
import { rememberWorkspace } from "../paseo/recent-choices";
import ConversationDetail from "./conversation-detail";

export interface AgentRequest {
  question: string;
  host: HostRow;
  endpoint: PaseoEndpoint;
  cwd: string;
  workspaceId?: string;
}

export function StartAgent({ request }: { request: AgentRequest }) {
  const [settled] = useState(request);
  const prefs = usePreferences();
  const [agentId, setAgentId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = await connectPaseo(settled.endpoint);
        if (cancelled) return void client.close();
        const choice = resolveProviderChoice(prefs.provider, prefs.model);
        const created = await startAgent(client as unknown as AgentsClient, {
          provider: choice.provider,
          model: choice.model,
          mode: resolveMode(prefs.mode),
          cwd: settled.cwd,
          workspaceId: settled.workspaceId,
          prompt: settled.question,
          title: settled.question.slice(0, 60),
          labels: { source: "raycast" },
        });
        await client.close();
        // Remember where this went, so the same host needs no arguments next time.
        if (settled.workspaceId) {
          await rememberWorkspace(LocalStorage, settled.host.serverId, {
            id: settled.workspaceId,
            path: settled.cwd,
          });
        }
        if (!cancelled) setAgentId(created);
      } catch (createError) {
        if (!cancelled) setError(describeConnectionError(createError, settled.endpoint));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settled, prefs.provider, prefs.model, prefs.mode]);

  const conversation = useConversation({ endpoint: settled.endpoint, agentId });

  if (error || conversation.error) {
    return <Detail markdown={`# Something Went Wrong\n\n${error ?? conversation.error}`} />;
  }

  if (!agentId) {
    return <Detail isLoading markdown={`Creating the agent on ${settled.host.label}…`} />;
  }

  return (
    <ConversationDetail
      agentId={agentId}
      state={conversation.state}
      onFollowUp={(text) => void conversation.send(text)}
      onStop={() => void conversation.stop()}
      onArchive={() => void conversation.archive()}
      onPermissionResponse={(requestId, action) => void conversation.respond(requestId, action)}
      onQuestionAnswers={(requestId, input, answers) => void conversation.answer(requestId, input, answers)}
      onOpenDesktop={createOpenDesktopAction(
        { serverId: settled.host.serverId, agentId, preferredPath: prefs.paseoAppPath },
        {
          open: openAgentInDesktop,
          notify: (message) =>
            void showToast({ style: Toast.Style.Failure, title: "Could not open Paseo Desktop", message }),
        },
      )}
    />
  );
}
