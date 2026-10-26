import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../cli.js';
import {
  EXIT,
  OTEL_HEADERS_HELPER_COMMAND,
  OTEL_HEADERS_HELPER_KEY,
  PLAN_HEADER,
  REPO_HEADER,
  WORKDIR_HEADER,
} from '../constants.js';
import { OTEL_HEADERS_SCRIPT_SOURCE } from '../otelHeadersScript.js';
import {
  exists,
  makeSandbox,
  readJson,
  readText,
  restoreEnv,
  writeJson,
  TEST_TOKEN,
  type Sandbox,
} from './helpers.js';

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

const scriptPath = () => join(box.home, '.promptster', 'otel-headers.mjs');
const statePath = () => join(box.home, '.promptster', 'setup-state.json');

describe('otelHeadersHelper install', () => {
  for (const tier of ['a', 'b'] as const) {
    it(`tier ${tier} writes the helper key and its script`, () => {
      const result = install(['--tier', tier]);
      expect(result.code).toBe(EXIT.OK);
      expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBe(OTEL_HEADERS_HELPER_COMMAND);
      expect(readText(scriptPath())).toBe(OTEL_HEADERS_SCRIPT_SOURCE);
      expect(readJson(statePath()).otelHeadersHelper).toBe(OTEL_HEADERS_HELPER_COMMAND);
    });

    it(`tier ${tier}: a re-run is an empty diff and changes no bytes`, () => {
      install(['--tier', tier]);
      const settingsAfter = readText(box.settings);
      const scriptAfter = readText(scriptPath());
      const second = install(['--tier', tier]);
      expect(second.code).toBe(EXIT.OK);
      expect(second.out).toContain('(no changes — this machine is already enrolled)');
      expect(second.out).not.toContain('otelHeadersHelper =');
      expect(readText(box.settings)).toBe(settingsAfter);
      expect(readText(scriptPath())).toBe(scriptAfter);
    });
  }

  it('restores a deleted helper script on re-run without touching settings.json', () => {
    install();
    const settingsAfter = readText(box.settings);
    rmSync(scriptPath());
    const again = install();
    expect(again.code).toBe(EXIT.OK);
    expect(again.out).toContain('+ $HOME/.promptster/otel-headers.mjs');
    expect(exists(scriptPath())).toBe(true);
    expect(readText(box.settings)).toBe(settingsAfter);
  });

  it('adds the helper to a machine enrolled before it existed, keeping the original snapshot', () => {
    writeJson(box.settings, { env: { EDITOR: 'nvim' } });
    const before = readText(box.settings);
    install();
    // Simulate a pre-helper install: no key in settings, no record in state.
    const s = readJson(box.settings);
    delete s[OTEL_HEADERS_HELPER_KEY];
    writeFileSync(box.settings, JSON.stringify(s, null, 2) + '\n', 'utf8');
    const state = readJson(statePath());
    delete state.otelHeadersHelper;
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
    rmSync(scriptPath());

    const upgrade = install();
    expect(upgrade.code).toBe(EXIT.OK);
    expect(upgrade.out).toContain(`+ otelHeadersHelper = ${OTEL_HEADERS_HELPER_COMMAND}`);
    expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBe(OTEL_HEADERS_HELPER_COMMAND);
    expect(readJson(statePath()).otelHeadersHelper).toBe(OTEL_HEADERS_HELPER_COMMAND);

    run(['--uninstall'], { cwd: box.cwd });
    expect(readText(box.settings)).toBe(before);
  });
});

describe('otelHeadersHelper conflicts', () => {
  it('refuses to replace a helper it did not write, and writes nothing', () => {
    writeJson(box.settings, { [OTEL_HEADERS_HELPER_KEY]: '~/bin/my-otel-headers.sh' });
    const before = readText(box.settings);

    const result = install();
    expect(result.code).toBe(EXIT.ENV_CONFLICT);
    expect(result.out).toContain('otelHeadersHelper');
    expect(result.out).toContain('~/bin/my-otel-headers.sh');
    expect(result.out).toContain('this installer did not write');
    expect(readText(box.settings)).toBe(before);
    expect(exists(scriptPath())).toBe(false);
    expect(exists(join(box.home, '.promptster', 'spool.mjs'))).toBe(false);
    expect(exists(statePath())).toBe(false);
  });

  it('a user wrapper around our script is theirs: a conflict, never replaced', () => {
    const wrapper = `ADD=1 ${OTEL_HEADERS_HELPER_COMMAND} | ~/bin/merge-headers`;
    writeJson(box.settings, { [OTEL_HEADERS_HELPER_KEY]: wrapper });
    const result = install();
    expect(result.code).toBe(EXIT.ENV_CONFLICT);
    expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBe(wrapper);

    run(['--uninstall'], { cwd: box.cwd });
    expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBe(wrapper);
  });

  it('treats a non-string helper value as foreign too', () => {
    writeJson(box.settings, { [OTEL_HEADERS_HELPER_KEY]: { weird: true } });
    const result = install(['--tier', 'a']);
    expect(result.code).toBe(EXIT.ENV_CONFLICT);
  });

  it('--print shows the conflict and writes nothing', () => {
    writeJson(box.settings, { [OTEL_HEADERS_HELPER_KEY]: 'theirs' });
    const result = run(['--print', '--token', TEST_TOKEN], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.ENV_CONFLICT);
    expect(exists(scriptPath())).toBe(false);
  });
});

