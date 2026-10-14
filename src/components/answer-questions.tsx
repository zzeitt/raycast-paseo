import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { Fragment, useState } from "react";
import { buildAnswers } from "../paseo/permissions";
import type { Question, QuestionPicks } from "../paseo/permissions";

/**
 * Dropdown value standing for the free-text answer. Not a label the daemon could
 * ever send, so it cannot collide with a real option.
 */
const OTHER = "\u0000other";

interface AnswerQuestionsProps {
  questions: Question[];
  /** Receives the finished `answers` map, ready to send back to the daemon. */
  onSubmit: (answers: Record<string, string>) => void;
}

function optionSummary(question: Question): string | undefined {
  const lines = question.options
    .filter((option) => option.description)
    .map((option) => `${option.label} — ${option.description}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * One screen for the whole request: every question the agent asked is a field,
 * so a single submit answers the batch. The daemon's own prompt pairs each
 * question with a `header`, which makes a better field label than the prompt
 * itself — the prompt is already the section title.
 */
export default function AnswerQuestions({ questions, onSubmit }: AnswerQuestionsProps) {
  const { pop } = useNavigation();

  // Single-select starts on the first option — the same default the daemon's own
  // UI shows — while multi-select starts empty, which reads as "none of these".
  const [picks, setPicks] = useState<(string | string[])[]>(() =>
    questions.map((question) => (question.multiSelect ? [] : (question.options[0]?.label ?? OTHER))),
  );
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ""));

  const replaceAt = <T,>(list: T[], index: number, value: T): T[] => list.map((entry, i) => (i === index ? value : entry));

  function collect(): QuestionPicks {
    const chosen: QuestionPicks = {};

    questions.forEach((question, index) => {
      // Free text wins over the picker: it is the more specific answer.
      const freeText = typed[index].trim();
      if (freeText) {
        chosen[index] = [freeText];
        return;
      }

      const pick = picks[index];
      if (Array.isArray(pick)) {
        chosen[index] = pick;
      } else if (pick !== OTHER) {
        chosen[index] = [pick];
      }
    });

    return chosen;
  }

  function submit() {
    const answers = buildAnswers(questions, collect());
    // An empty map is what the tool reports as "the user did not answer the
    // questions", so refuse to send one rather than fail silently.
    if (Object.keys(answers).length === 0) {
      void showToast({ style: Toast.Style.Failure, title: "Pick an answer first" });
      return;
    }

    onSubmit(answers);
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send Answers" onSubmit={submit} shortcut={{ modifiers: ["cmd"], key: "enter" }} />
        </ActionPanel>
      }
    >
      {questions.map((question, index) => {
        const fieldTitle = question.header ?? "Answer";
        const summary = optionSummary(question);
        const wantsFreeText = question.allowOther && (question.multiSelect || picks[index] === OTHER);

        return (
          <Fragment key={question.prompt}>
            {/* The prompt is a sentence, so it gets a full-width line of its own
                rather than the cramped title column of the control below. */}
            <Form.Description text={question.prompt} />
            {question.multiSelect ? (
              <Form.TagPicker
                id={`pick-${index}`}
                title={fieldTitle}
                value={picks[index] as string[]}
                onChange={(value) => setPicks((previous) => replaceAt(previous, index, value))}
              >
                {question.options.map((option) => (
                  <Form.TagPicker.Item key={option.label} value={option.label} title={option.label} />
                ))}
              </Form.TagPicker>
            ) : (
              <Form.Dropdown
                id={`pick-${index}`}
                title={fieldTitle}
                value={picks[index] as string}
                onChange={(value) => setPicks((previous) => replaceAt(previous, index, value))}
              >
                {question.options.map((option) => (
                  <Form.Dropdown.Item key={option.label} value={option.label} title={option.label} />
                ))}
                {question.allowOther ? <Form.Dropdown.Item value={OTHER} title="Other…" icon={Icon.Pencil} /> : null}
              </Form.Dropdown>
            )}

            {summary ? <Form.Description text={summary} /> : null}

            {wantsFreeText ? (
              <Form.TextField
                id={`typed-${index}`}
                title="Other"
                placeholder="Or type your own answer"
                value={typed[index]}
                onChange={(value) => setTyped((previous) => replaceAt(previous, index, value))}
              />
            ) : null}
            {index < questions.length - 1 ? <Form.Separator /> : null}
          </Fragment>
        );
      })}
    </Form>
  );
}
