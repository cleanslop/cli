import type { CliDeps } from "./deps.js";
import { CliError, EXIT_ACTION, type ActionQuestion, type NotConnectedError } from "./exit.js";
import { parseGithubRemote } from "./git.js";
import { asRecord, httpRequest } from "./http.js";

export const LINK_LOGIN_COMMAND = "cleanslop login --link --no-wait";
export const GITHUB_LOGIN_COMMAND = "cleanslop login --no-wait";

const LINK_DESCRIPTION =
  "No GitHub needed; scans this folder's files. Needs a Link account; US and Canada only.";

/**
 * The server lists both methods only while `AGENT_CONNECT_CHOICE=ask` and Link
 * sign-up is public. `githubUploads`: a GitHub sign-in can also upload local files.
 */
async function offeredMethods(
  deps: CliDeps,
  origin: string
): Promise<{ both: boolean; githubUploads: boolean }> {
  try {
    const result = await httpRequest(deps, origin, "GET", "/api/agent/v1/connect");
    if (result.status !== 200) return { both: false, githubUploads: false };
    const methods = asRecord(result.json)?.methods;
    const list = Array.isArray(methods) ? methods.map((m) => asRecord(m)) : [];
    const github = list.find((m) => m?.kind === "github");
    return {
      both: Boolean(github) && list.some((m) => m?.kind === "stripe_link"),
      githubUploads: github?.uploads === true,
    };
  } catch {
    return { both: false, githubUploads: false };
  }
}

async function onGithub(deps: CliDeps): Promise<boolean> {
  const remote = await deps.git(["remote", "get-url", "origin"], deps.env.cwd());
  return remote.ok && parseGithubRemote(remote.stdout.trim()) !== null;
}

/** About the account, not this scan's source: the scan asks before a GitHub sign-in uploads. */
function githubDescription(onGithub: boolean, uploads: boolean): string {
  if (uploads) return "Scans what you've pushed to GitHub; can also scan this folder's files when you choose.";
  return onGithub
    ? "Scans what you've pushed to GitHub."
    : "Scans what you've pushed to GitHub. This folder isn't on GitHub yet, so you'd push it first.";
}

/**
 * GitHub is recommended (and listed first) when this folder's origin is on
 * GitHub, where the person most likely already has a GitHub account;
 * otherwise Link is.
 */
export function connectQuestion(github: boolean, githubUploads = false): ActionQuestion {
  const link = {
    value: "stripe_link",
    label: github ? "Stripe Link" : "Stripe Link (Recommended)",
    description: LINK_DESCRIPTION,
    run: LINK_LOGIN_COMMAND,
  };
  const githubOption = {
    value: "github",
    label: github ? "GitHub (Recommended)" : "GitHub",
    description: githubDescription(github, githubUploads),
    run: GITHUB_LOGIN_COMMAND,
  };
  return {
    id: "connect_method",
    header: "Connect",
    question: "How should CleanSlop connect?",
    options: github ? [githubOption, link] : [link, githubOption],
  };
}

/**
 * Not connected: ask Link or GitHub (see `connectQuestion` for which is
 * recommended) when the server offers both; otherwise, or if the server
 * cannot say, keep the plain login block.
 */
export async function withConnectChoice(
  deps: CliDeps,
  err: NotConnectedError
): Promise<CliError> {
  const offered = await offeredMethods(deps, err.origin);
  if (!offered.both) return err;
  const github = await onGithub(deps);
  const link = `Stripe Link (${github ? "" : "recommended; "}${LINK_DESCRIPTION}) runs \`${LINK_LOGIN_COMMAND}\``;
  const githubLine = `GitHub (${github ? "recommended; " : ""}${githubDescription(github, offered.githubUploads)}) runs \`${GITHUB_LOGIN_COMMAND}\``;
  return new CliError(err.message, EXIT_ACTION, {
    kind: "ask_human",
    humanPrompt: `This machine isn't connected to CleanSlop yet. Ask the human how to connect: ${github ? `${githubLine}; ${link}` : `${link}; ${githubLine}`}. If they already said which, use that without asking.`,
    question: connectQuestion(github, offered.githubUploads),
  });
}

/**
 * A link-cli failure during `login --link` (no action of its own) offers
 * GitHub, since Link may simply be unavailable to this person.
 */
export function offerGithubAfterLinkFailure(err: unknown): never {
  if (!(err instanceof CliError) || err.action) throw err;
  throw new CliError(err.message, err.exitCode, {
    kind: "ask_human",
    humanPrompt: `Link sign-in failed (the error is below). If Link isn't available to the human (Link sign-up is US and Canada only), connect with GitHub instead: run \`${GITHUB_LOGIN_COMMAND}\`.`,
    question: {
      id: "link_failed",
      header: "Connect",
      question: "Link sign-in failed. Connect with GitHub instead?",
      options: [
        {
          value: "github",
          label: "Use GitHub",
          description: "Sign in with GitHub instead",
          run: GITHUB_LOGIN_COMMAND,
        },
        { value: "retry", label: "Try Link again", run: LINK_LOGIN_COMMAND },
      ],
    },
  });
}