describe('otelHeadersHelper uninstall', () => {
  it('verbatim path: the key and the script are both gone', () => {
    writeJson(box.settings, { env: { EDITOR: 'nvim' } });
    const before = readText(box.settings);
    install();
    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(undone.out).toContain('- setting otelHeadersHelper');
    expect(undone.out).toContain('- file $HOME/.promptster/otel-headers.mjs');
    expect(readText(box.settings)).toBe(before);
    expect(exists(scriptPath())).toBe(false);
  });

  it('structural path: removes our helper, keeps the edit made after install', () => {
    install();
    const s = readJson(box.settings);
    s.model = 'opus';
    writeFileSync(box.settings, JSON.stringify(s, null, 2) + '\n', 'utf8');

    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(undone.out).toContain('- setting otelHeadersHelper');
    const after = readJson(box.settings);
    expect(after[OTEL_HEADERS_HELPER_KEY]).toBeUndefined();
    expect(after.model).toBe('opus');
    expect(exists(scriptPath())).toBe(false);
  });

  it('structural path: a helper the user swapped in after install is theirs and stays', () => {
    install();
    const s = readJson(box.settings);
    s[OTEL_HEADERS_HELPER_KEY] = '~/bin/mine.sh';
    writeFileSync(box.settings, JSON.stringify(s, null, 2) + '\n', 'utf8');

    run(['--uninstall'], { cwd: box.cwd });
    expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBe('~/bin/mine.sh');
  });

  it('with no state file, still recognises our helper by its script path', () => {
    install();
    rmSync(statePath());
    const undone = run(['--uninstall'], { cwd: box.cwd });
    expect(undone.code).toBe(EXIT.OK);
    expect(readJson(box.settings)[OTEL_HEADERS_HELPER_KEY]).toBeUndefined();
  });
});

