import { spawn } from 'node:child_process';
import type { Clock } from '@govplane/cli';
import { postJson, resolveApiUrl, type FetchLike } from '../http/client.js';

export const START_PATH = '/v1/activation/device/start';
export const POLL_PATH = '/v1/activation/device/poll';

export const CLIENT_NAME = 'govplane-toolkit';
export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_EXPIRY_SECONDS = 600;
/** Added to the polling interval each time the service asks us to slow down. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type StartOutcome =
  | { ok: true; start: DeviceStart }
  | { ok: false; reason: string };

export type PollOutcome =
  | { status: 'activated'; license: unknown }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'unreachable'; reason: string };

export interface DeviceFlowDeps {
  now: Clock;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Injected so tests do not wait in real time. */
  sleep?: (milliseconds: number) => Promise<void>;
}

const realSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readPositive = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

/**
 * Opens the activation page.
 *
 * The request body carries only the client name and version. Nothing about the
 * machine, the user or the project is transmitted — the specification is
 * explicit about this, and the payload below is the whole of it.
 */
export const startDeviceActivation = async (
  clientVersion: string,
  deps: DeviceFlowDeps,
): Promise<StartOutcome> => {
  const base = resolveApiUrl(deps.env);
  const response = await postJson(
    `${base}${START_PATH}`,
    { client: CLIENT_NAME, clientVersion },
    { ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) },
  );

  if (response.error !== undefined) {
    return { ok: false, reason: response.error };
  }
  if (!response.ok) {
    return { ok: false, reason: `The activation service responded with status ${response.status}.` };
  }
  if (!isRecord(response.body)) {
    return { ok: false, reason: 'The activation service returned an unexpected response.' };
  }

  const {body} = response;
  const {deviceCode} = body;
  const {userCode} = body;
  const {verificationUri} = body;

  if (typeof deviceCode !== 'string' || typeof userCode !== 'string'
    || typeof verificationUri !== 'string') {
    return { ok: false, reason: 'The activation service returned an incomplete response.' };
  }

  return {
    ok: true,
    start: {
      deviceCode,
      userCode,
      verificationUri,
      ...(typeof body.verificationUriComplete === 'string'
        ? { verificationUriComplete: body.verificationUriComplete }
        : {}),
      intervalSeconds: readPositive(body.interval, DEFAULT_INTERVAL_SECONDS),
      expiresInSeconds: readPositive(body.expiresIn, DEFAULT_EXPIRY_SECONDS),
    },
  };
};

/**
 * Polls until the user approves, declines, or the request expires.
 *
 * The service-provided interval is honoured, and a `slow_down` response widens
 * it — a client that ignores back-pressure is a client that gets rate limited.
 */
export const pollForLicense = async (
  start: DeviceStart,
  deps: DeviceFlowDeps,
): Promise<PollOutcome> => {
  const base = resolveApiUrl(deps.env);
  const sleep = deps.sleep ?? realSleep;
  const deadline = deps.now().getTime() + start.expiresInSeconds * 1000;
  let {intervalSeconds} = start;

  for (;;) {
    if (deps.now().getTime() >= deadline) {
      return { status: 'expired' };
    }

     
    await sleep(intervalSeconds * 1000);

    const response = await postJson(
      `${base}${POLL_PATH}`,
      { deviceCode: start.deviceCode },
      { ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) },
    );
     

    if (response.error !== undefined) {
      return { status: 'unreachable', reason: response.error };
    }
    if (!isRecord(response.body)) {
      return {
        status: 'unreachable',
        reason: `The activation service responded with status ${response.status}.`,
      };
    }

    const {status} = response.body;

    if (status === 'activated') {
      return { status: 'activated', license: response.body.license };
    }
    if (status === 'denied') {
      return { status: 'denied' };
    }
    if (status === 'expired') {
      return { status: 'expired' };
    }
    if (status === 'slow_down') {
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
    } else if (status !== 'pending') {
      return {
        status: 'unreachable',
        reason: `The activation service returned an unexpected status: ${String(status)}`,
      };
    }
  }
};

export interface BrowserCommand {
  command: string;
  args: string[];
}

/** The platform opener used to show the verification page. */
export const browserCommand = (url: string, platform: string): BrowserCommand => {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
};

export interface OpenBrowserOptions {
  platform?: string;
  /** Injected so tests never launch a real browser. */
  spawnImpl?: typeof spawn;
}

/**
 * Attempts to open the verification page in the user's browser.
 *
 * Best effort by design: the URL and code have already been printed, so a
 * failure here costs the user nothing and must never interrupt activation.
 */
export const openBrowser = (url: string, options: OpenBrowserOptions = {}): boolean => {
  const { command, args } = browserCommand(url, options.platform ?? process.platform);
  const launch = options.spawnImpl ?? spawn;

  try {
    const child = launch(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Nothing to do: the URL is already on screen.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};
