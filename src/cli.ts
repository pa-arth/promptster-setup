import {
  DEFAULT_CHOICES,
  DEFAULT_OTLP_ENDPOINT,
  ENDPOINT_ENV_KEY,
  EXIT,
  FORBIDDEN_ENV_KEYS,
  type CaptureChoices,
} from './constants.js';
import { renderDisclosure } from './disclosure.js';
import { renderDiff } from './diff.js';
import { buildPlan, effectiveChoices, type Plan, type Tier } from './plan.js';
import { applyPlan } from './apply.js';
import { uninstall } from './uninstall.js';
import {
  CODEX_DISCLOSURE_LINES,
  planCodex,
  uninstallCodex,
  type CodexPlan,
} from './codexConfig.js';
import { readTextOrNull, SettingsParseError, writeFileAtomicish } from './settingsFile.js';
import { displayPath } from './paths.js';
import { rmSync } from 'node:fs';

export interface RunResult {
  code: number;
  out: string;
}

interface Args {
  codex: boolean;
  print: boolean;
  uninstall: boolean;
  help: boolean;
  tier: Tier;
  tierExplicit: boolean;
  token: string | null;
  endpoint: string;
  /** What the customer chose to export (--prompts, --responses, --no-tool-details). */
  choices: CaptureChoices;
  error: string | null;
}

const USAGE = `promptster setup — enroll Claude Code or Codex telemetry capture

  npx @promptster/setup --token <token>       install tier B (telemetry + hooks)
  npx @promptster/setup --codex --token <token>   install Codex log telemetry
  npx @promptster/setup --token <token> --print   dry run: print the diff, write nothing
  npx @promptster/setup --token <token> --tier a  telemetry only, no hooks
  npx @promptster/setup --uninstall               restore the prior settings.json
  npx @promptster/setup --codex --uninstall       remove our Codex config block

Options:
  --codex         target Codex (~/.codex/config.toml); default is Claude Code
  --token <t>     enrollment token (or PROMPTSTER_TOKEN)
  --endpoint <u>  OTLP base endpoint (default ${DEFAULT_OTLP_ENDPOINT})
  --tier a|b      Claude Code only: a = telemetry, b = telemetry + hooks (default b)

What to export — your choice; re-run with different flags to change it:
  --prompts          also export prompt text (off by default; secrets scrubbed on arrival)
  --responses        Claude Code only: also export Claude's responses (off by default)
  --no-tool-details  Claude Code only: don't export tool arguments (on by default;
                     commands, edits and commit linking on the dashboard need them)
  --print         print the plan and exit without writing
  --uninstall     undo a previous install
  -h, --help      this text`;

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    codex: false,
    print: false,
    uninstall: false,
    help: false,
    tier: 'b',
    tierExplicit: false,
    token: process.env.PROMPTSTER_TOKEN ?? null,
    endpoint: process.env.PROMPTSTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT,
    choices: { ...DEFAULT_CHOICES },
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--codex':
        args.codex = true;
        break;
      case '--print':
      case '--dry-run':
        args.print = true;
        break;
      case '--uninstall':
        args.uninstall = true;
        break;
      case '--prompts':
        args.choices.prompts = true;
        break;
      case '--responses':
        args.choices.responses = true;
        break;
      case '--no-tool-details':
        args.choices.toolDetails = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--tier': {
        args.tierExplicit = true;
        const v = (argv[++i] ?? '').toLowerCase();
        if (v !== 'a' && v !== 'b') {
          args.error = `--tier expects "a" or "b", got ${JSON.stringify(argv[i] ?? '')}`;
          return args;
        }
        args.tier = v;
        break;
      }
      case '--token': {
        const v = argv[++i];
        if (!v) {
          args.error = '--token expects a value';
          return args;
        }
        args.token = v;
        break;
      }
      case '--endpoint': {
        const v = argv[++i];
        if (!v) {
          args.error = '--endpoint expects a value';
          return args;
        }
        args.endpoint = v;
        break;
      }
      default:
        args.error = `unknown option ${JSON.stringify(a)}`;
        return args;
    }
  }
  if (args.codex && args.tierExplicit) {
    args.error = '--tier applies to Claude Code only; Codex capture is log telemetry only';
  }
  if (args.codex && (args.choices.responses || !args.choices.toolDetails)) {
    args.error =
      '--responses and --no-tool-details apply to Claude Code only; Codex has one switch, --prompts';
  }
  return args;
}

function renderCodexDiff(plan: CodexPlan, endpoint: string, prompts: boolean): string {
  const out = [
    `promptster setup — Codex plan for ${displayPath(plan.path)}`,
    'mode: log telemetry only (no metrics exporter)',
    '',
  ];
  if (plan.next === null) {
    out.push('  (no changes — Codex is already enrolled)');
  } else {
    out.push(
      plan.replacingOurBlock
        ? '  ~ Promptster-managed [otel] block'
        : '  + Promptster-managed [otel] block',
    );
    out.push(`    endpoint = ${endpoint}`);
    out.push('    Authorization = Bearer ***redacted***');
    out.push(`    log_user_prompt = ${prompts ? 'true' : 'false'}`);
    out.push('');
    out.push('nothing else in config.toml is moved or rewritten.');
  }
  return out.join('\n');
}

