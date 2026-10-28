import { requireToken, resolveOrigin, peekStoredCreds } from "../credentials.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_ACTION, EXIT_OK, usageError, type ActionQuestion } from "../exit.js";
import { httpRequest, requireOk } from "../http.js";
import { writeJson } from "../output.js";
import type { ParsedArgs } from "../types.js";

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Yes runs `--consent` with the exact question; no stops. */
function emailQuestion(scanId: string, prompt: string): ActionQuestion {
  return {
    id: "scan_email",
    header: "Email",
    question: prompt,
    options: [
      {
        value: "granted",
        label: "Yes",
        description: "Email the report",
        run: `cleanslop email ${scanId} --consent ${shellQuote(prompt)} --reply yes`,
      },
      { value: "declined", label: "No", description: "Do not email it" },
    ],
  };
}

function resolveScanId(
  deps: CliDeps,
  origin: string,
  id: string | null
): string {
  if (id) return id;
  const stored = peekStoredCreds(deps, origin);
  if (stored?.lastScanId) return stored.lastScanId;
  throw usageError("Pass a scan id or run a scan first.");
}

export async function runEmail(
  deps: CliDeps,
  args: ParsedArgs
): Promise<number> {
  const origin = resolveOrigin(deps);
  const creds = requireToken(deps, origin);
  const scanId = resolveScanId(deps, origin, args.id);

  if (!args.consent) {
    const preview = await httpRequest(
      deps,
      origin,
      "GET",
      `/api/agent/v1/scans/${encodeURIComponent(scanId)}/email`,
      { token: creds.token }
    );
    requireOk(preview);
    const body = (preview.json ?? {}) as {
      eligible?: boolean;
      reason?: string;
      recipientMasked?: string | null;
      prompt?: string | null;
    };
    if (args.json) {
      writeJson(deps, body);
      return EXIT_OK;
    }
    const prompt = body.prompt ?? "Ask the human the exact masked-recipient question.";
    deps.io.stdout(`${prompt}\n`);
    throw new CliError(
      "Ask the human the exact question above. If they agree, rerun with --consent quoting it.",
      EXIT_ACTION,
      {
        kind: "ask_human",
        humanPrompt: prompt,
        // The server's question names a recipient; the fallback is not a question.
        ...(body.prompt ? { question: emailQuestion(scanId, body.prompt) } : {}),
      }
    );
  }

  const result = await httpRequest(
    deps,
    origin,
    "POST",
    `/api/agent/v1/scans/${encodeURIComponent(scanId)}/email`,
    {
      token: creds.token,
      body: {
        decision: "granted",
        promptText: args.consent,
        ...(args.reply ? { humanReply: args.reply } : {}),
      },
    }
  );
  requireOk(result);
  if (args.json) {
    writeJson(deps, result.json);
    return EXIT_OK;
  }
  const body = (result.json ?? {}) as {
    emailDoneAlert?: boolean;
    recipientMasked?: string;
    sends?: string;
  };
  const masked = body.recipientMasked ?? "the verified address";
  const when = body.sends === "now" ? "now" : "when the scan finishes";
  deps.io.stdout(`Email consent recorded for ${masked}. CleanSlop will send ${when}.\n`);
  return EXIT_OK;
}
