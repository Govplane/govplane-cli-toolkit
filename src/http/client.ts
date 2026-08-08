/**
 * Minimal HTTP access for activation.
 *
 * The toolkit makes network requests in exactly one place — the activation
 * device flow — so this stays deliberately small. The transport is injectable
 * so the device flow can be exercised deterministically in tests without a
 * server.
 */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const DEFAULT_API_URL = 'https://api.govplane.com';
export const API_URL_ENV = 'GOVPLANE_API_URL';

const SLASH = '/';

/**
 * Strips trailing slashes in one pass.
 *
 * The obvious `replace(/\/+$/, '')` backtracks quadratically: for each starting
 * position the engine consumes the run of slashes, fails the end anchor and
 * unwinds, so a value of many slashes followed by any other character costs
 * O(n²). Measured on the shipped regex, 40 000 slashes took over half a second.
 *
 * The value is an environment variable, which is not attacker-controlled in the
 * usual sense — but this runs inside `govplane` in CI, where the environment is
 * assembled from configuration that people do edit, and a scan is right to
 * object to a pathological regex on any input it cannot bound.
 */
const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === SLASH) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
};

/** Base URL for activation, overridable for staging and local development. */
export const resolveApiUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[API_URL_ENV];
  const base = override !== undefined && override.trim() !== '' ? override : DEFAULT_API_URL;
  return stripTrailingSlashes(base);
};

export interface PostJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** Set when the request could not be completed at all. */
  error?: string;
}

export interface PostJsonOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Posts JSON and never throws: transport failures come back as `error`. */
export const postJson = async (
  url: string,
  payload: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResult> => {
  const call = options.fetchImpl ?? (globalThis.fetch);
  if (typeof call !== 'function') {
    return { ok: false, status: 0, body: null, error: 'No HTTP client is available.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : 'The request could not be completed.',
    };
  } finally {
    clearTimeout(timeout);
  }
};