function runCodex(
  args: Args,
  token: string,
  say: (s?: string) => void,
  done: (code: number) => RunResult,
): RunResult {
  const initial = planCodex(null, { token, endpoint: args.endpoint });
  const existing = readTextOrNull(initial.path);

  if (args.uninstall) {
    const next = uninstallCodex(existing);
    say(`promptster setup — uninstall from ${displayPath(initial.path)}`);
    say('');
    if (next === null) {
      say('  (nothing to undo)');
      return done(EXIT.OK);
    }
    if (next.trim() === '') rmSync(initial.path, { force: true });
    else writeFileAtomicish(initial.path, next);
    say('  removed our [otel] block; every other Codex setting was left intact');
    return done(EXIT.OK);
  }

  const plan = planCodex(existing, {
    token,
    endpoint: args.endpoint,
    prompts: args.choices.prompts,
  });
  if (plan.foreignOtel) {
    say(`promptster setup — stopping, nothing written to ${displayPath(plan.path)}`);
    say('');
    say('  Codex already has an [otel] section that this installer did not write.');
    say('  Codex supports one log exporter, so replacing it would silently redirect');
    say('  telemetry you are already collecting. We will not do that.');
    say('');
    say('  Keep that exporter and fan out from its collector, or remove the stale');
    say(`  [otel] section from ${displayPath(plan.path)} and re-run.`);
    return done(EXIT.FOREIGN_ENDPOINT);
  }

  say(CODEX_DISCLOSURE_LINES.join('\n'));
  say('');
  say(renderCodexDiff(plan, args.endpoint, args.choices.prompts));
  say('');

  if (args.print) {
    say('--print: nothing was written.');
    return done(EXIT.OK);
  }
  if (plan.next === null) return done(EXIT.OK);

  writeFileAtomicish(plan.path, plan.next);
  say(`wrote ${displayPath(plan.path)}`);
  say('undo at any time with: npx @promptster/setup --codex --uninstall');
  return done(EXIT.OK);
}

/**
 * The whole CLI as a pure-ish function: argv in, exit code + text out, no
 * process.exit and no direct console. That is what lets every behaviour in the
 * contract be asserted from a test with HOME pointed at a tmpdir.
 */
