import { fixedClock } from '@govplane/cli';
import { describe, expect, it } from '@jest/globals';
import {
  browserCommand, DEFAULT_EXPIRY_SECONDS, DEFAULT_INTERVAL_SECONDS, openBrowser, pollForLicense,
  SLOW_DOWN_INCREMENT_SECONDS, startDeviceActivation, type DeviceStart,
} from '../../src/activation/deviceFlow.js';
import { resolveApiUrl, type FetchLike } from '../../src/http/client.js';
import { NOW } from '../helpers/harness.js';

interface Call {
  url: string;
  body: unknown;
}

/** A transport that replays scripted responses and records what was sent. */
const scripted = (responses: unknown[], options: { fail?: string; status?: number } = {}) => {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) });

    if (options.fail !== undefined) {
      throw new Error(options.fail);
    }

    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return {
      ok: options.status === undefined ? true : options.status < 400,
      status: options.status ?? 200,
      json: async () => body,
    };
  };

  return { fetchImpl, calls };
};

const start = (overrides: Partial<DeviceStart> = {}): DeviceStart => ({
  deviceCode: 'device-code',
  userCode: 'GOVP-1234-ABCD',
  verificationUri: 'https://govplane.com/activate',
  intervalSeconds: 1,
  expiresInSeconds: 600,
  ...overrides,
});

const noSleep = async (): Promise<void> => {};

describe('startDeviceActivation', () => {
  it('sends nothing but the client name and version', async () => {
    const transport = scripted([{
      deviceCode: 'abc',
      userCode: 'GOVP-1111-2222',
      verificationUri: 'https://govplane.com/activate',
      interval: 3,
      expiresIn: 300,
    }]);

    const outcome = await startDeviceActivation('1.2.3', {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    expect(transport.calls[0]?.body).toEqual({
      client: 'govplane-toolkit',
      clientVersion: '1.2.3',
    });
  });

  it('posts to the documented endpoint on the resolved base URL', async () => {
    const transport = scripted([{
      deviceCode: 'abc', userCode: 'GOVP-1111-2222', verificationUri: 'https://x',
    }]);

    await startDeviceActivation('1.0.0', {
      now: fixedClock(NOW),
      env: { GOVPLANE_API_URL: 'http://localhost:9999/' },
      fetchImpl: transport.fetchImpl,
    });

    expect(transport.calls[0]?.url).toBe('http://localhost:9999/v1/activation/device/start');
  });

  it('applies documented defaults for interval and expiry', async () => {
    const transport = scripted([{
      deviceCode: 'abc', userCode: 'GOVP-1111-2222', verificationUri: 'https://x',
    }]);

    const outcome = await startDeviceActivation('1.0.0', {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.start.intervalSeconds).toBe(DEFAULT_INTERVAL_SECONDS);
      expect(outcome.start.expiresInSeconds).toBe(DEFAULT_EXPIRY_SECONDS);
    }
  });

  it('reports a transport failure', async () => {
    const transport = scripted([{}], { fail: 'network unreachable' });
    const outcome = await startDeviceActivation('1.0.0', {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl,
    });

    expect(outcome).toEqual({ ok: false, reason: 'network unreachable' });
  });

  it('reports an error response', async () => {
    const transport = scripted([{}], { status: 503 });
    const outcome = await startDeviceActivation('1.0.0', {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('503');
    }
  });

  it('reports an incomplete response', async () => {
    const transport = scripted([{ deviceCode: 'abc' }]);
    const outcome = await startDeviceActivation('1.0.0', {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('incomplete');
    }
  });
});

describe('pollForLicense', () => {
  it('waits through pending responses and returns the licence', async () => {
    const transport = scripted([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'activated', license: { licenseId: 'lic_1' } },
    ]);

    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome).toEqual({ status: 'activated', license: { licenseId: 'lic_1' } });
    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[0]?.body).toEqual({ deviceCode: 'device-code' });
  });

  it('backs off when the service asks it to', async () => {
    const waits: number[] = [];
    const transport = scripted([
      { status: 'slow_down' },
      { status: 'slow_down' },
      { status: 'activated', license: {} },
    ]);

    await pollForLicense(start({ intervalSeconds: 2 }), {
      now: fixedClock(NOW),
      env: {},
      fetchImpl: transport.fetchImpl,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(waits).toEqual([
      2000,
      (2 + SLOW_DOWN_INCREMENT_SECONDS) * 1000,
      (2 + SLOW_DOWN_INCREMENT_SECONDS * 2) * 1000,
    ]);
  });

  it('reports a declined request', async () => {
    const transport = scripted([{ status: 'denied' }]);
    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome).toEqual({ status: 'denied' });
  });

  it('reports an expired request', async () => {
    const transport = scripted([{ status: 'expired' }]);
    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome).toEqual({ status: 'expired' });
  });

  it('stops polling once the request has expired locally', async () => {
    const transport = scripted([{ status: 'pending' }]);
    let ticks = 0;
    const advancingClock = () => {
      ticks += 1;
      // Second reading is past the deadline.
      return new Date(Date.parse(NOW) + (ticks > 1 ? 700_000 : 0));
    };

    const outcome = await pollForLicense(start({ expiresInSeconds: 600 }), {
      now: advancingClock, env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome).toEqual({ status: 'expired' });
  });

  it('reports an unreachable service', async () => {
    const transport = scripted([{}], { fail: 'connection refused' });
    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome).toEqual({ status: 'unreachable', reason: 'connection refused' });
  });

  it('reports a response it cannot interpret', async () => {
    const transport = scripted([{ status: 'confused' }]);
    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl: transport.fetchImpl, sleep: noSleep,
    });

    expect(outcome.status).toBe('unreachable');
  });

  it('reports a non-JSON response', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    const outcome = await pollForLicense(start(), {
      now: fixedClock(NOW), env: {}, fetchImpl, sleep: noSleep,
    });

    expect(outcome.status).toBe('unreachable');
  });
});

