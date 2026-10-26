import { rmSync } from 'node:fs';
import { HOOK_MARKER, OTEL_HEADERS_HELPER_KEY, OTEL_HEADERS_HELPER_COMMAND } from './constants.js';
import { otelHeadersScriptPath, settingsPath, spoolScriptPath, statePath } from './paths.js';
import {
  cloneSettings,
  loadSettings,
  serialize,
  writeFileAtomicish,
  type HookGroup,
  type Settings,
} from './settingsFile.js';
import { readState, sha256 } from './state.js';

export type RestoreMode =
  /** settings.json is byte-identical to what we wrote, so the verbatim prior file goes back. */
  | 'verbatim'
  /** The file was edited after we installed. We surgically remove only our own entries. */
  | 'structural'
  /** There was nothing of ours on this machine. */
  | 'nothing';

export interface UninstallResult {
  mode: RestoreMode;
  settingsPath: string;
  removedEnvKeys: string[];
  removedHookEvents: string[];
  /** Top-level settings keys removed (today: only `otelHeadersHelper`). */
  removedSettingKeys: string[];
  removedFiles: string[];
  /** Non-fatal notes worth putting in front of the user. */
  notes: string[];
}

/**
 * Undo an install.
 *
 * The byte-for-byte promise is only honest when we can PROVE the file is
 * untouched since we wrote it — hence the hash gate. If someone edited
 * settings.json after enrolling, restoring our snapshot would silently delete
 * their edit, which is a strictly worse failure than leaving formatting churn
 * behind. So a modified file takes the structural path and says so.
 */
export function uninstall(): UninstallResult {
  const path = settingsPath();
  const state = readState();
  const removedFiles: string[] = [];
  const notes: string[] = [];

  if (!state) {
    const loaded = loadSettings(path);
    const structural = removeOurEntries(loaded.settings, null);
    if (!structural.changed) {
      return {
        mode: 'nothing',
        settingsPath: path,
        removedEnvKeys: [],
        removedHookEvents: [],
        removedSettingKeys: [],
        removedFiles: [],
        notes: ['No promptster install state found and nothing of ours in settings.json.'],
      };
    }
    writeFileAtomicish(path, serialize(structural.settings, loaded));
    notes.push(
      'No install state found, so entries were removed structurally rather than restored byte-for-byte.',
    );
    removedFiles.push(...removeOurFiles());
    return {
      mode: 'structural',
      settingsPath: path,
      removedEnvKeys: structural.removedEnvKeys,
      removedHookEvents: structural.removedHookEvents,
      removedSettingKeys: structural.removedSettingKeys,
      removedFiles,
      notes,
    };
  }

  const loaded = loadSettings(path);
  const currentHash = loaded.text === null ? null : sha256(loaded.text);

  if (currentHash !== null && currentHash === state.postInstallHash) {
    if (state.priorSettingsText === null) {
      // There was no settings.json before us. Removing the file IS the prior state.
      rmSync(path, { force: true });
    } else {
      writeFileAtomicish(path, state.priorSettingsText);
    }
    removedFiles.push(...removeOurFiles());
    rmSync(statePath(), { force: true });
    return {
      mode: 'verbatim',
      settingsPath: path,
      removedEnvKeys: Object.keys(state.envKeys),
      removedHookEvents: state.hookEvents,
      removedSettingKeys: state.otelHeadersHelper !== undefined ? [OTEL_HEADERS_HELPER_KEY] : [],
      removedFiles,
      notes,
    };
  }

  notes.push(
    currentHash === null
      ? 'settings.json is gone; removed our other artifacts only.'
      : 'settings.json changed after install, so it was NOT restored from the snapshot — only our own entries were removed, leaving your later edits intact.',
  );
  const structural = removeOurEntries(
    loaded.settings,
    state.envKeys,
    state.otelHeadersHelper ?? null,
  );
  if (structural.changed) writeFileAtomicish(path, serialize(structural.settings, loaded));
  removedFiles.push(...removeOurFiles());
  rmSync(statePath(), { force: true });
  return {
    mode: 'structural',
    settingsPath: path,
    removedEnvKeys: structural.removedEnvKeys,
    removedHookEvents: structural.removedHookEvents,
    removedSettingKeys: structural.removedSettingKeys,
    removedFiles,
    notes,
  };
}

function removeOurFiles(): string[] {
  const removed: string[] = [];
  for (const file of [spoolScriptPath(), otelHeadersScriptPath()]) {
    try {
      rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // best effort
    }
  }
  return removed;
}

/**
 * Remove exactly our env keys, our hook groups and our `otelHeadersHelper`, and
 * nothing else.
 *
 * `ownedEnv` is value-matched: a key we wrote but the user has since changed is
 * theirs now and stays. Passing null means "no ownership record" — then we can
 * only go by key name, which is the weaker fallback path.
 *
 * `otelHeadersHelper` goes when it equals `ownedHelper` (the value we recorded)
 * or still points at our script; a helper the user swapped in stays.
 */
export function removeOurEntries(
  settings: Settings,
  ownedEnv: Record<string, string> | null,
  ownedHelper: string | null = null,
): {
  settings: Settings;
  changed: boolean;
  removedEnvKeys: string[];
  removedHookEvents: string[];
  removedSettingKeys: string[];
} {
  const next = cloneSettings(settings);
  const removedEnvKeys: string[] = [];
  const removedHookEvents: string[] = [];
  const removedSettingKeys: string[] = [];

  const helper = next[OTEL_HEADERS_HELPER_KEY];
  if (
    typeof helper === 'string' &&
    (helper === ownedHelper || helper === OTEL_HEADERS_HELPER_COMMAND)
  ) {
    delete next[OTEL_HEADERS_HELPER_KEY];
    removedSettingKeys.push(OTEL_HEADERS_HELPER_KEY);
  }

  if (next.env && typeof next.env === 'object') {
    const env = { ...next.env };
    const keys = ownedEnv ? Object.keys(ownedEnv) : [];
    for (const key of keys) {
      if (!(key in env)) continue;
      if (ownedEnv && env[key] !== ownedEnv[key]) continue; // user changed it — leave it
      delete env[key];
      removedEnvKeys.push(key);
    }
    if (removedEnvKeys.length > 0) {
      if (Object.keys(env).length === 0) delete next.env;
      else next.env = env;
    }
  }

  if (next.hooks && typeof next.hooks === 'object') {
    const hooks: Record<string, HookGroup[]> = { ...next.hooks };
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((g) => !isOurGroup(g));
      if (kept.length === groups.length) continue;
      removedHookEvents.push(event);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (removedHookEvents.length > 0) {
      if (Object.keys(hooks).length === 0) delete next.hooks;
      else next.hooks = hooks;
    }
  }

  return {
    settings: next,
    changed:
      removedEnvKeys.length > 0 || removedHookEvents.length > 0 || removedSettingKeys.length > 0,
    removedEnvKeys,
    removedHookEvents,
    removedSettingKeys,
  };
}

function isOurGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER))
  );
}
