export type CommandName =
  | "scan"
  | "login"
  | "logout"
  | "whoami"
  | "status"
  | "report"
  | "setup"
  | "email"
  | "link-identity"
  | "credits"
  | "redeem"
  | "billing"
  | "plan"
  | "feedback";

export type ReportFormat = "md" | "json";

export type ParsedArgs = {
  command: CommandName;
  help: boolean;
  version: boolean;
  id: string | null;
  json: boolean;
  wait: boolean;
  waitMs: number;
  noWait: boolean;
  noPromo: boolean;
  resume: boolean;
  force: boolean;
  /** scan: rescan everything instead of building on the last scan. */
  full: boolean;
  upload: boolean;
  preview: boolean;
  format: ReportFormat;
  dryRun: boolean;
  uninstall: boolean;
  all: boolean;
  project: boolean;
  yes: boolean;
  consent: string | null;
  reply: string | null;
  link: boolean;
  agree: boolean;
  acceptTerms: boolean;
  yesShareEmail: boolean;
  /** scan: the price the human approved after credits_confirmation_required. */
  confirmCredits: number | null;
  pack: string | null;
  amount: number | null;
  networkId: string | null;
  spendRequestId: string | null;
  /** feedback: bug | confusing | false_positive | idea | other */
  feedbackKind: string | null;
  scanId: string | null;
  findingId: string | null;
  newTicket: boolean;
  replies: boolean;
};

export type AgentScan = {
  id: string;
  status: string;
  final: boolean;
  source?: string;
  project?: { id: string; name: string };
  commitSha?: string | null;
  upload?: {
    gitCommit: string | null;
    localChanges: boolean;
    notScanned: {
      total: number;
      byReason: Record<string, number>;
      files: Array<{ path: string; reason: string }>;
    } | null;
  } | null;
  findingCount?: number;
  /** Builds on `parentScanId` and is priced on what changed since it. */
  incremental?: boolean;
  parentScanId?: string | null;
  elapsedSec?: number;
  eta?: { minSec: number; maxSec: number } | null;
  progress?: {
    phase: string;
    label: string;
    percent?: number;
    step?: number;
    steps?: number;
  } | null;
  error?: { code: string; message: string } | null;
  pollAfterSec?: number;
  next?: { action: string; afterSec: number; message: string };
  links?: { report_md?: string; report_json?: string; web?: string };
};

export type AgentErrorBody = {
  error?: string;
  message?: string;
  error_description?: string;
  action?: {
    kind?: string;
    url?: string;
    retryAfterSec?: number;
    humanPrompt?: string;
  };
  [key: string]: unknown;
};

export type MeResponse = {
  user?: {
    githubLogin?: string | null;
    emailMasked?: string | null;
    emailVerified?: boolean;
  };
  grant?: { id?: string; label?: string; scopes?: string };
  quota?: {
    plan?: string;
    planName?: string;
    scanLimit?: number;
    remaining?: number;
    monthlyLeft?: number;
    credits?: number;
  };
  /** Server 2026-11+ (scan credits): balances in credits; `quota` stays in scans. */
  creditBalance?: {
    remaining?: number;
    monthlyLeft?: number;
    purchased?: number;
    monthlyAllowance?: number;
    /** Every scan's price while it is flat; omitted with size-based prices. */
    scanCost?: number;
    /** Server 2026-11+: what a scan can cost (1 to 20 with size-based prices). */
    scanCostMin?: number;
    scanCostMax?: number;
  };
  links?: { account?: string; topUp?: string };
  uploads?: boolean;
  /** GitHub grant: may upload the local files when the pushed commit can't be scanned. */
  uploadFallback?: boolean;
  link?: { verified?: boolean; emailMasked?: string | null };
  /** Link account with web billing on: where the human manages the plan. */
  webBilling?: { url?: string; emailMasked?: string } | null;
  /** Link grant that can start a monthly plan with `cleanslop plan`. */
  linkPlans?: boolean;
};

export type DeviceStartResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type DeviceTokenResponse = {
  access_token: string;
  token_type?: string;
  scope?: string;
  grant_id?: string;
  account?: {
    github_login?: string | null;
    email_masked?: string | null;
  };
};

export type StartScanResponse = {
  scan: AgentScan;
  created?: boolean;
  deduped?: boolean;
  charged?: string | null;
  /** Credits held for this scan; servers before size-based pricing omit it. */
  credits?: { reserved?: number };
  /** Why a new scan runs full; null when incremental. Older servers omit it. */
  fullScanReason?: string | null;
};

export type GitSnapshot = {
  toplevel: string;
  remote: string;
  commitSha: string;
  branch: string;
  dirty: boolean;
  unpushed: boolean;
  github: { owner: string; repo: string; fullName: string } | null;
};
