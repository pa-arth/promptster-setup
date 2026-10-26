// Every literal the installer writes into a user's machine lives here, so the
// blast radius of the whole package is one file you can read in thirty seconds.

/**
 * OTLP base endpoint. Claude Code's exporter appends the signal path itself
 * (`/v1/logs`, `/v1/metrics`), so this is a BASE, not a full URL.
 *
 * IT MUST MATCH WHERE THE RECEIVER IS ACTUALLY MOUNTED, and the failure when it
 * doesn't is invisible: the exporter POSTs into a 404 and drops the batch, so an
 * enrolled machine looks enrolled, reports no error to its user, and emits
 * nothing forever. `apps/api/src/routes/team/teams-otel.ts` warns about exactly
 * this — "getting this wrong means a silent 404 loop inside the exporter" —
 * beside the paths it serves.
 *
 * This read `https://api.promptster.ai/otel` until 2026-07-29, which was never a
 * route. Probed against prod: `POST /otel/v1/logs` → 404, `POST
 * /v1/teams/otel/v1/logs` → 401. The package had not been published yet, so no
 * machine was ever enrolled against the wrong base — but it was one `npm
 * publish` away from silently breaking every enrollment. `constants.test.ts`
 * now pins this against the receiver's own exported path.
 */
export const DEFAULT_OTLP_ENDPOINT = 'https://api.promptster.ai/v1/teams/otel';

/** Hosts we consider "ours" when deciding whether an existing endpoint is a foreign collector. */
export const OUR_ENDPOINT_HOSTS = ['promptster.ai'] as const;

/**
 * Tier A — telemetry env. Values are fixed except the endpoint and the bearer token.
 * What else is exported is the CUSTOMER's call — see CHOICE_ENV_KEYS.
 *
 * Never written, under any flag, and asserted absent by the tests:
 *   OTEL_LOG_RAW_API_BODIES — the whole API request/response, file bodies included.
 */
export const STATIC_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  // http/protobuf — the OTel default, and as of 2026-07-27 what we write.
  //
  // This was 'http/json' for exactly one reason: the receiver had no protobuf
  // decoder, so our own installer would have configured a wire format our own
  // endpoint answered 415 on. That is now closed
  // (`apps/api/src/lib/otlpProtobuf.ts`), and the flip is not a preference — it
  // becomes REQUIRED the moment enrollment stops being a path we author. Admin
  // managed-settings push is admin-written, and a customer's existing OTel
  // collector fans out in protobuf because that is the spec default.
  //
  // MEASURED, not assumed, before flipping (`__fixtures__/otlp-protobuf/`):
  //   - a live `claude -p` session on 2.1.220 exported 10 real protobuf batches
  //     which the receiver decodes to 44 log records and 25 datapoints;
  //   - `Content-Encoding` was ABSENT on all 10 — Claude Code does not compress.
  //     That mattered because there is no gzip handling anywhere in this repo, so
  //     a compressed body would reach the decoder as gzip bytes. It is not a
  //     promise about future versions; the durable guard is that such a body
  //     fails LOUDLY as `otlp_protobuf_malformed` rather than being stored empty.
  //
  // DEPLOY ORDER: the receiver ships before this value reaches an engineer's
  // machine. Same stack, but an installer running against an older API would get
  // 415 on every batch.
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
});

/**
 * What the customer chooses to export. The point of the OTel rail is that the
 * customer — not us — decides what leaves their machines, so each signal is a
 * switch on the installer and nothing more:
 *   toolDetails — tool names' arguments (commands, paths). ON by default: most
 *                 of the dashboard (commands, edits, reads, commit linking) is
 *                 derived from it. `--no-tool-details` turns it off.
 *   prompts     — what the engineer typed. OFF unless `--prompts`.
 *   responses   — what Claude answered. OFF unless `--responses`.
 * The receiver scrubs secrets from command lines and prompt/response text on
 * arrival (the CLI does the same on the device).
 */
export interface CaptureChoices {
  toolDetails: boolean;
  prompts: boolean;
  responses: boolean;
}
export const DEFAULT_CHOICES: Readonly<CaptureChoices> = Object.freeze({
  toolDetails: true,
  prompts: false,
  responses: false,
});
export const CHOICE_ENV_KEYS: Readonly<Record<keyof CaptureChoices, string>> = Object.freeze({
  toolDetails: 'OTEL_LOG_TOOL_DETAILS',
  prompts: 'OTEL_LOG_USER_PROMPTS',
  responses: 'OTEL_LOG_ASSISTANT_RESPONSES',
});

