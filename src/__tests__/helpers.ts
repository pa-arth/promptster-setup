import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test in this package runs against a throwaway HOME.
 *
 * Nothing here may ever touch the developer's real ~/.claude — this installer's
 * failure mode is destroying someone's settings, and a test suite that can do
 * that to its own author is not a safety net.
 */
export interface Sandbox {
  home: string;
  cwd: string;
  settings: string;
  codexConfig: string;
  cleanup(): void;
}

const savedHome = process.env.HOME;
const savedManaged = process.env.PROMPTSTER_MANAGED_SETTINGS;
const savedToken = process.env.PROMPTSTER_TOKEN;
const savedEndpoint = process.env.PROMPTSTER_OTLP_ENDPOINT;
const savedCodexHome = process.env.CODEX_HOME;

export function makeSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'promptster-setup-'));
  const cwd = join(home, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  // No managed policy file unless a test writes one.
  process.env.PROMPTSTER_MANAGED_SETTINGS = join(home, 'managed-settings.json');
  delete process.env.PROMPTSTER_TOKEN;
  delete process.env.PROMPTSTER_OTLP_ENDPOINT;

  return {
    home,
    cwd,
    settings: join(home, '.claude', 'settings.json'),
    codexConfig: join(home, '.codex', 'config.toml'),
    cleanup() {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function restoreEnv(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedManaged === undefined) delete process.env.PROMPTSTER_MANAGED_SETTINGS;
  else process.env.PROMPTSTER_MANAGED_SETTINGS = savedManaged;
  if (savedToken === undefined) delete process.env.PROMPTSTER_TOKEN;
  else process.env.PROMPTSTER_TOKEN = savedToken;
  if (savedEndpoint === undefined) delete process.env.PROMPTSTER_OTLP_ENDPOINT;
  else process.env.PROMPTSTER_OTLP_ENDPOINT = savedEndpoint;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readText(path)) as Record<string, unknown>;
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export const TEST_TOKEN = 'psk_live_TESTTOKEN_do_not_log_me';
