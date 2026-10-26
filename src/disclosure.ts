// What we tell the user BEFORE we touch their machine.
//
// This text is pinned by a test fixture on purpose. It is the user-facing
// contract for egress, and it must not drift silently as the implementation
// changes — if the wire behaviour changes, the fixture has to change with it in
// the same commit, which is exactly the review moment we want.

import { DEFAULT_CHOICES, type CaptureChoices } from './constants.js';

/**
 * The load-bearing sentence: tool arguments DO cross the wire, and what the
 * receiver keeps is narrower than what it receives. Anything softer would be a
 * lie of omission, because `OTEL_LOG_TOOL_DETAILS=1` genuinely puts tool input on
 * the wire — the honesty is in naming what is kept and what is dropped.
 */
export const DISCLOSURE_SENTENCE =
  'Tool arguments (the input to Read, Bash, Edit and friends) transit our endpoint. The ' +
  'receiver keeps command lines and file paths, with secrets scrubbed, and line counts of ' +
  'edits; file contents, edit text and command output are DROPPED at that boundary and ' +
  'never written to storage.';

const KEEP_ALWAYS = [
  'session and prompt identifiers, and your Claude Code version',
  'model name, token counts (input, output, cached) and cost per request',
  'tool names, call counts, durations, and success/failure',
  'hook lifecycle events: which event fired, when, and its exit status',
  "each session's git origin URL (credentials stripped) and its folder relative to ~",
  'your Claude plan: plan type, rate-limit tier, seat tier, billing type and whether extra ' +
    'usage is on (never your email, name or account id)',
] as const;

/** What leaves the machine, given the customer's choices. */
export function disclosureFields(choices: CaptureChoices = DEFAULT_CHOICES): string[] {
  return [
    ...KEEP_ALWAYS,
    ...(choices.toolDetails
      ? ['tool arguments — command lines and file paths kept, secrets scrubbed (see below)']
      : []),
    ...(choices.prompts ? ['your prompts (--prompts), secrets scrubbed on arrival'] : []),
    ...(choices.responses ? ["Claude's responses (--responses), code and secrets scrubbed"] : []),
  ];
}

/** What does not, given the customer's choices. */
export function disclosureNotSent(choices: CaptureChoices = DEFAULT_CHOICES): string[] {
  return [
    ...(choices.toolDetails ? [] : ['tool arguments (OTEL_LOG_TOOL_DETAILS is not written)']),
    ...(choices.prompts ? [] : ['your prompts (OTEL_LOG_USER_PROMPTS is not written)']),
    ...(choices.responses
      ? []
      : ["Claude's responses (OTEL_LOG_ASSISTANT_RESPONSES is not written)"]),
    'raw API bodies (OTEL_LOG_RAW_API_BODIES is never written, under any flag)',
    'file contents, diffs, or source code at rest',
  ];
}

export function renderDisclosure(choices: CaptureChoices = DEFAULT_CHOICES): string {
  const lines: string[] = [];
  lines.push('WHAT LEAVES THIS MACHINE');
  for (const f of disclosureFields(choices)) lines.push(`  - ${f}`);
  lines.push('');
  lines.push('WHAT DOES NOT');
  for (const f of disclosureNotSent(choices)) lines.push(`  - ${f}`);
  if (choices.toolDetails) {
    lines.push('');
    lines.push(...wrap(DISCLOSURE_SENTENCE, 88));
  }
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line === '') line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line !== '') out.push(line);
  return out;
}
