import {
  CHOICE_ENV_KEYS,
  DEFAULT_CHOICES,
  type CaptureChoices,
  ENDPOINT_ENV_KEY,
  HEADERS_ENV_KEY,
  HOOK_MARKER,
  OTEL_HEADERS_HELPER_COMMAND,
  OTEL_HEADERS_HELPER_KEY,
  OUR_ENDPOINT_HOSTS,
  STATIC_ENV,
  TIER_B_EVENTS,
  spoolCommandFor,
} from './constants.js';
import {
  cloneSettings,
  loadSettings,
  readTextOrNull,
  serialize,
  type HookGroup,
  type LoadedSettings,
  type Settings,
} from './settingsFile.js';
import {
  localSettingsPath,
  managedSettingsPath,
  otelHeadersScriptPath,
  projectSettingsPaths,
  settingsPath,
  spoolScriptPath,
} from './paths.js';
import { OTEL_HEADERS_SCRIPT_SOURCE } from './otelHeadersScript.js';
import { SPOOL_SCRIPT_SOURCE } from './spoolScript.js';
import { ownsEnvKey, ownsHeadersHelper, readState, type SetupState } from './state.js';

export type Tier = 'a' | 'b';

export interface PlanOptions {
  tier: Tier;
  token: string;
  endpoint: string;
  cwd: string;
  /** What the customer chose to export. Defaults to DEFAULT_CHOICES. */
  choices?: CaptureChoices;
}

export interface EnvChange {
  key: string;
  /** The real value, written to disk. */
  value: string;
  /** What the diff prints. Secrets are redacted here and only here. */
  display: string;
  previous: string | null;
}

export interface EnvConflict {
  key: string;
  existing: string;
  ours: string;
}

export interface HookChange {
  event: string;
  matcher: string | null;
  command: string;
  /** true when an entry of ours already existed for this event and only the command changed. */
  updatedInPlace: boolean;
}

/** A top-level settings key we own (today: only `otelHeadersHelper`). */
export interface SettingChange {
  key: string;
  value: string;
  previous: string | null;
}

export interface SettingConflict {
  key: string;
  /** JSON-rendered existing value — it need not be a string. */
  existing: string;
  ours: string;
}

export interface HooksDisabled {
  /** Which settings file turned hooks off machine-wide. */
  source: string;
}

export interface Plan {
  settingsPath: string;
  loaded: LoadedSettings;
  tier: Tier;
  endpoint: string;
  envAdds: EnvChange[];
  /** Choice keys we wrote earlier that this run's choices turn off. */
  envRemoves: string[];
  envConflicts: EnvConflict[];
  hookAdds: HookChange[];
  /** Top-level settings keys we would add or update (`otelHeadersHelper`). */
  settingAdds: SettingChange[];
  /** A top-level settings key already set to a value we did not write. Blocks the run. */
  settingConflicts: SettingConflict[];
  /** Absolute paths of files we would create/replace outside settings.json. */
  fileAdds: string[];
  /** Set when an existing OTLP endpoint is not ours. Blocks the run. */
  foreignEndpoint: string | null;
  hooksDisabled: HooksDisabled | null;
  next: Settings;
  nextText: string;
  state: SetupState | null;
  /** True when there is nothing at all to do. The idempotency contract. */
  empty: boolean;
}

export function redactHeaderValue(headerValue: string): string {
  return headerValue.replace(/Bearer\s+\S+/i, 'Bearer ***redacted***');
}

export function ourEnv(
  opts: Pick<PlanOptions, 'token' | 'endpoint' | 'choices'>,
): Record<string, string> {
  const choices = opts.choices ?? DEFAULT_CHOICES;
  const chosen = Object.fromEntries(
    (Object.keys(CHOICE_ENV_KEYS) as (keyof CaptureChoices)[])
      .filter((c) => choices[c])
      .map((c) => [CHOICE_ENV_KEYS[c], '1']),
  );
  return {
    ...STATIC_ENV,
    ...chosen,
    [ENDPOINT_ENV_KEY]: opts.endpoint,
    [HEADERS_ENV_KEY]: `Authorization=Bearer ${opts.token}`,
  };
}

