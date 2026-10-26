import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import {
  OTEL_HEADERS_SCRIPT_NAME,
  PROMPTSTER_DIR_NAME,
  SPOOL_SCRIPT_NAME,
  STATE_FILE_NAME,
} from './constants.js';

/**
 * Resolve HOME on every call — never at module load.
 *
 * The tests point `process.env.HOME` at a tmpdir, and a module-level constant
 * would freeze the real home into the first import and write to the developer's
 * actual ~/.claude. Cheap call, load-bearing property.
 */
export function home(): string {
  return process.env.HOME || homedir();
}

export function claudeDir(): string {
  return join(home(), '.claude');
}

export function settingsPath(): string {
  return join(claudeDir(), 'settings.json');
}

export function localSettingsPath(): string {
  return join(claudeDir(), 'settings.local.json');
}

export function promptsterDir(): string {
  return join(home(), PROMPTSTER_DIR_NAME);
}

export function spoolScriptPath(): string {
  return join(promptsterDir(), SPOOL_SCRIPT_NAME);
}

export function otelHeadersScriptPath(): string {
  return join(promptsterDir(), OTEL_HEADERS_SCRIPT_NAME);
}

export function statePath(): string {
  return join(promptsterDir(), STATE_FILE_NAME);
}

/**
 * Managed (admin-pushed) settings, which can set disableAllHooks for the whole machine.
 *
 * Overridable so tests can point at a tmpdir: without the override a test run on
 * a managed laptop would read the REAL policy file, and the suite's result would
 * depend on the machine it ran on.
 */
export function managedSettingsPath(): string | null {
  const override = process.env.PROMPTSTER_MANAGED_SETTINGS;
  if (override !== undefined) return override === '' ? null : override;
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
}

/**
 * Codex's config file. `CODEX_HOME` is a real, honoured env var (the binary's own
 * `--help` references `$CODEX_HOME/<name>.config.toml`), which is what let the
 * §1.9 capture run against an isolated config instead of the user's live one —
 * and it is what lets these tests run without touching a developer's real Codex.
 *
 * §8.2: there is NO admin push for this. Claude Code has server-managed settings;
 * Codex has a file in a home directory and nothing that distributes it. An admin
 * cannot enroll a Codex fleet, so this is a second per-machine write and that
 * asymmetry belongs on the install page, not in a footnote.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(home(), '.codex');
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function projectSettingsPaths(cwd: string): string[] {
  return [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
}

/**
 * Render a path with the home prefix collapsed to `$HOME`, so printed output
 * (and therefore the checked-in golden file) does not embed a machine's home.
 */
export function displayPath(p: string): string {
  const h = home();
  if (p === h) return '$HOME';
  if (p.startsWith(h + sep))
    return (
      '$HOME/' +
      p
        .slice(h.length + 1)
        .split(sep)
        .join('/')
    );
  return p;
}
