import { createHash } from 'node:crypto';
import { readTextOrNull, writeFileAtomicish } from './settingsFile.js';
import { statePath } from './paths.js';

/**
 * Bookkeeping for what THIS installer put on the machine.
 *
 * Two jobs, and both are safety rather than convenience:
 *   - ownership: an env key we wrote may be rewritten; one we did not, may not.
 *   - restore: `priorSettingsText` is the verbatim pre-install file, which is the
 *     only thing that can make `--uninstall` byte-for-byte. A structural
 *     removal cannot promise that — JSON round-trips lose formatting.
 */
export interface SetupState {
  version: 1;
  installedAt: string;
  settingsPath: string;
  tier: 'a' | 'b';
  /** key -> the exact value we wrote. Ownership is by value, so user edits revoke it. */
  envKeys: Record<string, string>;
  hookEvents: string[];
  wroteSpoolScript: boolean;
  /**
   * The exact `otelHeadersHelper` value we wrote, or absent. Optional so a state
   * file from before the helper existed still reads as version 1.
   */
  otelHeadersHelper?: string;
  /** Verbatim settings.json from before our FIRST install. null = the file did not exist. */
  priorSettingsText: string | null;
  /** sha256 of the settings.json text we last wrote — proof nobody edited it since. */
  postInstallHash: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function readState(): SetupState | null {
  const raw = readTextOrNull(statePath());
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SetupState;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(state: SetupState): void {
  writeFileAtomicish(statePath(), JSON.stringify(state, null, 2) + '\n');
}

/** True when we wrote `key` and nobody has changed it since. */
export function ownsEnvKey(state: SetupState | null, key: string, currentValue: string): boolean {
  if (!state) return false;
  const recorded = state.envKeys[key];
  return recorded !== undefined && recorded === currentValue;
}

/** True when we wrote this `otelHeadersHelper` value and nobody has changed it since. */
export function ownsHeadersHelper(state: SetupState | null, currentValue: string): boolean {
  return state?.otelHeadersHelper !== undefined && state.otelHeadersHelper === currentValue;
}
