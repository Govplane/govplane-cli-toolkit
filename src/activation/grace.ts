import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile, daysElapsed, parseJson, readTextFile, resolveGovplaneHome, stringifyJson,
  type Clock,
} from '@govplane/cli';
import { loadLicense } from './license.js';
import type { ActivationStatus } from './types.js';

/** Days a user may run the toolkit before activation becomes mandatory. */
export const GRACE_DAYS = 30;

export const STATE_FILE = 'state.json';
export const STATE_SCHEMA_VERSION = 1;

export const statePath = (env?: NodeJS.ProcessEnv): string => (
  join(resolveGovplaneHome(env), STATE_FILE)
);

export interface ToolkitState {
  schemaVersion: number;
  /** When a CLI Toolkit command was first run on this machine. */
  toolkitFirstUsedAt: string;
}

const readState = (env?: NodeJS.ProcessEnv): ToolkitState | null => {
  const path = statePath(env);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = parseJson(readTextFile(path));
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      return null;
    }
    const firstUsed = (parsed.value as Record<string, unknown>).toolkitFirstUsedAt;
    if (typeof firstUsed !== 'string' || Number.isNaN(Date.parse(firstUsed))) {
      return null;
    }
    return { schemaVersion: STATE_SCHEMA_VERSION, toolkitFirstUsedAt: firstUsed };
  } catch {
    return null;
  }
};

/**
 * Reads the grace anchor, creating it on first use.
 *
 * The anchor is the first time a CLI Toolkit command ran on this machine, not
 * the install time, so someone who installs the toolkit and comes back two
 * months later still gets a full grace period.
 *
 * It is written once and never rewritten or back-dated. A machine where the
 * anchor cannot be written (a read-only home directory) still gets a usable
 * toolkit: the current time is used, which is the generous reading.
 */
export const anchorFirstUse = (now: Clock, env?: NodeJS.ProcessEnv): Date => {
  const existing = readState(env);
  if (existing !== null) {
    return new Date(existing.toolkitFirstUsedAt);
  }

  const firstUse = now();
  const state: ToolkitState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    toolkitFirstUsedAt: firstUse.toISOString(),
  };

  try {
    atomicWriteFile(statePath(env), stringifyJson(state));
  } catch {
    // Not fatal: the grace period is a courtesy, not an enforcement mechanism.
  }

  return firstUse;
};

export interface ResolveActivationOptions {
  now: Clock;
  env?: NodeJS.ProcessEnv;
  /** Skips creating the anchor — used by read-only status reporting. */
  readOnly?: boolean;
}

/**
 * Resolves the activation state for this invocation.
 *
 * A licence that is present but unusable does not lock the user out: it is
 * reported, and the grace clock decides whether the command may still run.
 */
export const resolveActivation = (options: ResolveActivationOptions): ActivationStatus => {
  const env = options.env ?? process.env;
  const result = loadLicense(env);
  const instant = options.now();

  if (result.ok) {
    const {renewAfter} = result.license;
    return {
      state: 'activated',
      daysRemaining: GRACE_DAYS,
      daysElapsed: 0,
      license: result.license,
      source: result.source,
      renewalDue: renewAfter !== undefined
        && !Number.isNaN(Date.parse(renewAfter))
        && new Date(renewAfter).getTime() <= instant.getTime(),
    };
  }

  const firstUse = options.readOnly === true
    ? (readState(env)?.toolkitFirstUsedAt ?? instant.toISOString())
    : anchorFirstUse(options.now, env).toISOString();

  const elapsed = daysElapsed(new Date(firstUse), instant);
  const remaining = Math.max(0, GRACE_DAYS - elapsed);

  return {
    state: remaining > 0 ? 'grace' : 'grace_expired',
    daysRemaining: remaining,
    daysElapsed: elapsed,
    license: null,
    source: result.source,
    // A missing licence is the normal case and is not worth explaining as a
    // problem; anything else means the user has a file that will not work.
    ...(result.problem === 'LICENSE_NOT_FOUND'
      ? {}
      : { problem: result.problem, problemReason: result.reason }),
    renewalDue: false,
  };
};

/** True when the environment looks like a CI runner. */
export const isContinuousIntegration = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env.CI;
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
};
