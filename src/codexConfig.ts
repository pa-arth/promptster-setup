// Codex enrollment — the SECOND per-machine write (§8.2).
//
// Claude Code can be enrolled by an admin: server-managed settings push an `env`
// block and hooks to a whole fleet. Codex cannot. It reads `~/.codex/config.toml`
// and there is no documented mechanism to distribute that file, so every machine
// gets written individually and an admin cannot enroll a fleet at all. That
// asymmetry is a property of the product we are integrating, not a gap in this
// installer, and it belongs on the install page rather than in a footnote.
//
// EVERY KEY AND VALUE SHAPE HERE IS TAKEN FROM THE BINARY, NOT FROM DOCS.
// `OtelConfigToml` (log_user_prompt | environment | exporter | trace_exporter |
// metrics_exporter | span_attributes | tracestate), `OtelExporterKind`
// (statsig | otlp-http | otlp-grpc), `OtelHttpProtocol` (binary | json) were read
// out of codex 0.145.0's own serde type names, and the emitted TOML matches a
// config that was verified to actually export during the §1.9 capture.

import { codexConfigPath } from './paths.js';

/** Marker comment so our block is recognisable — and removable — on a re-run. */
export const CODEX_BLOCK_BEGIN = '# >>> promptster (managed) >>>';
export const CODEX_BLOCK_END = '# <<< promptster (managed) <<<';

export interface CodexPlanOptions {
  endpoint: string;
  token: string;
  /** The customer chose to export prompt text (`--prompts`). Default false. */
  prompts?: boolean;
}

/**
 * The `[otel]` block we write.
 *
 * LOG-ONLY, deliberately (§8.1b). The metric channel is not configured because it
 * is useless to us and unattributable: across the whole captured corpus, 0 of 161
 * metric datapoints carried `user.email`, `user.account_id` or `conversation.id`,
 * while 37 of 40 log records carried all three. The log channel also already
 * carries per-request token counts on `codex.sse_event` that reconcile EXACTLY to
 * the metric aggregate, so a metric path would add a second, unattributable copy
 * of a number we already have.
 *
 * `protocol = "json"` is retained because it is verified against a real Codex
 * export and the receiver accepts it. The receiver now also accepts protobuf,
 * but changing a working wire format is unnecessary; `binary` is the other
 * legal Codex value.
 *
 * MEASURED 2026-07-27 (§8.2b), replacing what used to be a stated assumption.
 * A live `codex exec` under an isolated CODEX_HOME with `metrics_exporter`
 * DELIBERATELY ABSENT, against a recording collector, produced 9 export batches
 * — all `resourceLogs`, ZERO metric datapoints. The §1.9 run with the key set
 * produced 296. So omitting the key does what this block assumes.
 *
 * What that did NOT establish, and the reason the copy rule below is stronger
 * than "hedge": the binary hard-codes `https://ab.chatgpt.com/otlp/v1/metrics`
 * beside a statsig client key. There is an OpenAI-owned metrics channel our
 * config does not address and cannot see. (Connection-level attribution was
 * attempted and is INCONCLUSIVE: everything resolved to 104.18.32.47, which
 * `dig` shows is shared by `ab.chatgpt.com` and `chatgpt.com` behind Cloudflare
 * anycast, so an outbound connection cannot be assigned to either.)
 *
 * COPY RULE. Say "we do not collect Codex metrics" — a fact about US, now
 * measured. NEVER say "Codex metrics are off", and never imply we could turn
 * them off: there is a channel we do not control and cannot see. A test in
 * `__tests__/codexConfig.test.ts` pins both negatives.
 */
export function renderCodexOtelBlock(opts: CodexPlanOptions): string {
  const exporter =
    `{ otlp-http = { endpoint = ${toml(opts.endpoint)}, ` +
    `protocol = "json", headers = { Authorization = ${toml(`Bearer ${opts.token}`)} } } }`;
  return [
    CODEX_BLOCK_BEGIN,
    '[otel]',
    ...(opts.prompts
      ? ['# Prompt TEXT is exported (--prompts). The receiver scrubs secrets on arrival.']
      : [
          '# Prompt TEXT is not exported. Verified on the wire, not assumed: with this',
          "# false, codex.user_prompt ships prompt='[REDACTED]' and keeps prompt_length.",
        ]),
    `log_user_prompt = ${opts.prompts ? 'true' : 'false'}`,
    'environment = "promptster"',
    `exporter = ${exporter}`,
    '# metrics_exporter is deliberately ABSENT — see renderCodexOtelBlock.',
    CODEX_BLOCK_END,
    '',
  ].join('\n');
}