/** Which choice switches a settings `env` turns on — from the file, whoever wrote them. */
export function effectiveChoices(env: Record<string, unknown> | undefined): CaptureChoices {
  const on = (key: string) => {
    const v = env?.[key];
    return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  };
  return {
    toolDetails: on(CHOICE_ENV_KEYS.toolDetails),
    prompts: on(CHOICE_ENV_KEYS.prompts),
    responses: on(CHOICE_ENV_KEYS.responses),
  };
}

export function isOurEndpoint(value: string, configured: string): boolean {
  if (value === configured) return true;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  let configuredHost: string | null = null;
  try {
    configuredHost = new URL(configured).hostname.toLowerCase();
  } catch {
    configuredHost = null;
  }
  if (configuredHost !== null && host === configuredHost) return true;
  return OUR_ENDPOINT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * `disableAllHooks` can land from five places and any ONE of them kills tier B.
 * We check all five rather than only the file we are about to write, because
 * "we wrote the hooks so it works" is precisely the false success this guard exists
 * to prevent — the managed policy file is the common case and we do not own it.
 */
export function findHooksDisabled(cwd: string): HooksDisabled | null {
  const managed = managedSettingsPath();
  const candidates = [
    ...(managed ? [managed] : []),
    settingsPath(),
    localSettingsPath(),
    ...projectSettingsPaths(cwd),
  ];
  for (const path of candidates) {
    const raw = readTextOrNull(path);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as Settings;
      if (parsed?.disableAllHooks === true) return { source: path };
    } catch {
      // A neighbouring settings file being unparseable is not our problem to solve
      // here; the one we are writing is validated separately and hard-fails.
      continue;
    }
  }
  return null;
}

// Exact match only: a user's wrapper around our script (`… && node
// "$HOME/.promptster/otel-headers.mjs"`) is theirs, and replacing it would drop
// whatever headers it adds.
function isOurHeadersHelper(state: SetupState | null, value: string): boolean {
  return ownsHeadersHelper(state, value) || value === OTEL_HEADERS_HELPER_COMMAND;
}

function groupIsOurs(group: HookGroup): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER))
  );
}