export function run(argv: string[], opts: { cwd?: string } = {}): RunResult {
  const cwd = opts.cwd ?? process.cwd();
  const args = parseArgs(argv);
  const out: string[] = [];
  const say = (s = '') => out.push(s);
  const done = (code: number): RunResult => ({ code, out: out.join('\n') + '\n' });

  if (args.error) {
    say(`error: ${args.error}`);
    say('');
    say(USAGE);
    return done(EXIT.USAGE);
  }
  if (args.help) {
    say(USAGE);
    return done(EXIT.OK);
  }

  if (args.uninstall && args.codex) {
    return runCodex(args, args.token ?? '', say, done);
  }

  if (args.uninstall) {
    try {
      const result = uninstall();
      say(`promptster setup — uninstall from ${displayPath(result.settingsPath)}`);
      say('');
      if (result.mode === 'nothing') {
        say('  (nothing to undo)');
      } else {
        say(
          result.mode === 'verbatim'
            ? '  restored settings.json byte-for-byte to its pre-install contents'
            : '  removed our entries from settings.json',
        );
        for (const k of result.removedEnvKeys) say(`  - env ${k}`);
        for (const e of result.removedHookEvents) say(`  - hooks ${e}`);
        for (const k of result.removedSettingKeys) say(`  - setting ${k}`);
        for (const f of result.removedFiles) say(`  - file ${displayPath(f)}`);
      }
      for (const n of result.notes) {
        say('');
        say(`  note: ${n}`);
      }
      return done(EXIT.OK);
    } catch (err) {
      if (err instanceof SettingsParseError) {
        say(`error: ${err.message}`);
        say('Nothing was written. Fix the JSON and re-run --uninstall.');
        return done(EXIT.BAD_SETTINGS);
      }
      throw err;
    }
  }

  // A dry run must be usable before you have a token; the diff redacts it anyway.
  const token = args.token ?? (args.print ? '<your-token>' : null);
  if (token === null) {
    say('error: --token is required (or set PROMPTSTER_TOKEN)');
    say('');
    say(USAGE);
    return done(EXIT.USAGE);
  }

  if (args.codex) return runCodex(args, token, say, done);

  let plan: Plan;
  try {
    plan = buildPlan({
      tier: args.tier,
      token,
      endpoint: args.endpoint,
      cwd,
      choices: args.choices,
    });
  } catch (err) {
    if (err instanceof SettingsParseError) {
      say(`error: ${err.message}`);
      say('Nothing was written. Fix the JSON and re-run.');
      return done(EXIT.BAD_SETTINGS);
    }
    throw err;
  }

  // ---- Blocker 1: someone else's collector already owns the endpoint.
  if (plan.foreignEndpoint !== null) {
    say(`promptster setup — stopping, nothing written to ${displayPath(plan.settingsPath)}`);
    say('');
    say(`  ${ENDPOINT_ENV_KEY} is already set to a collector that is not ours:`);
    say(`    ${plan.foreignEndpoint}`);
    say('');
    say('  Claude Code supports exactly ONE OTLP endpoint, so enrolling here would');
    say('  silently redirect telemetry you are already collecting. We will not do that.');
    say('');
    say('  Fan out from your own collector instead: keep that endpoint, and add a');
    say('  promptster exporter to its pipeline. For the OpenTelemetry Collector that is');
    say('  a second otlphttp exporter on the same logs/metrics pipelines:');
    say('');
    say('    exporters:');
    say('      otlphttp/promptster:');
    say(`        endpoint: ${plan.endpoint}`);
    say('        headers: { Authorization: "Bearer <your-token>" }');
    say('    service:');
    say('      pipelines:');
    say('        logs:    { exporters: [<your existing>, otlphttp/promptster] }');
    say('        metrics: { exporters: [<your existing>, otlphttp/promptster] }');
    say('');
    say('  If that endpoint is stale and you want us to take it over, remove it from');
    say(`  ${displayPath(plan.settingsPath)} and re-run.`);
    return done(EXIT.FOREIGN_ENDPOINT);
  }

  // ---- Blocker 2: an env key we did not write. Never clobber it.
  if (plan.envConflicts.length > 0) {
    say(`promptster setup — stopping, nothing written to ${displayPath(plan.settingsPath)}`);
    say('');
    say('  These env keys are already set to values this installer did not write.');
    say('  Overwriting them could change behaviour you rely on, so we stopped:');
    say('');
    for (const c of plan.envConflicts) {
      say(`    ${c.key}`);
      say(`      yours: ${c.existing}`);
      say(
        `      ours:  ${c.key === 'OTEL_EXPORTER_OTLP_HEADERS' ? 'Authorization=Bearer ***redacted***' : c.ours}`,
      );
    }
    say('');
    say('  Remove or align them and re-run, or run with --tier a if you only want');
    say('  the pieces that do not collide.');
    return done(EXIT.ENV_CONFLICT);
  }

  // ---- Blocker 2b: a settings key we own (otelHeadersHelper) already holds
  // someone else's helper. Claude Code runs exactly one, so replacing it would
  // silently drop whatever headers their collector depends on.
  if (plan.settingConflicts.length > 0) {
    say(`promptster setup — stopping, nothing written to ${displayPath(plan.settingsPath)}`);
    say('');
    say('  These settings are already set to values this installer did not write.');
    say('  Claude Code runs only one, so replacing it would break yours; we stopped:');
    say('');
    for (const c of plan.settingConflicts) {
      say(`    ${c.key}`);
      say(`      yours: ${c.existing}`);
      say(`      ours:  ${c.ours}`);
    }
    say('');
    say('  Remove it and re-run, or merge its output with ours by hand.');
    return done(EXIT.ENV_CONFLICT);
  }

  // ---- Blocker 3: hooks are switched off machine-wide. Say so; do not write dead hooks.
  let hooksDisabledSource: string | null = null;
  if (plan.hooksDisabled !== null) {
    hooksDisabledSource = plan.hooksDisabled.source;
    // Re-plan as tier A so the diff we print is the diff we would actually write.
    plan = buildPlan({ tier: 'a', token, endpoint: args.endpoint, cwd, choices: args.choices });
  }

  // What the settings will ACTUALLY export once written — not just what was
  // asked for. A switch the user set themselves survives a run that asked for
  // it off, and the disclosure must not call that data "not sent".
  say(renderDisclosure(effectiveChoices(plan.next.env)));
  say('');
  say(renderDiff(plan));
  say('');

  if (hooksDisabledSource !== null) {
    say('TIER B WILL NOT RUN');
    say(`  disableAllHooks is true in ${displayPath(hooksDisabledSource)}.`);
    say('  Claude Code will not execute ANY hook while that is set, so the tier-B');
    say('  lifecycle hooks were NOT written — writing them would leave dead entries in');
    say('  your settings and let this command claim a success it did not deliver.');
    say('  Telemetry (tier A) is unaffected. Clear disableAllHooks and re-run for tier B.');
    say('');
  }

  if (args.print) {
    say('--print: nothing was written.');
    return done(hooksDisabledSource !== null ? EXIT.HOOKS_DISABLED : EXIT.OK);
  }

  if (plan.empty) {
    return done(hooksDisabledSource !== null ? EXIT.HOOKS_DISABLED : EXIT.OK);
  }

  applyPlan(plan);
  say(`wrote ${displayPath(plan.settingsPath)}`);
  say('undo at any time with: npx @promptster/setup --uninstall');
  return done(hooksDisabledSource !== null ? EXIT.HOOKS_DISABLED : EXIT.OK);
}

/** Guard against a refactor ever sneaking a never-written key into the writer. */
export const NEVER_WRITTEN_ENV_KEYS = FORBIDDEN_ENV_KEYS;

export function main(argv = process.argv.slice(2)): void {
  const result = run(argv);
  process.stdout.write(result.out);
  process.exitCode = result.code;
}
