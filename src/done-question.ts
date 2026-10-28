import type { ActionQuestion, ActionQuestionOption } from "./exit.js";

/** The next step after a `--no-wait` approval when only the agent knows its exact command. */
export const RESUME_SAME_COMMAND =
  "run the same cleanslop command again, with --resume in place of --no-wait";
export const RERUN_SAME_COMMAND = "run the same cleanslop command again";

const NOT_NOW: ActionQuestionOption = {
  value: "stop",
  label: "Not now",
  description: "Stop here",
};

/**
 * "Tell me when you're done" as a question, so agents ask with their question
 * tool instead of improvising "reply done". The question repeats any link and
 * code, because a question tool may show only the question.
 */
export function doneQuestion(opts: {
  id: string;
  header: string;
  question: string;
  then: { run: string } | { next: string };
  notNow?: string;
}): ActionQuestion {
  return {
    id: opts.id,
    header: opts.header,
    question: opts.question,
    options: [
      { value: "done", label: "Done", ...opts.then },
      opts.notNow ? { ...NOT_NOW, description: opts.notNow } : NOT_NOW,
    ],
  };
}
