import { resolve } from 'node:path';
import {
  CliError, ExitCode, parseJson, readTextFile, summariseBundle,
  type RuntimeBundle,
} from '@govplane/cli';

/**
 * Context assembly and redaction.
 *
 * Context is the evaluation input a policy reads — the request, the user, the
 * risk score. It can carry personal data, so it is redacted on the way out
 * while the real values are used for evaluation.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const invalidContext = (message: string, details?: string[]): CliError => new CliError(message, {
  code: 'INVALID_CONTEXT',
  exitCode: ExitCode.InvalidArguments,
  details,
});

/**
 * Infers the type of a `--context-value key=value` pair.
 *
 * `key:type=value` states the type outright, for the cases where inference is
 * wrong — a postcode that looks like a number, a literal string "true".
 */
export const parseContextValue = (entry: string): [string, unknown] => {
  const separator = entry.indexOf('=');
  if (separator === -1) {
    throw invalidContext(`--context-value must be key=value: ${entry}`, [
      '',
      'For example: --context-value failedAttempts=8',
      'Types can be stated: --context-value postcode:string=28001',
    ]);
  }

  const rawKey = entry.slice(0, separator);
  const raw = entry.slice(separator + 1);
  const typed = rawKey.indexOf(':');
  const key = typed === -1 ? rawKey : rawKey.slice(0, typed);
  const declared = typed === -1 ? undefined : rawKey.slice(typed + 1);

  if (key.trim() === '') {
    throw invalidContext(`--context-value needs a key: ${entry}`);
  }

  if (declared !== undefined) {
    switch (declared) {
      case 'string':
        return [key, raw];
      case 'number': {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw invalidContext(`--context-value ${key} is not a number: ${raw}`);
        }
        return [key, value];
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') {
          throw invalidContext(`--context-value ${key} is not a boolean: ${raw}`);
        }
        return [key, raw === 'true'];
      case 'null':
        return [key, null];
      default:
        throw invalidContext(`Unsupported context value type: ${declared}`, [
          '',
          'Supported types: string, number, boolean, null.',
        ]);
    }
  }

  if (raw === 'true' || raw === 'false') {
    return [key, raw === 'true'];
  }
  if (raw === 'null') {
    return [key, null];
  }
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return [key, Number(raw)];
  }
  return [key, raw];
};

export interface ContextInput {
  inline?: string | undefined;
  file?: string | undefined;
  values: string[];
  cwd: string;
}

/**
 * Builds the context from the command line.
 *
 * The three forms are alternatives, not layers: silently merging an inline
 * object with a file and a handful of `--context-value` pairs would make it
 * genuinely hard to know what a failing scenario actually evaluated.
 */
export const buildContext = (input: ContextInput): Record<string, unknown> | undefined => {
  const supplied = [
    input.inline === undefined ? null : '--context',
    input.file === undefined ? null : '--context-file',
    input.values.length === 0 ? null : '--context-value',
  ].filter((name): name is string => name !== null);

  if (supplied.length > 1) {
    throw invalidContext(`Context was supplied more than one way: ${supplied.join(', ')}.`, [
      '',
      'Use one of --context, --context-file or --context-value, not several.',
    ]);
  }

  if (input.inline !== undefined) {
    const parsed = parseJson(input.inline);
    if (!parsed.ok) {
      throw invalidContext('--context is not valid JSON.', ['', parsed.message]);
    }
    if (!isRecord(parsed.value)) {
      throw invalidContext('--context must be a JSON object.');
    }
    return parsed.value;
  }

  if (input.file !== undefined) {
    const path = resolve(input.cwd, input.file);
    const parsed = parseJson(readTextFile(path));
    if (!parsed.ok) {
      throw invalidContext(`The context file is not valid JSON: ${path}`, ['', parsed.message]);
    }
    if (!isRecord(parsed.value)) {
      throw invalidContext(`The context file must contain a JSON object: ${path}`);
    }
    return parsed.value;
  }

  if (input.values.length > 0) {
    return Object.fromEntries(input.values.map(parseContextValue));
  }

  return undefined;
};

/**
 * The context keys a bundle's rules actually read.
 *
 * Derived from the conditions themselves, so it describes this bundle rather
 * than a general-purpose allow-list.
 */
export const referencedContextKeys = (bundle: RuntimeBundle): string[] => {
  const summary = summariseBundle(bundle);
  const keys = new Set(summary.policies.flatMap((policy) => policy.contextFields));
  return [...keys].sort();
};

/**
 * Flags context keys no rule reads.
 *
 * Advisory, never fatal: an application may pass more context than the current
 * policies happen to use, and simulation should not refuse that. What it does
 * catch is the common failure — `failedAtempts` supplied, `failedAttempts`
 * read, and a decision that looks inexplicably wrong.
 */
export const unusedContextKeys = (
  context: Record<string, unknown>,
  referenced: string[],
): string[] => {
  if (referenced.length === 0) {
    return [];
  }
  const known = new Set(referenced.map((key) => (key.startsWith('ctx.') ? key.slice(4) : key)));
  return Object.keys(context).filter((key) => !known.has(key));
};

export const REDACTED = '[REDACTED]';

/**
 * Masks configured fields for display.
 *
 * Redaction applies to output only — console, traces and reports. The value the
 * engine evaluates is never altered, because a policy that reads `email` has to
 * see the real one to behave as it would in production.
 */
export const redactContext = (
  context: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> => {
  if (fields.length === 0) {
    return context;
  }

  const masked = new Set(fields.map((field) => field.toLowerCase()));
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => (
      masked.has(key.toLowerCase()) ? [key, REDACTED] : [key, value]
    )),
  );
};

/** One line per context entry, for human-readable output. */
export const formatContext = (
  context: Record<string, unknown>,
  fields: string[],
): string[] => {
  const entries = Object.entries(redactContext(context, fields));
  if (entries.length === 0) {
    return ['  (none)'];
  }
  return entries.map(([key, value]) => `  ${key}: ${
    typeof value === 'string' ? value : JSON.stringify(value)
  }`);
};
