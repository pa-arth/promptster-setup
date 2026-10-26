// THE INSTALLER'S BASE MUST RESOLVE TO A ROUTE THE API ACTUALLY SERVES.
//
// `OTEL_EXPORTER_OTLP_ENDPOINT` is a BASE — Claude Code's exporter appends
// `/v1/logs` and `/v1/metrics` itself. So the one string this package writes
// into a user's machine has to compose, character for character, into the paths
// `apps/api/src/routes/team/teams-otel.ts` mounts.
//
// When it doesn't, NOTHING SAYS SO. The exporter POSTs into a 404, drops the
// batch, and reports nothing to the person who ran the installer. The machine
// looks enrolled, the console says capture never started, and there is no error
// anywhere to grep for. The receiver's own docblock carries the warning —
// "getting this wrong means a silent 404 loop inside the exporter" — which is
// how we know the two halves were written by people who understood the risk and
// still drifted apart.
//
// They did drift: this package shipped `https://api.promptster.ai/otel` (never a
// route) while the receiver served `/v1/teams/otel/...`. Probed against prod on
// 2026-07-29: `POST /otel/v1/logs` → 404, `POST /v1/teams/otel/v1/logs` → 401.
// It was caught only because the package had never been published.
//
// The half of that check that needs the receiver lives with the receiver: the
// API (pa-arth/promptster-backend) depends on this package and asserts that
// `${DEFAULT_OTLP_ENDPOINT}/v1/logs` and `/v1/metrics` are the paths it mounts,
// and that the header names in constants.ts are the ones it reads. What stays here is
// everything this package can check about its own constant.

import { describe, it, expect } from 'vitest';
import { DEFAULT_OTLP_ENDPOINT, OUR_ENDPOINT_HOSTS } from '../constants.js';

describe('DEFAULT_OTLP_ENDPOINT', () => {
  it('is a base, not a full signal URL', () => {
    // Appending would double the suffix and 404 just as silently.
    expect(DEFAULT_OTLP_ENDPOINT).not.toMatch(/\/v1\/(logs|metrics)$/);
    expect(DEFAULT_OTLP_ENDPOINT.endsWith('/')).toBe(false);
  });

  it('points at a host we recognise as our own', () => {
    // Otherwise the installer's own foreign-collector guard would refuse to
    // overwrite the endpoint it just wrote.
    const host = new URL(DEFAULT_OTLP_ENDPOINT).hostname;
    expect(OUR_ENDPOINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))).toBe(true);
  });

  it('is https — this carries a bearer token on every batch', () => {
    expect(new URL(DEFAULT_OTLP_ENDPOINT).protocol).toBe('https:');
  });
});
