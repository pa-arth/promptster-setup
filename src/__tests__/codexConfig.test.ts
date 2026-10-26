import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_BLOCK_BEGIN,
  CODEX_DISCLOSURE_LINES,
  planCodex,
  renderCodexOtelBlock,
  uninstallCodex,
} from '../codexConfig.js';
import { codexConfigPath } from '../paths.js';
import { DEFAULT_OTLP_ENDPOINT } from '../constants.js';

/**
 * §8.2 — the Codex half of enrollment.
 *
 * The shape asserted here is not invented: `[otel]` with `log_user_prompt`,
 * `environment`, and an `exporter = { otlp-http = { endpoint, protocol, headers } }`
 * is the shape that ACTUALLY EXPORTED during the §1.9 capture, and the key/enum
 * names were read out of codex 0.145.0's own serde types (`OtelConfigToml`,
 * `OtelExporterKind`, `OtelHttpProtocol`) rather than from documentation.
 */

let home: string;
let codexHome: string;
const ENV = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'promptster-codex-'));
  codexHome = join(home, '.codex');
  // Isolate BOTH: a bare HOME would still be a real developer's home on a machine
  // where CODEX_HOME is unset, and this suite must never read or write that.
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  process.env.HOME = ENV.HOME;
  if (ENV.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ENV.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

const OPTS = { endpoint: DEFAULT_OTLP_ENDPOINT, token: 'tok-abc123' };

describe('codex config — the block we write', () => {
  it('honours CODEX_HOME, so no test can touch a real ~/.codex', () => {
    expect(codexConfigPath()).toBe(join(codexHome, 'config.toml'));
  });

  it('turns prompt text off explicitly rather than relying on a default', () => {
    // Verified on the wire during §1.9: with this false, codex.user_prompt shipped
    // prompt='[REDACTED]' and kept prompt_length=159. Relying on the default would
    // make our egress claim depend on a value we do not control.
    expect(renderCodexOtelBlock(OPTS)).toContain('log_user_prompt = false');
  });

  it('configures the LOG exporter and NO metrics exporter (§8.1b)', () => {
    const block = renderCodexOtelBlock(OPTS);
    expect(block).toContain('exporter = { otlp-http =');
    expect(block).toContain('protocol = "json"');
    // The measured reason: 0/161 metric datapoints carried user.email,
    // user.account_id or conversation.id, while 37/40 log records carried all
    // three — so the metric channel is unattributable AND redundant.
    expect(block).not.toMatch(/^metrics_exporter\s*=/m);
    expect(block).not.toMatch(/^trace_exporter\s*=/m);
  });

  it('never writes a prompt-capture key, under any option', () => {
    const block = renderCodexOtelBlock(OPTS);
    expect(block).not.toContain('log_user_prompt = true');
  });
});

describe('codex config — planning against an existing file', () => {
  it('creates the file when there is none', () => {
    const plan = planCodex(null, OPTS);
    expect(plan.foreignOtel).toBe(false);
    expect(plan.next).toContain(CODEX_BLOCK_BEGIN);
    expect(plan.next).toContain('log_user_prompt = false');
  });

  it("APPENDS — a user's existing settings survive untouched", () => {
    // The highest-consequence failure in the section. Silently dropping someone's
    // model choice or a [projects.*] trust entry is unrecoverable and invisible.
    const existing = [
      'model = "gpt-5.6-sol"',
      'approvals_reviewer = "auto_review"',
      '',
      '[projects."/Users/engineer/repo"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const plan = planCodex(existing, OPTS);
    expect(plan.next).toContain('model = "gpt-5.6-sol"');
    expect(plan.next).toContain('approvals_reviewer = "auto_review"');
    expect(plan.next).toContain('[projects."/Users/engineer/repo"]');
    expect(plan.next).toContain('trust_level = "trusted"');
    expect(plan.next).toContain(CODEX_BLOCK_BEGIN);
  });

  it('is idempotent — a second run changes nothing', () => {
    const first = planCodex(null, OPTS).next!;
    expect(planCodex(first, OPTS).next).toBeNull();
    // And a third, from the same state.
    expect(planCodex(first, OPTS).next).toBeNull();
  });

  it('replaces its OWN block rather than stacking a second copy', () => {
    const first = planCodex(null, OPTS).next!;
    const rotated = planCodex(first, { ...OPTS, token: 'tok-rotated' });
    expect(rotated.replacingOurBlock).toBe(true);
    expect(rotated.next).toContain('tok-rotated');
    expect(rotated.next).not.toContain('tok-abc123');
    expect(countOccurrences(rotated.next!, CODEX_BLOCK_BEGIN)).toBe(1);
  });

  it('REFUSES a foreign [otel] section instead of hijacking it', () => {
    // Codex takes ONE exporter. Writing ours over an existing [otel] would
    // silently redirect telemetry the user or their employer already set up.
    const existing = '[otel]\nenvironment = "acme-corp"\nexporter = { otlp-grpc = {} }\n';
    const plan = planCodex(existing, OPTS);
    expect(plan.foreignOtel).toBe(true);
    expect(plan.next).toBeNull();
  });

  it('does not mistake its own block for a foreign one on a re-run', () => {
    // The bug this guards: strip-ours-then-detect-foreign, done in the wrong
    // order, makes every second run refuse.
    const first = planCodex(null, OPTS).next!;
    expect(planCodex(first, { ...OPTS, token: 'tok-2' }).foreignOtel).toBe(false);
  });
});

describe('codex config — uninstall', () => {
  it('removes our block and leaves the rest byte-identical', () => {
    const user = 'model = "gpt-5.6-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    const installed = planCodex(user, OPTS).next!;
    const removed = uninstallCodex(installed);
    expect(removed).not.toContain(CODEX_BLOCK_BEGIN);
    expect(removed).toBe(user);
  });

  it('is a no-op when we were never installed', () => {
    expect(uninstallCodex('model = "gpt-5.6-sol"\n')).toBeNull();
    expect(uninstallCodex(null)).toBeNull();
  });
});

describe('codex disclosure', () => {
  it('names the tool_result body, which is the actual egress story', () => {
    const text = CODEX_DISCLOSURE_LINES.join('\n');
    expect(text).toContain('codex.tool_result');
    expect(text).toContain('apply_patch');
    // The trap this exists to avoid: saying "prompts aren't sent" and stopping.
    // True, and beside the point — log_user_prompt does not gate patch bodies.
    expect(text).toContain('does not gate');
  });

  it('claims we do not COLLECT Codex metrics, never that Codex metrics are off', () => {
    const text = CODEX_DISCLOSURE_LINES.join('\n');
    // The claim we can now MAKE. §8.2b was settled by measurement on 2026-07-27:
    // codex 0.145.0 with `metrics_exporter` omitted sent 9 OTLP batches over a
    // real session, all `resourceLogs`, ZERO metric datapoints. With the key set,
    // the §1.9 capture took 296. So this is a fact about us, and it is measured.
    expect(text).toContain('We do not collect Codex metrics');

    // The claim we still CANNOT make, and the reason is stronger than "we did not
    // look". The binary hard-codes `https://ab.chatgpt.com/otlp/v1/metrics` beside
    // a statsig client key and carries `statsig` as an OtelExporterKind — an
    // OpenAI-owned metrics channel our config does not reach. Whether it fires by
    // default is unmeasurable from outside: ab.chatgpt.com and chatgpt.com share
    // Cloudflare IPs, so connection-level observation cannot tell metrics from
    // ordinary model traffic without SNI inspection.
    //
    // So this is not "hedge until we check". There is a channel we do not control
    // and cannot see, and copy that implied otherwise would be a privacy claim we
    // have no standing to make.
    expect(text).not.toMatch(/metrics are off|no metrics are (sent|emitted)/i);
    // …and we must not imply we could switch them off either.
    expect(text).not.toMatch(/(disable|turn(ing)? off|opt out of).{0,20}metrics/i);
  });

  it('states the admin-enrollment asymmetry instead of burying it', () => {
    expect(CODEX_DISCLOSURE_LINES.join('\n')).toContain('No admin can enroll Codex');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