describe('resolveApiUrl', () => {
  it('defaults to the production service', () => {
    expect(resolveApiUrl({})).toBe('https://api.govplane.com');
  });

  it('honours an override and trims trailing slashes', () => {
    expect(resolveApiUrl({ GOVPLANE_API_URL: 'http://localhost:8787//' }))
      .toBe('http://localhost:8787');
  });

  it('falls back when the override is blank', () => {
    expect(resolveApiUrl({ GOVPLANE_API_URL: '   ' })).toBe('https://api.govplane.com');
  });

  it('trims a run of slashes in linear time', () => {
    // The previous `replace(/\/+$/, '')` backtracked quadratically on this shape:
    // 40 000 slashes took over half a second. The bound is deliberately loose so
    // the test measures the complexity class, not the machine it runs on.
    const pathological = `${'/'.repeat(200_000)}x`;

    const started = process.hrtime.bigint();
    const resolved = resolveApiUrl({ GOVPLANE_API_URL: pathological });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(resolved).toBe(pathological);
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe('browserCommand', () => {
  const url = 'https://govplane.com/activate';

  it.each([
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
    ['win32', 'cmd', ['/c', 'start', '', url]],
  ])('uses the %s opener', (platform, command, args) => {
    expect(browserCommand(url, platform)).toEqual({ command, args });
  });
});

describe('openBrowser', () => {
  const url = 'https://govplane.com/activate';

  const fakeSpawn = (behaviour: { throws?: boolean } = {}) => {
    const launched: string[] = [];
    const impl = ((command: string) => {
      if (behaviour.throws === true) {
        throw new Error('spawn failed');
      }
      launched.push(command);
      return { on: () => undefined, unref: () => undefined };
    }) as unknown as typeof import('node:child_process').spawn;
    return { impl, launched };
  };

  it('launches the platform opener', () => {
    const spawner = fakeSpawn();
    expect(openBrowser(url, { platform: 'darwin', spawnImpl: spawner.impl })).toBe(true);
    expect(spawner.launched).toEqual(['open']);
  });

  it('reports failure without throwing when no browser can be launched', () => {
    const spawner = fakeSpawn({ throws: true });
    expect(openBrowser(url, { platform: 'linux', spawnImpl: spawner.impl })).toBe(false);
  });
});
