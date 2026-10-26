# @promptster/setup

The installer that enrolls an engineer's Claude Code or Codex in
[Promptster](https://promptster.ai). It only edits config: Claude Code's own
OpenTelemetry export does the sending. This repo is public so you can read
exactly what gets written to a machine and what leaves it before you run it.

One command, no binary, no daemon, no login:

```bash
# Claude Code
npx @promptster/setup --token <your-token>

# Codex
npx @promptster/setup --codex --token <your-token>
```

The default Claude Code path edits `~/.claude/settings.json` and writes
`~/.promptster/spool.mjs` and `~/.promptster/otel-headers.mjs`. The `--codex` path edits only
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

```
--codex       target Codex instead of Claude Code
--print       dry run: print the plan, write nothing
--tier a      Claude Code telemetry only, no hooks
--uninstall   undo the selected target's install

--prompts          also export prompt text (off by default)
--responses        Claude Code only: also export Claude's responses (off by default)
--no-tool-details  Claude Code only: don't export tool arguments (on by default)
```

Every run prints what leaves the machine and what does not before it writes
anything. `npx @promptster/setup --token x --print` shows it without writing.

## What it writes

**Tier A — telemetry.** `CLAUDE_CODE_ENABLE_TELEMETRY`, the OTLP exporter/protocol/
endpoint/headers pair, and `OTEL_LOG_TOOL_DETAILS=1`. Plus `otelHeadersHelper`,
pointing at `~/.promptster/otel-headers.mjs`: Claude Code runs it in the session's
working directory and adds its output to every OTLP export as two headers —
`X-Promptster-Repo` (the `origin` remote, credentials stripped) and
`X-Promptster-Workdir` (the cwd relative to `~`, or empty outside home; never an
absolute path) — and `X-Promptster-Plan`, the plan fields from `~/.claude.json`
`oauthAccount` (plan type, rate-limit tier, seat tier, billing type, extra usage;
never email, name or account id, and `~/.claude/.credentials.json` is never read). An existing `otelHeadersHelper` that is not ours stops the run
(exit 2), like an env conflict.

**Tier B — hooks.** One command hook per lifecycle event (`SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`,
`PreCompact`, `SessionEnd`) pointing at the spool script.

`OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_ASSISTANT_RESPONSES` are written only when
you pass `--prompts` / `--responses`, so prompt and response text is off by default. `OTEL_LOG_RAW_API_BODIES` is never written
under any flag — there is no option that turns it on.

**Codex — log telemetry only.** The installer appends a marked `[otel]` block,
sets `log_user_prompt=false` (true with `--prompts`), and configures Promptster's authenticated log
exporter. It deliberately does not configure a metrics exporter. Codex tool
results can still contain command arguments, output, and full patch bodies;
Promptster drops that content at the ingestion boundary and never stores it.

Do not install both capture paths for the same Codex activity: `--codex` is the
OTel path and should not be combined with a separate rollout-log watcher.

## The guards, and why each exists

| Guard                       | Behaviour                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diff first                  | The plan is printed before any write, on every path. `--print` is that render with the write removed.                                                                                                                                                |
| Append, never replace       | Our hook group is pushed onto the end of an existing event array. An existing `statusLine` is not touched at all. Silently deleting someone's audit hook is unrecoverable and invisible; nothing here can do it.                                     |
| Idempotent                  | A second and third consecutive run produce an empty diff and write zero bytes.                                                                                                                                                                       |
| No clobbering env           | An env key set to a value this installer did not write stops the run (exit 2). Ownership is value-matched, so a key you edited after enrolling is yours again.                                                                                       |
| `disableAllHooks` preflight | Checked across managed policy, user, and project settings. If hooks are off machine-wide we do **not** write dead hook entries; we say tier B will not run and exit 3.                                                                               |
| Foreign OTLP endpoint       | Claude Code supports one endpoint. If it is already someone else's, we print a collector fan-out config and exit 4 without writing.                                                                                                                  |
| Foreign Codex `[otel]`      | Codex supports one exporter. `--codex` refuses to replace a section it did not create.                                                                                                                                                               |
| Byte-for-byte uninstall     | The pre-install file is snapshotted verbatim. `--uninstall` restores it exactly — but only if `settings.json` is unchanged since we wrote it. If you edited it, we remove only our own entries and say so, rather than silently reverting your edit. |
| Structural Codex uninstall  | `--codex --uninstall` removes only the marked Promptster block and preserves every other TOML setting.                                                                                                                                               |

Exit codes: `0` ok, `1` usage, `2` env conflict, `3` hooks disabled, `4` foreign
endpoint, `5` unparseable `settings.json`.

## Development

```bash
npm install
npm test
npm run typecheck
```

The `--print` output and the disclosure text are pinned by golden files in
`src/__tests__/__fixtures__/`. The disclosure is the user-facing egress contract:
if the wire behaviour changes, that fixture has to change in the same commit,
which is exactly the review moment we want.

The API this installer points at depends on this package and checks, in its own
tests, that `DEFAULT_OTLP_ENDPOINT` composes onto the routes it serves and that
the header names match the ones it reads.

Releasing: bump `version` in `package.json` and merge. The publish workflow
pushes any version not already on npm.

## License

MIT
