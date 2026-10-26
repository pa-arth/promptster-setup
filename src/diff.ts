import { displayPath } from './paths.js';
import type { Plan } from './plan.js';

/**
 * The diff is the whole user-facing contract of this installer: it is printed
 * BEFORE any write, on every path including the real one, and `--print` is
 * nothing more than "render this and stop". There is deliberately no code path
 * that writes without producing this text first.
 *
 * Output is machine-home-independent (paths render as $HOME/...) so it can be
 * pinned by a golden file and compared across machines.
 */
export function renderDiff(plan: Plan): string {
  const out: string[] = [];
  out.push(`promptster setup — plan for ${displayPath(plan.settingsPath)}`);
  out.push(
    `tier: ${plan.tier.toUpperCase()} ${plan.tier === 'a' ? '(telemetry only, no hooks)' : '(telemetry + hooks)'}`,
  );
  out.push('');

  if (plan.empty) {
    out.push('  (no changes — this machine is already enrolled)');
    return out.join('\n');
  }

  if (plan.envAdds.length > 0 || plan.envRemoves.length > 0) {
    out.push('env');
    const width = Math.max(
      ...plan.envAdds.map((e) => e.key.length),
      ...plan.envRemoves.map((k) => k.length),
    );
    for (const add of plan.envAdds) {
      const sign = add.previous === null ? '+' : '~';
      out.push(`  ${sign} ${add.key.padEnd(width)} = ${add.display}`);
    }
    for (const key of plan.envRemoves) out.push(`  - ${key}`);
    out.push('');
  }

  if (plan.hookAdds.length > 0) {
    out.push('hooks');
    const width = Math.max(...plan.hookAdds.map((h) => h.event.length));
    const matcherWidth = Math.max(
      ...plan.hookAdds.map((h) => (h.matcher === null ? 0 : `matcher=${h.matcher}`.length)),
    );
    for (const add of plan.hookAdds) {
      const sign = add.updatedInPlace ? '~' : '+';
      const matcher = (add.matcher === null ? '' : `matcher=${add.matcher}`).padEnd(matcherWidth);
      const gap = matcherWidth > 0 ? ' ' + matcher : '';
      out.push(`  ${sign} ${add.event.padEnd(width)}${gap} -> ${add.command}`);
    }
    out.push('  (appended — every hook already in this file keeps its place and its contents)');
    out.push('');
  }

  if (plan.settingAdds.length > 0) {
    out.push('settings');
    const width = Math.max(...plan.settingAdds.map((a) => a.key.length));
    for (const add of plan.settingAdds) {
      const sign = add.previous === null ? '+' : '~';
      out.push(`  ${sign} ${add.key.padEnd(width)} = ${add.value}`);
    }
    out.push('');
  }

  if (plan.fileAdds.length > 0) {
    out.push('files');
    for (const f of plan.fileAdds) out.push(`  + ${displayPath(f)}`);
    out.push('');
  }

  out.push('nothing else in settings.json is read, moved, or rewritten.');
  return out.join('\n');
}
