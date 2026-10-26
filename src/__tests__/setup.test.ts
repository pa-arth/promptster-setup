import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../cli.js';
import { renderDisclosure, DISCLOSURE_SENTENCE } from '../disclosure.js';
import { DEFAULT_OTLP_ENDPOINT, EXIT, FORBIDDEN_ENV_KEYS, TIER_B_EVENTS } from '../constants.js';
import {
  makeSandbox,
  readJson,
  readText,
  exists,
  restoreEnv,
  writeJson,
  TEST_TOKEN,
  type Sandbox,
} from './helpers.js';

const FIXTURES = join(import.meta.dirname, '__fixtures__');

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});

afterEach(() => {
  box.cleanup();
});

afterAll(() => {
  restoreEnv();
});

function install(extra: string[] = []) {
  return run(['--token', TEST_TOKEN, ...extra], { cwd: box.cwd });
}

/** The settings.json a real user with an opinionated config already has. */
function seedRichSettings(): void {
  writeJson(box.settings, {
    env: { EDITOR: 'nvim', SOME_TEAM_FLAG: 'on' },
    statusLine: { type: 'command', command: '~/bin/my-statusline.sh', padding: 0 },
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: '~/bin/audit-log.sh' }],
        },
      ],
    },
    permissions: { allow: ['Bash(git status)'] },
  });
}

describe('--print', () => {
  it('matches the checked-in golden file', () => {
    const result = run(['--print', '--token', TEST_TOKEN], { cwd: box.cwd });
    const golden = readFileSync(join(FIXTURES, 'print.golden.txt'), 'utf8');
    expect(result.out).toBe(golden);
    expect(result.code).toBe(EXIT.OK);
  });

  it('writes absolutely nothing', () => {
    run(['--print', '--token', TEST_TOKEN], { cwd: box.cwd });
    expect(exists(box.settings)).toBe(false);
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
    expect(exists(join(box.home, '.promptster', 'setup-state.json'))).toBe(false);
  });

  it('never prints the token', () => {
    const result = run(['--print', '--token', TEST_TOKEN], { cwd: box.cwd });
    expect(result.out).not.toContain(TEST_TOKEN);
    expect(result.out).toContain('Bearer ***redacted***');
  });
});

describe('disclosure', () => {
  it('matches the pinned fixture', () => {
    const golden = readFileSync(join(FIXTURES, 'disclosure.golden.txt'), 'utf8');
    expect(renderDisclosure() + '\n').toBe(golden);
  });

  it('names what the receiver keeps of tool arguments, and what it drops', () => {
    expect(DISCLOSURE_SENTENCE).toContain('keeps command lines and file paths');
    expect(DISCLOSURE_SENTENCE).toContain('secrets scrubbed');
    expect(DISCLOSURE_SENTENCE).toContain('DROPPED at that boundary');
    expect(DISCLOSURE_SENTENCE).toContain('never written to storage');
  });

  it('is printed before anything is written', () => {
    const result = install();
    const disclosureAt = result.out.indexOf('WHAT LEAVES THIS MACHINE');
    const diffAt = result.out.indexOf('promptster setup — plan for');
    const wroteAt = result.out.indexOf('wrote $HOME/.claude/settings.json');
    expect(disclosureAt).toBeGreaterThanOrEqual(0);
    expect(diffAt).toBeGreaterThan(disclosureAt);
    expect(wroteAt).toBeGreaterThan(diffAt);
  });
});

