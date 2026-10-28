export const EXIT_OK = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ACTION = 10;
export const EXIT_PAYMENT = 11;
export const EXIT_POLICY = 12;
export const EXIT_SOURCE = 13;
export const EXIT_SCAN_FAILED = 20;
export const EXIT_RUNNING = 75;

export type ActionKind =
  | "approve"
  | "install"
  | "top-up"
  | "beta"
  | "reauth"
  | "present_identity"
  | "link_existing"
  | "ask_human"
  | "ask_email"
  | "wait";

/**
 * One answer to a structured question. `run` is the exact next command;
 * `next` is a plain instruction (consent answers never carry `--agree`);
 * neither means stop.
 */
export type ActionQuestionOption = {
  value: string;
  label: string;
  description?: string;
  run?: string;
  next?: string;
};

/**
 * A multiple-choice question for the human. Agents with a question tool
 * (e.g. Claude Code AskUserQuestion: 2–4 options, header ≤12 chars) ask with
 * it; others ask in plain text. The agent never answers it itself.
 */
export type ActionQuestion = {
  id: string;
  header: string;
  question: string;
  options: ActionQuestionOption[];
};

export type ActionRequired = {
  kind: ActionKind;
  humanPrompt: string;
  url?: string;
  code?: string;
  question?: ActionQuestion;
};

export class CliError extends Error {
  readonly exitCode: number;
  readonly action: ActionRequired | undefined;

  constructor(
    message: string,
    exitCode: number,
    action?: ActionRequired
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.action = action;
  }
}

/** No credentials for `origin`; `runCli` may turn this into a connect question. */
export class NotConnectedError extends CliError {
  readonly origin: string;

  constructor(origin: string) {
    super("Not connected. Run `cleanslop login`.", EXIT_ACTION, {
      kind: "approve",
      humanPrompt: "Run `cleanslop login` and ask the human to approve the device code.",
    });
    this.name = "NotConnectedError";
    this.origin = origin;
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, EXIT_USAGE);
}

export function sourceError(message: string, action?: ActionRequired): CliError {
  return new CliError(message, EXIT_SOURCE, action);
}

export function actionError(message: string, action: ActionRequired): CliError {
  return new CliError(message, EXIT_ACTION, action);
}