export function buildPlan(opts: PlanOptions): Plan {
  const path = settingsPath();
  const loaded = loadSettings(path);
  const state = readState();
  const next = cloneSettings(loaded.settings);
  const desired = ourEnv(opts);

  const existingEnv: Record<string, string> = { ...next.env };

  // ---- Coexistence: a foreign collector is a conversation, not a conflict to win.
  const currentEndpoint = existingEnv[ENDPOINT_ENV_KEY];
  const foreignEndpoint =
    typeof currentEndpoint === 'string' &&
    currentEndpoint.trim() !== '' &&
    !isOurEndpoint(currentEndpoint, opts.endpoint)
      ? currentEndpoint
      : null;

  // ---- Env: add what is missing, refuse what is not ours.
  const envAdds: EnvChange[] = [];
  const envConflicts: EnvConflict[] = [];
  for (const [key, value] of Object.entries(desired)) {
    const existing = existingEnv[key];
    if (existing === value) continue; // already exactly right — idempotent no-op
    if (existing !== undefined && !ownsEnvKey(state, key, existing)) {
      // The endpoint case is reported as coexistence, not as a generic conflict.
      if (key === ENDPOINT_ENV_KEY && foreignEndpoint !== null) continue;
      envConflicts.push({ key, existing, ours: value });
      continue;
    }
    envAdds.push({
      key,
      value,
      display: key === HEADERS_ENV_KEY ? redactHeaderValue(value) : value,
      previous: existing ?? null,
    });
  }

  // ---- Choices turned off: remove a choice key only if WE wrote it and nobody
  // has changed it since. A value the user set themselves is theirs to keep.
  const envRemoves = Object.values(CHOICE_ENV_KEYS).filter((key) => {
    if (key in desired) return false;
    const existing = existingEnv[key];
    return existing !== undefined && ownsEnvKey(state, key, existing);
  });

  // ---- Hooks: append, never replace.
  const hookAdds: HookChange[] = [];
  if (opts.tier === 'b') {
    const hooks: Record<string, HookGroup[]> = { ...next.hooks };
    for (const { event, matcher } of TIER_B_EVENTS) {
      const command = spoolCommandFor(event);
      const existingGroups = Array.isArray(hooks[event]) ? [...(hooks[event] as HookGroup[])] : [];
      const ourIndex = existingGroups.findIndex((g) => groupIsOurs(g));
      if (ourIndex >= 0) {
        const ours = existingGroups[ourIndex] as HookGroup;
        const already = ours.hooks.some((h) => h.command === command);
        if (already) continue;
        const updated: HookGroup = {
          ...ours,
          hooks: ours.hooks.map((h) =>
            typeof h.command === 'string' && h.command.includes(HOOK_MARKER)
              ? { ...h, command }
              : h,
          ),
        };
        existingGroups[ourIndex] = updated;
        hooks[event] = existingGroups;
        hookAdds.push({ event, matcher, command, updatedInPlace: true });
        continue;
      }
      const group: HookGroup =
        matcher === null
          ? { hooks: [{ type: 'command', command }] }
          : { matcher, hooks: [{ type: 'command', command }] };
      // PUSH. The user's own groups keep their index and their contents.
      existingGroups.push(group);
      hooks[event] = existingGroups;
      hookAdds.push({ event, matcher, command, updatedInPlace: false });
    }
    if (hookAdds.length > 0) next.hooks = hooks;
  }

  // ---- otelHeadersHelper: one key, ours or a conflict. Same rule as env keys:
  // a value we wrote (state-recorded, or recognisably our script) may be
  // rewritten; someone else's helper is never replaced.
  const settingAdds: SettingChange[] = [];
  const settingConflicts: SettingConflict[] = [];
  {
    const key = OTEL_HEADERS_HELPER_KEY;
    const ours = OTEL_HEADERS_HELPER_COMMAND;
    const existing = next[key];
    if (existing !== ours) {
      if (existing === undefined) {
        settingAdds.push({ key, value: ours, previous: null });
      } else if (typeof existing === 'string' && isOurHeadersHelper(state, existing)) {
        settingAdds.push({ key, value: ours, previous: existing });
      } else {
        settingConflicts.push({ key, existing: JSON.stringify(existing), ours });
      }
    }
    for (const add of settingAdds) next[add.key] = add.value;
  }

  // ---- Apply env into the candidate object.
  if (envAdds.length > 0 || envRemoves.length > 0) {
    const env = { ...next.env };
    for (const add of envAdds) env[add.key] = add.value;
    for (const key of envRemoves) delete env[key];
    next.env = env;
  }

  // ---- Files we own outside settings.json.
  const fileAdds: string[] = [];
  if (readTextOrNull(otelHeadersScriptPath()) !== OTEL_HEADERS_SCRIPT_SOURCE) {
    fileAdds.push(otelHeadersScriptPath());
  }
  if (opts.tier === 'b') {
    const current = readTextOrNull(spoolScriptPath());
    if (current !== SPOOL_SCRIPT_SOURCE) fileAdds.push(spoolScriptPath());
  }

  const hooksDisabled = opts.tier === 'b' ? findHooksDisabled(opts.cwd) : null;

  return {
    settingsPath: path,
    loaded,
    tier: opts.tier,
    endpoint: opts.endpoint,
    envAdds,
    envRemoves,
    envConflicts,
    hookAdds,
    settingAdds,
    settingConflicts,
    fileAdds,
    foreignEndpoint,
    hooksDisabled,
    next,
    nextText: serialize(next, loaded),
    state,
    empty:
      envAdds.length === 0 &&
      envRemoves.length === 0 &&
      hookAdds.length === 0 &&
      settingAdds.length === 0 &&
      fileAdds.length === 0,
  };
}
