import { Action, ActionPanel, Detail, Form, Icon, Keyboard, Toast, showToast, useNavigation } from "@raycast/api";
import { useState } from "react";
import { canSendFollowUp, pendingPermission, toMarkdown } from "../paseo/timeline";
import type { ConversationState } from "../paseo/timeline";
import { buildAnswers } from "../paseo/permissions";
import type { PermissionAction, Question } from "../paseo/permissions";
import AnswerQuestions from "./answer-questions";

interface ConversationDetailProps {
  agentId: string;
  state: ConversationState;
  onFollowUp: (text: string) => void;
  onStop: () => void;
  onArchive: () => void;
  onOpenDesktop: () => void;
  onPermissionResponse: (requestId: string, action: PermissionAction) => void;
  onQuestionAnswers: (requestId: string, input: Record<string, unknown> | undefined, answers: Record<string, string>) => void;
}

function FollowUpForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send"
            onSubmit={(values: { text: string }) => {
              const text = values.text.trim();
              if (!text) return;
              onSubmit(text);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="text" title="Follow-up" placeholder="Ask this agent something else…" autoFocus />
      <Form.Description text="Sending while the agent is answering interrupts the current turn; stop it first to avoid that." />
    </Form>
  );
}

/**
 * A single-select question is small enough to answer from the action panel: one
 * key per option, no extra screen. Anything else — multi-select, or a batch of
 * questions — needs the form, because no single keystroke can express it.
 */
function quickPicks(questions: Question[] | undefined): Question | undefined {
  if (!questions || questions.length !== 1) return undefined;
  const [only] = questions;
  return only.multiSelect || only.options.length === 0 ? undefined : only;
}

export default function ConversationDetail(props: ConversationDetailProps) {
  const { state } = props;
  const [showActivity, setShowActivity] = useState(false);
  const markdown = toMarkdown(state, { showActivity });
  const pending = pendingPermission(state);
  const requestId = pending?.requestId;
  const questions = pending?.questions;
  const quick = quickPicks(questions);

  function answer(answers: Record<string, string>) {
    if (!requestId) return;
    props.onQuestionAnswers(requestId, pending?.input, answers);
    void showToast({ style: Toast.Style.Success, title: "Answers sent" });
  }

  return (
    <Detail
      isLoading={state.running}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Agent" text={props.agentId} />
          <Detail.Metadata.Label title="Status" text={state.running ? "Answering" : "Idle"} />
          {pending ? <Detail.Metadata.Label title="Waiting for you" text={pending.text} /> : null}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {/* While the agent is waiting on an answer, that answer leads the panel — it is the only useful thing to do. */}
          {quick && requestId
            ? quick.options.slice(0, 9).map((option, index) => (
                <Action
                  key={option.label}
                  title={option.label}
                  shortcut={{ modifiers: ["cmd"], key: String(index + 1) as Keyboard.KeyEquivalent }}
                  onAction={() => answer(buildAnswers([quick], { 0: [option.label] }))}
                />
              ))
            : null}
          {questions && questions.length > 0 && requestId ? (
            <Action.Push
              title={questions.length > 1 ? `Answer ${questions.length} Questions…` : "Answer…"}
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["cmd"], key: "enter" }}
              target={<AnswerQuestions questions={questions} onSubmit={answer} />}
            />
          ) : null}
          {pending && !questions
            ? pending.actions?.map((action) => (
                <Action
                  key={action.id || action.label}
                  title={action.label}
                  icon={action.behavior === "allow" ? Icon.Check : Icon.XMarkCircle}
                  style={action.variant === "danger" ? Action.Style.Destructive : Action.Style.Regular}
                  onAction={() => {
                    if (!requestId) return;
                    props.onPermissionResponse(requestId, action);
                    void showToast({ style: Toast.Style.Success, title: `Replied: ${action.label}` });
                  }}
                />
              ))
            : null}
          <Action
            title={showActivity ? "Collapse Thoughts and Tool Calls" : "Expand Thoughts and Tool Calls"}
            icon={showActivity ? Icon.EyeDisabled : Icon.Eye}
            shortcut={{ modifiers: ["opt"], key: "t" }}
            onAction={() => setShowActivity((value) => !value)}
          />
          {canSendFollowUp(state) ? (
            <Action.Push
              title="Follow-up"
              icon={Icon.Message}
              target={<FollowUpForm onSubmit={props.onFollowUp} />}
              // Not ⌘↵: that belongs to answering a question, and the two actions
              // can sit in the same panel.
              shortcut={{ modifiers: ["cmd"], key: "m" }}
            />
          ) : (
            <Action
              title="Answering… (stop it before sending a follow-up)"
              icon={Icon.Clock}
              onAction={() => showToast({ style: Toast.Style.Animated, title: "The agent is answering — press Stop first" })}
            />
          )}
          <Action title="Stop" icon={Icon.Stop} onAction={props.onStop} />
          <Action.CopyToClipboard title="Copy Agent ID" content={props.agentId} />
          <Action title="Open in Paseo Desktop" icon={Icon.Window} onAction={props.onOpenDesktop} />
          <Action title="Archive This Session" icon={Icon.Trash} style={Action.Style.Destructive} onAction={props.onArchive} />
        </ActionPanel>
      }
    />
  );
}
