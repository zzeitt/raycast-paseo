/**
 * One quick-command slot, as a command of its own.
 *
 * Raycast only runs commands it was packaged with, so a shortcut that can carry its own alias and
 * hotkey has to be a declared command — hence the fixed slots, each with its settings in the
 * extension's preferences. An unused slot says so instead of failing when it is run.
 *
 * The argument is a command argument, so it is filled in the search bar the way Ask's question is:
 * `Paseo Quick 1` → Tab → paste the link → Enter, and nothing stands between that and the agent. A
 * slot whose prompt has no placeholder needs no argument at all, which is what makes a hotkey on it
 * a single keystroke.
 */
import { Action, ActionPanel, Detail, Form, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { usePreferences } from "../hooks/use-paseo-hosts";
import { argumentHintOf, expandQuickCommand, quickSlot, readQuickSlots } from "../paseo/quick-commands";
import { TargetFields, useAskTarget } from "./ask-target";
import { StartAgent } from "./start-agent";
import type { AgentRequest } from "./start-agent";

export default function QuickSlot({ slot, argumentArg }: { slot: number; argumentArg?: string }) {
  const prefs = usePreferences();
  const command = quickSlot(readQuickSlots(prefs), slot);
  const target = useAskTarget({ scope: "quick" });
  const [request, setRequest] = useState<AgentRequest>();

  if (!command) {
    return (
      <Detail
        markdown={`# Quick ${slot} Is Not Set Up

Give this slot a name and a prompt in the extension's preferences — **Quick ${slot} Name** and **Quick ${slot} Prompt** — and this command will send it.

If you have no use for it, disable the command in Raycast rather than leaving it in the list.`}
      />
    );
  }

  if (target.unavailable) return <Detail markdown={target.unavailable} />;
  if (request) return <StartAgent request={request} />;
  if (target.loading) return <Detail isLoading markdown="Looking up Paseo…" />;

  const argument = argumentArg?.trim() ?? "";
  const needsArgument = argumentHintOf(command);
  const settled = target.settled?.directory ?? target.localDirectory;

  // Everything the command needs is in hand: send it without another screen. A prompt that takes no
  // argument gets here on the first Enter, argument or not.
  const auto: AgentRequest | undefined =
    target.host?.endpoint && target.problems.length === 0 && settled && (!needsArgument || argument)
      ? {
          question: expandQuickCommand(command, argument),
          host: target.host,
          endpoint: { host: target.host.endpoint, home: target.home },
          cwd: settled,
          workspaceId: target.settled?.id,
        }
      : undefined;
  if (auto) return <StartAgent request={auto} />;

  // Only the argument, a name that matched nothing, or a host nothing has been asked on yet gets
  // this far — and the form says which.
  const note = [
    ...target.problems,
    needsArgument && !argument ? `This command needs an argument: the prompt asks for a “${needsArgument}”.` : undefined,
    ...target.hints,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Form
      navigationTitle={`/${command.name}`}
      isLoading={target.workspacesLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send"
            onSubmit={(values: { argument: string; workspace: string; directory?: string[] }) => {
              const choice = target.choiceFrom(values);
              if (!choice || !target.host?.endpoint) {
                void showToast({ style: Toast.Style.Failure, title: "Choose a workspace or a directory" });
                return;
              }
              setRequest({
                question: expandQuickCommand(command, values.argument ?? ""),
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
      <Form.TextField
        id="argument"
        title={needsArgument ?? "Argument"}
        placeholder={needsArgument ?? "What the prompt needs"}
        defaultValue={argument}
        autoFocus
      />
      <TargetFields target={target} />
      <Form.Description title="Sends" text={command.prompt} />
    </Form>
  );
}