/** Minimal TOML basic-string quoting. Enough for URLs and bearer tokens. */
function toml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface CodexPlan {
  path: string;
  /** The full file content we would write, or null when nothing needs to change. */
  next: string | null;
  previous: string | null;
  /** True when a promptster block was already present and is being replaced. */
  replacingOurBlock: boolean;
  /**
   * A pre-existing `[otel]` section that is NOT ours. We refuse rather than merge:
   * Codex takes ONE exporter, so writing ours would silently redirect telemetry
   * the user or their employer already configured — the same class of failure the
   * Claude Code path refuses for a foreign OTLP endpoint.
   */
  foreignOtel: boolean;
}

const OUR_BLOCK_RE = new RegExp(
  `(?:\\n)?${escapeRe(CODEX_BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(CODEX_BLOCK_END)}\\n?`,
  'g',
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plan the Codex write against existing content.
 *
 * `existing` is the current file text, or null when there is no file. Append-only
 * with respect to everything that is not ours: a user's `model`, `approvals_*`,
 * `[projects.*]` trust entries and any other section survive untouched, exactly
 * like the Claude Code settings.json path.
 */
export function planCodex(existing: string | null, opts: CodexPlanOptions): CodexPlan {
  const path = codexConfigPath();
  const block = renderCodexOtelBlock(opts);
  const hadOurs = existing !== null && existing.includes(CODEX_BLOCK_BEGIN);

  // Strip our previous block before looking for a foreign [otel], or our own
  // block would read as somebody else's on the second run.
  const withoutOurs = existing === null ? '' : existing.replace(OUR_BLOCK_RE, '');
  const foreignOtel = /^\s*\[otel(\.|\])/m.test(withoutOurs);

  if (foreignOtel) {
    return { path, next: null, previous: existing, replacingOurBlock: hadOurs, foreignOtel: true };
  }

  const base = withoutOurs.replace(/\n{3,}$/, '\n\n');
  const joiner = base === '' || base.endsWith('\n') ? '' : '\n';
  const next = `${base}${joiner}${base.trim() === '' ? '' : '\n'}${block}`;

  return {
    path,
    next: next === existing ? null : next,
    previous: existing,
    replacingOurBlock: hadOurs,
    foreignOtel: false,
  };
}

/** Remove our block, leaving everything else byte-identical. Null when nothing to do. */
export function uninstallCodex(existing: string | null): string | null {
  if (existing === null || !existing.includes(CODEX_BLOCK_BEGIN)) return null;
  return existing.replace(OUR_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * The Codex-specific disclosure line.
 *
 * This is NOT a footnote on the Claude Code copy, because Codex's egress is
 * genuinely larger: `codex.tool_result` carries `arguments` and `output`
 * VERBATIM AND UNTRUNCATED — full command lines with absolute paths, complete
 * apply_patch diff bodies (both sides of the source), and full command stdout —
 * and `log_user_prompt` does not gate any of it. Telling a Codex user "prompts
 * aren't sent" would be true and beside the point; the patch bodies are the story.
 */
export const CODEX_DISCLOSURE_LINES = [
  'Codex sends MORE than Claude Code does, and its prompt switch does not cover it:',
  '  - codex.tool_result carries command arguments and output verbatim, including',
  '    full apply_patch diff bodies (your source, both sides) and command stdout.',
  '  - log_user_prompt (false unless --prompts) covers prompt TEXT; it does not gate the above.',
  '  - That content transits our endpoint and is DROPPED at the boundary, exactly',
  '    like Claude Code tool content — it is never written to storage.',
  '  - We do not collect Codex metrics (we configure the log exporter only).',
  '  - No admin can enroll Codex for a fleet: it reads ~/.codex/config.toml and',
  '    has no server-managed settings equivalent, so this is written per machine.',
] as const;
