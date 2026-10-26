import { chmodSync } from 'node:fs';
import { OTEL_HEADERS_HELPER_KEY } from './constants.js';
import { OTEL_HEADERS_SCRIPT_SOURCE } from './otelHeadersScript.js';
import { otelHeadersScriptPath, spoolScriptPath } from './paths.js';
import { SPOOL_SCRIPT_SOURCE } from './spoolScript.js';
import { writeFileAtomicish } from './settingsFile.js';
import { sha256, writeState, type SetupState } from './state.js';
import type { Plan } from './plan.js';

/**
 * Commit a plan. Callers must have printed `renderDiff(plan)` first and must
 * have cleared every blocker — this function does not re-check them, on purpose:
 * one place decides, one place writes, and they are not the same place.
 */
export function applyPlan(plan: Plan): void {
  if (plan.empty) return;

  // Scripts first: settings.json must never point at a file that is not there yet.
  const scripts: Record<string, string> = {
    [otelHeadersScriptPath()]: OTEL_HEADERS_SCRIPT_SOURCE,
    [spoolScriptPath()]: SPOOL_SCRIPT_SOURCE,
  };
  for (const file of plan.fileAdds) {
    const source = scripts[file];
    if (source === undefined) continue;
    writeFileAtomicish(file, source);
    try {
      chmodSync(file, 0o755);
    } catch {
      // Not fatal — both are invoked via `node`, not as executables.
    }
  }

  writeFileAtomicish(plan.settingsPath, plan.nextText);

  // priorSettingsText must survive re-runs: it is the pre-PROMPTSTER file, not
  // the pre-THIS-RUN file. Overwriting it on a tier-a -> tier-b upgrade would
  // quietly make `--uninstall` restore a state that already had us in it.
  const prior = plan.state ? plan.state.priorSettingsText : plan.loaded.text;

  const envKeys: Record<string, string> = { ...plan.state?.envKeys };
  for (const add of plan.envAdds) envKeys[add.key] = add.value;
  for (const key of plan.envRemoves) delete envKeys[key];

  const hookEvents = new Set<string>(plan.state?.hookEvents ?? []);
  for (const add of plan.hookAdds) hookEvents.add(add.event);

  const state: SetupState = {
    version: 1,
    installedAt: plan.state?.installedAt ?? new Date().toISOString(),
    settingsPath: plan.settingsPath,
    tier: plan.tier,
    envKeys,
    hookEvents: [...hookEvents],
    wroteSpoolScript: plan.tier === 'b' || (plan.state?.wroteSpoolScript ?? false),
    priorSettingsText: prior,
    ...ownedHelper(plan),
    postInstallHash: sha256(plan.nextText),
  };
  writeState(state);
}

function ownedHelper(plan: Plan): Pick<SetupState, 'otelHeadersHelper'> {
  const add = plan.settingAdds.find((a) => a.key === OTEL_HEADERS_HELPER_KEY);
  const value = add?.value ?? plan.state?.otelHeadersHelper;
  return value === undefined ? {} : { otelHeadersHelper: value };
}