export const ENDPOINT_ENV_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const HEADERS_ENV_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';

/** Keys we never write, whatever the customer chooses. */
export const FORBIDDEN_ENV_KEYS = ['OTEL_LOG_RAW_API_BODIES'] as const;

/**
 * Tier B — one command hook per lifecycle event.
 *
 * Only the tool events take a matcher; the session/turn events are unmatched in
 * Claude Code's schema, and writing `matcher: "*"` on them is noise at best.
 */
export const TIER_B_EVENTS = [
  { event: 'SessionStart', matcher: null },
  { event: 'UserPromptSubmit', matcher: null },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'Stop', matcher: null },
  { event: 'SubagentStop', matcher: null },
  { event: 'PreCompact', matcher: null },
  { event: 'SessionEnd', matcher: null },
] as const;

/** Our on-disk home for the spool script + install state. Never inside ~/.claude. */
export const PROMPTSTER_DIR_NAME = '.promptster';
export const SPOOL_SCRIPT_NAME = 'spool.mjs';
export const STATE_FILE_NAME = 'setup-state.json';

/**
 * Hook commands are written with a literal `$HOME` rather than an absolute path:
 * Claude Code runs hook commands through a shell, so it expands at run time, and
 * it keeps settings.json portable (and the --print golden machine-independent).
 */
export const SPOOL_COMMAND_BASE = `node "$HOME/${PROMPTSTER_DIR_NAME}/${SPOOL_SCRIPT_NAME}"`;

/** Substring that identifies a hook entry as ours. Never matches a user's own hook. */
export const HOOK_MARKER = `${PROMPTSTER_DIR_NAME}/${SPOOL_SCRIPT_NAME}`;

/**
 * Claude Code's `otelHeadersHelper` settings key: a shell command run in the
 * SESSION'S working directory whose stdout JSON object is merged as extra
 * headers onto every OTLP export (alongside OTEL_EXPORTER_OTLP_HEADERS, so the
 * auth header still rides). It is how the receiver learns which repo a session
 * ran in — the OTel payload itself carries no cwd and no remote.
 *
 * Verified live on Claude Code 2.1.310: the command runs through a shell
 * (`$HOME` expands), in the session cwd, and the auth header survives the merge.
 *
 * Written for BOTH tiers: tier A is the OTel tier, so it needs the repo too.
 */
export const OTEL_HEADERS_HELPER_KEY = 'otelHeadersHelper';
export const OTEL_HEADERS_SCRIPT_NAME = 'otel-headers.mjs';
export const OTEL_HEADERS_HELPER_COMMAND = `node "$HOME/${PROMPTSTER_DIR_NAME}/${OTEL_HEADERS_SCRIPT_NAME}"`;

/**
 * Header names the receiver reads (`readRepoHeaders` in
 * apps/api/src/routes/team/teams-otel.ts).
 *   repo:    `git remote get-url origin` verbatim, credentials stripped; '' if none.
 *   workdir: cwd relative to home (`~`, `~/repos/foo`); '' outside home. NEVER an
 *            absolute path — that carries the OS username.
 */
export const REPO_HEADER = 'X-Promptster-Repo';
export const WORKDIR_HEADER = 'X-Promptster-Workdir';
/**
 * The engineer's Claude plan, read from the non-secret `oauthAccount` fields of
 * ~/.claude.json — the same fields, and the same patterns, as the CLI's
 * `planTier` capture (teams-cli internal/capture/plan_tier.go). `;`-separated
 * `k=v` pairs: p plan, r rate-limit tier, s seat tier, b billing type, o overage
 * (1/0), t profile fetched at (epoch s). Or `absent` (no file, or an API-key
 * login) / `unreadable`. Every value is pattern-clamped on the device, so an
 * email or name cannot ride a tier field out. ~/.claude/.credentials.json is
 * never opened.
 */
export const PLAN_HEADER = 'X-Promptster-Plan';

export function spoolCommandFor(event: string): string {
  return `${SPOOL_COMMAND_BASE} --event ${event}`;
}

export const EXIT = {
  OK: 0,
  USAGE: 1,
  ENV_CONFLICT: 2,
  HOOKS_DISABLED: 3,
  FOREIGN_ENDPOINT: 4,
  BAD_SETTINGS: 5,
} as const;