// ---- The script itself, run the way Claude Code runs it: `node <file>` in the
// session cwd, with HOME pointing at a fake home.
describe('otel-headers.mjs', () => {
  let root: string;
  let fakeHome: string;
  let script: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promptster-otel-headers-'));
    fakeHome = join(root, 'home', 'alice');
    mkdirSync(fakeHome, { recursive: true });
    script = join(root, 'bin', 'otel-headers.mjs');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, OTEL_HEADERS_SCRIPT_SOURCE, 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function gitRepo(dir: string, remote: string | null): string {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (remote !== null) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    return dir;
  }

  function runScript(cwd: string): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        // Never let git walk up out of the temp tree into a real repo.
        GIT_CEILING_DIRECTORIES: root,
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function headers(cwd: string): Record<string, string> {
    const r = runScript(cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout) as Record<string, string>;
    expect(Object.keys(parsed).sort()).toEqual([PLAN_HEADER, REPO_HEADER, WORKDIR_HEADER].sort());
    // The plan header has its own suite below; these cases are about the repo.
    const { [PLAN_HEADER]: _plan, ...rest } = parsed;
    return rest;
  }

  it('strips credentials from an https remote and sends a home-relative workdir', () => {
    const repo = gitRepo(
      join(fakeHome, 'repos', 'foo'),
      'https://alice:ghp_SECRETTOKEN@github.com/acme/foo.git',
    );
    const r = runScript(repo);
    expect(r.stdout).not.toContain('ghp_SECRETTOKEN');
    expect(r.stdout).not.toContain('alice:');
    expect(JSON.parse(r.stdout)).toEqual({
      [REPO_HEADER]: 'https://github.com/acme/foo.git',
      [WORKDIR_HEADER]: '~/repos/foo',
      [PLAN_HEADER]: 'absent',
    });
  });

  it('strips a token-only username too', () => {
    const repo = gitRepo(join(fakeHome, 'r'), 'https://x-access-token:abc@github.com/acme/foo.git');
    expect(headers(repo)[REPO_HEADER]).toBe('https://github.com/acme/foo.git');
    const repo2 = gitRepo(join(fakeHome, 'r2'), 'https://ghp_ONLYTOKEN@github.com/acme/bar');
    expect(headers(repo2)[REPO_HEADER]).toBe('https://github.com/acme/bar');
  });

  it('passes a clean remote through exactly as git prints it', () => {
    const https = gitRepo(join(fakeHome, 'a'), 'https://github.com/acme/foo');
    expect(headers(https)[REPO_HEADER]).toBe('https://github.com/acme/foo');
    const scp = gitRepo(join(fakeHome, 'b'), 'git@github.com:acme/foo.git');
    expect(headers(scp)[REPO_HEADER]).toBe('git@github.com:acme/foo.git');
    const ssh = gitRepo(join(fakeHome, 'c'), 'ssh://git:pw@host.example/acme/foo.git');
    expect(headers(ssh)[REPO_HEADER]).toBe('ssh://git@host.example/acme/foo.git');
  });

  it('subdirectory of a repo: remote still found, workdir is the subdirectory', () => {
    const repo = gitRepo(join(fakeHome, 'repos', 'foo'), 'https://github.com/acme/foo');
    const sub = join(repo, 'packages', 'x');
    mkdirSync(sub, { recursive: true });
    expect(headers(sub)).toEqual({
      [REPO_HEADER]: 'https://github.com/acme/foo',
      [WORKDIR_HEADER]: '~/repos/foo/packages/x',
    });
  });

  it('cwd == HOME is "~"; no repo means an empty repo header', () => {
    expect(headers(fakeHome)).toEqual({ [REPO_HEADER]: '', [WORKDIR_HEADER]: '~' });
  });

  it('a repo with no origin sends an empty repo header', () => {
    const repo = gitRepo(join(fakeHome, 'local-only'), null);
    expect(headers(repo)).toEqual({ [REPO_HEADER]: '', [WORKDIR_HEADER]: '~/local-only' });
  });

  it('cwd outside HOME sends an empty workdir — never an absolute path', () => {
    const outside = gitRepo(join(root, 'srv', 'build'), 'https://tok@github.com/acme/ci');
    const h = headers(outside);
    expect(h).toEqual({ [REPO_HEADER]: 'https://github.com/acme/ci', [WORKDIR_HEADER]: '' });
    expect(JSON.stringify(h)).not.toContain(root);
  });

  it('a sibling that merely shares the HOME prefix is outside HOME', () => {
    const sibling = join(root, 'home', 'alice2');
    mkdirSync(sibling, { recursive: true });
    expect(headers(sibling)[WORKDIR_HEADER]).toBe('');
  });

  it('exits 0 with one JSON object even when git is not on PATH', () => {
    const repo = gitRepo(join(fakeHome, 'repos', 'nogit'), 'https://github.com/acme/foo');
    const r = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: '', HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      [REPO_HEADER]: '',
      [WORKDIR_HEADER]: '~/repos/nogit',
      [PLAN_HEADER]: 'absent',
    });
  });

  it('percent-encodes non-ASCII so the header value stays legal', () => {
    const dir = join(fakeHome, 'café');
    mkdirSync(dir, { recursive: true });
    expect(headers(dir)[WORKDIR_HEADER]).toBe('~/caf%C3%A9');
  });

  it('keeps an emoji (a surrogate pair) whole instead of dropping it', () => {
    const dir = join(fakeHome, 'project-🚀');
    mkdirSync(dir, { recursive: true });
    expect(headers(dir)[WORKDIR_HEADER]).toBe('~/project-%F0%9F%9A%80');
  });

  const plan = () => JSON.parse(runScript(fakeHome).stdout)[PLAN_HEADER] as string;
  const profile = (oauthAccount: unknown) =>
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ numStartups: 3, oauthAccount }),
      'utf8',
    );

  it('sends the plan fields the CLI relays, and nothing else from the profile', () => {
    profile({
      accountUuid: 'acc-uuid-1',
      emailAddress: 'alice@acme.test',
      displayName: 'Alice',
      organizationName: 'Acme',
      organizationType: 'claude_team',
      organizationRateLimitTier: 'default_raven',
      userRateLimitTier: 'default_claude_max_5x',
      seatTier: 'team_tier_1',
      billingType: 'stripe_subscription',
      hasExtraUsageEnabled: false,
      profileFetchedAt: 1792968810103,
    });
    const out = runScript(fakeHome).stdout;
    for (const secret of ['alice@acme.test', 'Alice', 'Acme', 'acc-uuid-1']) {
      expect(out).not.toContain(secret);
    }
    expect(plan()).toBe(
      'p=claude_team;r=default_claude_max_5x;s=team_tier_1;b=stripe_subscription;o=0;t=1792968810',
    );
  });

  it('falls back to the org rate-limit tier, and drops a value that is not a token', () => {
    profile({
      organizationType: 'Alice Smith <alice@acme.test>',
      organizationRateLimitTier: 'default_claude_max_20x',
      hasExtraUsageEnabled: true,
    });
    expect(plan()).toBe('r=default_claude_max_20x;o=1');
  });

  it('an API-key login (no oauthAccount) and no profile are both absent; bad JSON is unreadable', () => {
    expect(plan()).toBe('absent');
    profile(undefined);
    expect(plan()).toBe('absent');
    writeFileSync(join(fakeHome, '.claude.json'), '{not json', 'utf8');
    expect(plan()).toBe('unreadable');
    // A profile that exists but cannot be read is not an absence.
    rmSync(join(fakeHome, '.claude.json'));
    mkdirSync(join(fakeHome, '.claude.json'));
    expect(plan()).toBe('unreadable');
  });
});
