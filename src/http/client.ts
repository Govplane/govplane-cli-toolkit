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

/** Base URL for activation, overridable for staging and local development. */
export const resolveApiUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[API_URL_ENV];
  const base = override !== undefined && override.trim() !== '' ? override : DEFAULT_API_URL;
  return base.replace(/\/+$/, '');
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
