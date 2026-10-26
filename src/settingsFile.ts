import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A hook command entry, as Claude Code's settings schema defines it. */
export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

/** One matcher group inside a hook event array. */
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

/**
 * Everything we do NOT model stays as an index signature and rides through
 * untouched — statusLine, permissions, model, outputStyle, whatever ships next.
 * A field we cannot name is still a field we must not eat.
 */
export interface Settings {
  env?: Record<string, string>;
  hooks?: Record<string, HookGroup[]>;
  disableAllHooks?: boolean;
  [k: string]: unknown;
}

export interface LoadedSettings {
  /** Raw file text, or null when the file does not exist. */
  readonly text: string | null;
  readonly settings: Settings;
  /** Indent string inferred from the existing file, so a rewrite does not reflow it. */
  readonly indent: string;
  readonly trailingNewline: boolean;
  readonly existed: boolean;
}

export class SettingsParseError extends Error {
  constructor(
    readonly path: string,
    readonly cause2: unknown,
  ) {
    super(
      `${path} is not valid JSON: ${cause2 instanceof Error ? cause2.message : String(cause2)}`,
    );
    this.name = 'SettingsParseError';
  }
}

function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  return m?.[1] ?? '  ';
}

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function loadSettings(path: string): LoadedSettings {
  const text = readTextOrNull(path);
  if (text === null) {
    return { text: null, settings: {}, indent: '  ', trailingNewline: true, existed: false };
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      text,
      settings: {},
      indent: '  ',
      trailingNewline: text.endsWith('\n'),
      existed: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new SettingsParseError(path, err);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsParseError(path, new Error('top level is not an object'));
  }
  return {
    text,
    settings: parsed as Settings,
    indent: detectIndent(text),
    trailingNewline: text.endsWith('\n'),
    existed: true,
  };
}

export function serialize(
  settings: Settings,
  loaded: Pick<LoadedSettings, 'indent' | 'trailingNewline'>,
): string {
  return JSON.stringify(settings, null, loaded.indent) + (loaded.trailingNewline ? '\n' : '');
}

export function writeFileAtomicish(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** Structured clone that survives our plain-JSON settings shape. */
export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}
