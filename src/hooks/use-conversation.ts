import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectPaseo, describeConnectionError } from "../paseo/client";
import type { PaseoEndpoint } from "../paseo/client";
import { createConversationState } from "../paseo/timeline";
import type { ConversationState } from "../paseo/timeline";
import { startConversationStream } from "../paseo/session-stream";
import type { ConversationStream, StreamClient } from "../paseo/session-stream";
import { archiveAgent, sendFollowUp, stopAgent } from "../paseo/agents";
import type { AgentsClient } from "../paseo/agents";
import { respondToPermission, respondWithAnswers } from "../paseo/permissions";
import type { PermissionAction, PermissionsClient } from "../paseo/permissions";

/**
 * Thin shell on the React side: this hook owns the connection (follow-up/stop/archive still need to reuse it).
 * The ordering logic of "subscribe → fetch history → throttled refresh" lives in paseo/session-stream.ts,
 * covered by unit tests. This hook only pushes results into state and tears everything down on unmount.
 *
 * No endpoint yet (Ask before the form is submitted) is a valid state and simply connects to nothing.
 */
export function useConversation(params: { endpoint?: PaseoEndpoint; agentId?: string }) {
  const { endpoint, agentId } = params;
  const [state, setState] = useState<ConversationState>(createConversationState);
  const [error, setError] = useState<string>();

  const clientRef = useRef<DaemonClient | undefined>(undefined);

  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    let stream: ConversationStream | undefined;
    // Clear first when switching agents: otherwise the previous session's content briefly shows.
    setError(undefined);
    setState(createConversationState());

    (async () => {
      try {
        const connected = await connectPaseo(endpoint);
        if (cancelled) {
          void connected.close();
          return;
        }
        clientRef.current = connected;

        if (agentId) {
          stream = startConversationStream({
            client: connected as unknown as StreamClient,
            agentId,
            onState: (next) => {
              if (!cancelled) setState(next);
            },
            onError: (streamError) => {
              if (!cancelled) setError(describeConnectionError(streamError, endpoint));
            },
          });
        }
      } catch (connectError) {
        if (!cancelled) setError(describeConnectionError(connectError, endpoint));
      }
    })();

    return () => {
      cancelled = true;
      stream?.stop();
      const current = clientRef.current;
      clientRef.current = undefined;
      void current?.close();
    };
  }, [endpoint?.host, endpoint?.home, agentId]);

  return {
    state,
    error,
    send: async (text: string) => {
      if (!clientRef.current || !agentId) return;
      await sendFollowUp(clientRef.current as unknown as AgentsClient, agentId, text);
    },
    stop: async () => {
      if (!clientRef.current || !agentId) return;
      await stopAgent(clientRef.current as unknown as AgentsClient, agentId);
    },
    archive: async () => {
      if (!clientRef.current || !agentId) return;
      await archiveAgent(clientRef.current as unknown as AgentsClient, agentId);
    },
    respond: async (requestId: string, action: PermissionAction) => {
      if (!clientRef.current || !agentId) return;
      await respondToPermission(clientRef.current as unknown as PermissionsClient, agentId, requestId, action);
    },
    answer: async (requestId: string, input: Record<string, unknown> | undefined, answers: Record<string, string>) => {
      if (!clientRef.current || !agentId) return;
      await respondWithAnswers(clientRef.current as unknown as PermissionsClient, agentId, requestId, input, answers);
    },
  };
}
