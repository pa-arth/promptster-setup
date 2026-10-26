import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { run } from '../cli.js';
import { CODEX_BLOCK_BEGIN } from '../codexConfig.js';
import { EXIT } from '../constants.js';
import { exists, makeSandbox, readText, restoreEnv, TEST_TOKEN, type Sandbox } from './helpers.js';

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

function codex(extra: string[] = []) {
  return run(['--codex', '--token', TEST_TOKEN, ...extra], { cwd: box.cwd });
}

function seedCodexConfig(text: string): void {
  mkdirSync(dirname(box.codexConfig), { recursive: true });
  writeFileSync(box.codexConfig, text, 'utf8');
}

describe('--codex install', () => {
  it('writes a working log-only [otel] block and does not touch Claude Code', () => {
    const result = codex();

    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain('wrote $HOME/.codex/config.toml');
    expect(result.out).not.toContain(TEST_TOKEN);
    expect(exists(box.settings)).toBe(false);

    const config = readText(box.codexConfig);
    expect(config).toContain('[otel]');
    expect(config).toContain('log_user_prompt = false');
    expect(config).toContain('exporter = { otlp-http =');
    expect(config).toContain('protocol = "json"');
    expect(config).toContain(`Authorization = "Bearer ${TEST_TOKEN}"`);
    expect(config).not.toMatch(/^metrics_exporter\s*=/m);
  });

  it('--print shows a redacted plan and writes nothing', () => {
    const result = codex(['--print']);

    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain('Codex plan for $HOME/.codex/config.toml');
    expect(result.out).toContain('Bearer ***redacted***');
    expect(result.out).not.toContain(TEST_TOKEN);
    expect(result.out).toContain('--print: nothing was written');
    expect(exists(box.codexConfig)).toBe(false);
  });

  it('is idempotent and rotates the token in its own single block', () => {
    expect(codex().code).toBe(EXIT.OK);
    const first = readText(box.codexConfig);

    const second = codex();
    expect(second.code).toBe(EXIT.OK);
    expect(second.out).toContain('(no changes — Codex is already enrolled)');
    expect(readText(box.codexConfig)).toBe(first);

    const rotated = run(['--codex', '--token', 'psk_live_ROTATED'], { cwd: box.cwd });
    expect(rotated.code).toBe(EXIT.OK);
    const config = readText(box.codexConfig);
    expect(config).toContain('Bearer psk_live_ROTATED');
    expect(config).not.toContain(TEST_TOKEN);
    expect(config.split(CODEX_BLOCK_BEGIN)).toHaveLength(2);
  });

  it('preserves existing Codex settings when it appends its block', () => {
    const existing = [
      'model = "gpt-5.6-sol"',
      '',
      '[projects."/work/repo"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    seedCodexConfig(existing);

    expect(codex().code).toBe(EXIT.OK);
    const config = readText(box.codexConfig);
    expect(config).toContain(existing);
    expect(config).toContain(CODEX_BLOCK_BEGIN);
  });

  it('refuses a foreign [otel] section without changing the file', () => {
    const existing = '[otel]\nenvironment = "acme"\nexporter = { otlp-grpc = {} }\n';
    seedCodexConfig(existing);

    const result = codex();
    expect(result.code).toBe(EXIT.FOREIGN_ENDPOINT);
    expect(result.out).toContain('already has an [otel] section');
    expect(result.out).toContain('nothing written');
    expect(readText(box.codexConfig)).toBe(existing);
  });

  it('rejects Claude-only --tier instead of silently ignoring it', () => {
    const result = codex(['--tier', 'a']);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.out).toContain('--tier applies to Claude Code only');
    expect(exists(box.codexConfig)).toBe(false);
  });
});

describe('--codex --uninstall', () => {
  it('needs no token and removes only our block', () => {
    const existing = 'model = "gpt-5.6-sol"\n';
    seedCodexConfig(existing);
    expect(codex().code).toBe(EXIT.OK);

    const result = run(['--codex', '--uninstall'], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain('removed our [otel] block');
    expect(readText(box.codexConfig)).toBe(existing);
  });

  it('removes config.toml when the Promptster block was the whole file', () => {
    expect(codex().code).toBe(EXIT.OK);
    expect(exists(box.codexConfig)).toBe(true);

    expect(run(['--codex', '--uninstall'], { cwd: box.cwd }).code).toBe(EXIT.OK);
    expect(exists(box.codexConfig)).toBe(false);
  });

  it('is a no-op when Codex was never enrolled', () => {
    const result = run(['--codex', '--uninstall'], { cwd: box.cwd });
    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain('(nothing to undo)');
  });
});

describe('codex capture choices', () => {
  it('exports prompt text only with --prompts', () => {
    codex();
    expect(readText(box.codexConfig)).toContain('log_user_prompt = false');
    codex(['--prompts']);
    expect(readText(box.codexConfig)).toContain('log_user_prompt = true');
    codex();
    expect(readText(box.codexConfig)).toContain('log_user_prompt = false');
  });

  it('previews the prompt switch it will write', () => {
    expect(codex(['--prompts', '--print']).out).toContain('log_user_prompt = true');
    expect(codex(['--print']).out).toContain('log_user_prompt = false');
  });

  it('refuses Claude-only switches', () => {
    expect(codex(['--responses']).out).toContain('Claude Code only');
    expect(codex(['--no-tool-details']).out).toContain('Claude Code only');
  });
});