describe('install (tier B)', () => {
  it('writes the telemetry env and the lifecycle hooks', () => {
    const result = install();
    expect(result.code).toBe(EXIT.OK);
    const s = readJson(box.settings);
    const env = s.env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp');
    // http/protobuf — back to the OTel default now that the receiver decodes it
    // (2026-07-27). It was http/json only because our own endpoint answered 415;
    // writing protobuf then would have had our installer configure a wire format
    // we rejected. Verified against real exporter bytes before the flip — see
    // STATIC_ENV in constants.ts and __fixtures__/otlp-protobuf/.
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
    // The repo and Claude Code version on every record — the only repo signal a
    // managed-settings push without the headers helper has.
    expect(env.OTEL_METRICS_INCLUDE_REPOSITORY).toBe('true');
    expect(env.OTEL_METRICS_INCLUDE_VERSION).toBe('true');
    // Asserted against the constant, not a repeated literal: a hardcoded copy
    // here would have to be edited in lockstep with the thing it is checking,
    // which makes it a change-detector rather than a guard. The guard that the
    // base is the RIGHT one lives in constants.test.ts, against the receiver.
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(DEFAULT_OTLP_ENDPOINT);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${TEST_TOKEN}`);
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe('1');

    const hooks = s.hooks as Record<string, unknown[]>;
    for (const { event } of TIER_B_EVENTS) {
      expect(hooks[event], `missing hook for ${event}`).toBeDefined();
    }
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(true);
  });

  it('by default exports no prompt or response text, and never raw API bodies', () => {
    install();
    const env = readJson(box.settings).env as Record<string, string>;
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(env[key], `${key} must never be written`).toBeUndefined();
    }
    install(['--prompts', '--responses']);
    for (const key of FORBIDDEN_ENV_KEYS) {
      const after = readJson(box.settings).env as Record<string, string>;
      expect(after[key], `${key} under any flag`).toBeUndefined();
    }
  });

  it('--tier a writes telemetry only: no hooks, no spool script', () => {
    const result = install(['--tier', 'a']);
    expect(result.code).toBe(EXIT.OK);
    const s = readJson(box.settings);
    expect(s.hooks).toBeUndefined();
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
    expect((s.env as Record<string, string>).CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });
});

describe('idempotency', () => {
  it('the second and third consecutive runs produce an empty diff and change no bytes', () => {
    const first = install();
    expect(first.code).toBe(EXIT.OK);
    const afterFirst = readText(box.settings);

    const second = install();
    expect(second.code).toBe(EXIT.OK);
    expect(second.out).toContain('(no changes — this machine is already enrolled)');
    expect(second.out).not.toContain('wrote $HOME/.claude/settings.json');
    expect(readText(box.settings)).toBe(afterFirst);

    const third = install();
    expect(third.code).toBe(EXIT.OK);
    expect(third.out).toContain('(no changes — this machine is already enrolled)');
    expect(readText(box.settings)).toBe(afterFirst);
  });

  it('is idempotent on top of a rich pre-existing config too', () => {
    seedRichSettings();
    install();
    const afterFirst = readText(box.settings);
    const second = install();
    expect(second.out).toContain('(no changes — this machine is already enrolled)');
    expect(readText(box.settings)).toBe(afterFirst);
  });
});

describe('append, never replace', () => {
  it('keeps a pre-existing PostToolUse hook and a pre-existing statusLine, and adds ours alongside', () => {
    seedRichSettings();
    const result = install();
    expect(result.code).toBe(EXIT.OK);

    const s = readJson(box.settings);

    // Their statusLine is untouched, object-identical.
    expect(s.statusLine).toEqual({
      type: 'command',
      command: '~/bin/my-statusline.sh',
      padding: 0,
    });

    const postToolUse = (s.hooks as Record<string, Array<Record<string, unknown>>>).PostToolUse;
    expect(postToolUse).toHaveLength(2);
    // Theirs is still FIRST and still intact.
    expect(postToolUse[0]).toEqual({
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: '~/bin/audit-log.sh' }],
    });
    // Ours is appended after it.
    expect(JSON.stringify(postToolUse[1])).toContain('.promptster/spool.mjs');

    // Their unrelated env + permissions survive.
    const env = s.env as Record<string, string>;
    expect(env.EDITOR).toBe('nvim');
    expect(env.SOME_TEAM_FLAG).toBe('on');
    expect(s.permissions).toEqual({ allow: ['Bash(git status)'] });
  });

  it('appends to an event array that already has several groups, preserving order', () => {
    writeJson(box.settings, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'first.sh' }] },
          { hooks: [{ type: 'command', command: 'second.sh' }] },
        ],
      },
    });
    install();
    const groups = (readJson(box.settings).hooks as Record<string, Array<Record<string, unknown>>>)
      .SessionStart;
    expect(groups).toHaveLength(3);
    expect(JSON.stringify(groups[0])).toContain('first.sh');
    expect(JSON.stringify(groups[1])).toContain('second.sh');
    expect(JSON.stringify(groups[2])).toContain('.promptster/spool.mjs');
  });
});

describe('--uninstall', () => {
  it('restores byte-identical prior state when the user had env, hooks AND a statusLine', () => {
    seedRichSettings();
    const before = readText(box.settings);

    const installed = install();
    expect(installed.code).toBe(EXIT.OK);
    expect(readText(box.settings)).not.toBe(before);

    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(undone.out).toContain('restored settings.json byte-for-byte');
    expect(readText(box.settings)).toBe(before);
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
    expect(exists(join(box.home, '.promptster', 'setup-state.json'))).toBe(false);
  });

  it('removes the settings file entirely when there was none before', () => {
    install();
    expect(exists(box.settings)).toBe(true);
    run(['--uninstall'], { cwd: box.cwd });
    expect(exists(box.settings)).toBe(false);
  });

  it('does not clobber edits made after install — falls back to structural removal', () => {
    seedRichSettings();
    install();
    const edited = JSON.parse(readText(box.settings)) as Record<string, unknown>;
    (edited.env as Record<string, string>).ADDED_LATER = 'yes';
    writeFileSync(box.settings, JSON.stringify(edited, null, 2) + '\n', 'utf8');

    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(undone.out).toContain('was NOT restored from the snapshot');
    const s = readJson(box.settings);
    const env = s.env as Record<string, string>;
    expect(env.ADDED_LATER).toBe('yes');
    expect(env.EDITOR).toBe('nvim');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    // Their hook survived the surgical path too.
    const postToolUse = (s.hooks as Record<string, unknown[]>).PostToolUse;
    expect(postToolUse).toHaveLength(1);
    expect(JSON.stringify(postToolUse[0])).toContain('audit-log.sh');
  });

  it('is a no-op when nothing was ever installed', () => {
    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(undone.out).toContain('(nothing to undo)');
  });
});

describe('env-key conflicts', () => {
  it('refuses to overwrite an env key it did not write, and exits non-zero', () => {
    writeJson(box.settings, { env: { OTEL_METRICS_EXPORTER: 'prometheus' } });
    const before = readText(box.settings);

    const result = install();
    expect(result.code).not.toBe(EXIT.OK);
    expect(result.code).toBe(EXIT.ENV_CONFLICT);
    expect(result.out).toContain('OTEL_METRICS_EXPORTER');
    expect(result.out).toContain('this installer did not write');
    expect(readText(box.settings)).toBe(before);
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
  });

  it('treats an identical pre-existing value as a no-op, not a conflict', () => {
    writeJson(box.settings, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } });
    const result = install();
    expect(result.code).toBe(EXIT.OK);
  });

  it('lets us rotate a token we wrote ourselves', () => {
    install();
    const rotated = run(['--token', 'psk_live_ROTATED'], { cwd: box.cwd });
    expect(rotated.code).toBe(EXIT.OK);
    const env = readJson(box.settings).env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer psk_live_ROTATED');
  });
});

describe('disableAllHooks preflight', () => {
  it('reports that tier B will not run instead of claiming success', () => {
    writeJson(box.settings, { disableAllHooks: true });
    const result = install();

    expect(result.out).toContain('TIER B WILL NOT RUN');
    expect(result.out).toContain('disableAllHooks is true in $HOME/.claude/settings.json');
    expect(result.code).toBe(EXIT.HOOKS_DISABLED);
    expect(result.code).not.toBe(EXIT.OK);

    // Dead hooks were NOT written; telemetry still was.
    const s = readJson(box.settings);
    expect(s.hooks).toBeUndefined();
    expect((s.env as Record<string, string>).CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
  });

  it('sees disableAllHooks in the managed policy file, not just our own settings', () => {
    writeJson(join(box.home, 'managed-settings.json'), { disableAllHooks: true });
    const result = install();
    expect(result.code).toBe(EXIT.HOOKS_DISABLED);
    expect(result.out).toContain('TIER B WILL NOT RUN');
    expect(readJson(box.settings).hooks).toBeUndefined();
  });

  it('sees disableAllHooks in a project-level settings file', () => {
    writeJson(join(box.cwd, '.claude', 'settings.json'), { disableAllHooks: true });
    const result = install();
    expect(result.code).toBe(EXIT.HOOKS_DISABLED);
    expect(result.out).toContain('TIER B WILL NOT RUN');
  });
});

describe('foreign OTLP endpoint', () => {
  it('explains fan-out and exits without writing', () => {
    writeJson(box.settings, {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.acme-corp.internal:4318',
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      },
    });
    const before = readText(box.settings);

    const result = install();
    expect(result.code).toBe(EXIT.FOREIGN_ENDPOINT);
    expect(result.out).toContain('https://otel.acme-corp.internal:4318');
    expect(result.out).toContain('otlphttp/promptster');
    expect(result.out).toContain('exactly ONE OTLP endpoint');

    // The decisive assertion: their endpoint is still theirs.
    expect(readText(box.settings)).toBe(before);
    const env = readJson(box.settings).env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.acme-corp.internal:4318');
  });

  it('does not treat our own endpoint as foreign', () => {
    writeJson(box.settings, {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: DEFAULT_OTLP_ENDPOINT },
    });
    const result = install();
    expect(result.code).toBe(EXIT.OK);
  });
});

describe('argument handling', () => {
  it('requires a token for a real install', () => {
    const result = run([], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.out).toContain('--token is required');
    expect(exists(box.settings)).toBe(false);
  });

  it('rejects an unknown flag rather than guessing', () => {
    const result = run(['--tokenn', 'x'], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.out).toContain('unknown option');
  });

  it('refuses a bogus tier', () => {
    const result = run(['--token', TEST_TOKEN, '--tier', 'c'], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.USAGE);
    expect(exists(box.settings)).toBe(false);
  });
});

describe('malformed settings.json', () => {
  it('stops and writes nothing', () => {
    writeFileSync(box.settings, '{ "env": { oops », }', 'utf8');
    const before = readText(box.settings);
    const result = install();
    expect(result.code).toBe(EXIT.BAD_SETTINGS);
    expect(result.out).toContain('is not valid JSON');
    expect(readText(box.settings)).toBe(before);
  });
});

describe('capture choices', () => {
  const env = () => readJson(box.settings).env as Record<string, string>;

  it('--prompts and --responses turn on prompt and response text, and say so', () => {
    const result = install(['--prompts', '--responses']);
    expect(result.code).toBe(EXIT.OK);
    expect(env().OTEL_LOG_USER_PROMPTS).toBe('1');
    expect(env().OTEL_LOG_ASSISTANT_RESPONSES).toBe('1');
    expect(result.out).toContain('your prompts (--prompts), secrets scrubbed on arrival');
    expect(result.out).not.toContain('OTEL_LOG_USER_PROMPTS is not written');
  });

  it('re-running without a choice removes the key we wrote for it', () => {
    install(['--prompts']);
    expect(env().OTEL_LOG_USER_PROMPTS).toBe('1');
    const result = install();
    expect(result.out).toContain('- OTEL_LOG_USER_PROMPTS');
    expect(env().OTEL_LOG_USER_PROMPTS).toBeUndefined();
    // And the next run is a no-op again.
    expect(install(['--print']).out).toContain('already enrolled');
  });

  it('keeps a prompt switch the user set themselves', () => {
    install();
    const s = readJson(box.settings);
    (s.env as Record<string, string>).OTEL_LOG_USER_PROMPTS = '1';
    writeFileSync(box.settings, JSON.stringify(s, null, 2) + '\n', 'utf8');
    const result = install();
    expect(env().OTEL_LOG_USER_PROMPTS).toBe('1');
    // The disclosure reads the settings as written, not the flags asked for.
    expect(result.out).not.toContain('OTEL_LOG_USER_PROMPTS is not written');
  });

  it('discloses a tool-details switch the user set, even under --no-tool-details', () => {
    install(['--no-tool-details']);
    const s = readJson(box.settings);
    (s.env as Record<string, string>).OTEL_LOG_TOOL_DETAILS = '1';
    writeFileSync(box.settings, JSON.stringify(s, null, 2) + '\n', 'utf8');
    const result = install(['--no-tool-details']);
    expect(env().OTEL_LOG_TOOL_DETAILS).toBe('1');
    expect(result.out).not.toContain('OTEL_LOG_TOOL_DETAILS is not written');
  });

  it('--no-tool-details stops exporting tool arguments, and removes our earlier switch', () => {
    install();
    expect(env().OTEL_LOG_TOOL_DETAILS).toBe('1');
    const result = install(['--no-tool-details']);
    expect(env().OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(result.out).toContain('tool arguments (OTEL_LOG_TOOL_DETAILS is not written)');
  });

  it('uninstall removes chosen keys too', () => {
    seedRichSettings();
    install(['--prompts', '--responses']);
    run(['--uninstall'], { cwd: box.cwd });
    const env = readJson(box.settings).env as Record<string, string> | undefined;
    expect(env?.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env?.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
  });
});
