import { Action, ActionPanel, Detail, Form, LaunchProps, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { TargetFields, useAskTarget } from "./components/ask-target";
import { StartAgent } from "./components/start-agent";
import type { AgentRequest } from "./components/start-agent";
import { usePreferences } from "./hooks/use-paseo-hosts";
import { expandQuickCommand, findQuickCommand, parseInvocation, readQuickSlots } from "./paseo/quick-commands";

type AskProps = LaunchProps<{ arguments: { question?: string; host?: string; workspace?: string } }>;

export default function Command(props: AskProps) {
  const questionArg = props.arguments.question?.trim() ?? "";
  const target = useAskTarget({
    hostArg: props.arguments.host,
    workspaceArg: props.arguments.workspace,
    scope: "ask",
  });

  // A question that opens with a slash is looked up among the configured quick commands; only a
  // name that is actually one of them is expanded, so a path or a stray slash stays a question.
  const commands = readQuickSlots(usePreferences());
  const invocation = questionArg.startsWith("/") ? parseInvocation(questionArg) : null;
  const quickCommand = invocation ? findQuickCommand(commands, invocation.name) : null;
  const question = quickCommand ? expandQuickCommand(quickCommand, invocation?.args ?? "") : questionArg;

  const [request, setRequest] = useState<AgentRequest>();

  if (target.unavailable) {
    return <Detail markdown={target.unavailable} />;
  }

  if (target.loading) {
    return <Detail isLoading markdown={target.host ? `Looking up ${target.host.label}…` : "Looking up Paseo…"} />;
  }

  if (request) return <StartAgent request={request} />;

  const settled = target.settled?.directory ?? target.localDirectory;
  const auto: AgentRequest | undefined =
    question && target.host?.endpoint && target.problems.length === 0 && settled
      ? {
          question,
          host: target.host,
          endpoint: { host: target.host.endpoint, home: target.home },
          cwd: settled,
          workspaceId: target.settled?.id,
        }
      : undefined;
  if (auto) return <StartAgent request={auto} />;

  // The form is the fallback: it is where a name that matched nothing, a host nothing has been asked
  // on yet, or an empty question sends you.
  const note = [
    ...target.problems,
    questionArg ? undefined : "The question was empty, so the command opened this form instead of asking straight away.",
    ...target.hints,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Form
      isLoading={target.workspacesLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Ask"
            onSubmit={(values: { question: string; workspace: string; directory?: string[] }) => {
              const asked = values.question?.trim();
              if (!asked) {
                void showToast({ style: Toast.Style.Failure, title: "Type a question first" });
                return;
              }
              const choice = target.choiceFrom(values);
              if (!choice || !target.host?.endpoint) {
                void showToast({ style: Toast.Style.Failure, title: "Choose a workspace or a directory" });
                return;
              }
              setRequest({
                question: asked,
                host: target.host,
                endpoint: { host: target.host.endpoint, home: target.home },
                cwd: choice.cwd,
                workspaceId: choice.workspaceId,
              });
            }}
          />
        </ActionPanel>
      }
    >
      {note ? <Form.Description title="Why you are seeing this" text={note} /> : null}
      <Form.TextArea
        id="question"
        title="Question"
        placeholder="What should Paseo do?"
        defaultValue={question}
        autoFocus
      />
      <TargetFields target={target} />
    </Form>
  );
}
