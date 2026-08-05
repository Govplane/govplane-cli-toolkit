import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { canonicalDocument, fixedClock, stringifyJson } from '@govplane/cli';
import { run } from '../../src/toolkit.js';
import type { License } from '../../src/activation/types.js';

export const NOW = '2026-07-29T12:00:00.000Z';
export const TEST_KEY_ID = 'test-license-key';

export interface MemoryStream {
  isTTY: boolean;
  write(chunk: string): boolean;
  text(): string;
}

export const memoryStream = (): MemoryStream => {
  const chunks: string[] = [];
  return {
    isTTY: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
};

/** Signs licences the way the activation service does, with a per-run key. */
export interface Signer {
  publicKeyPem: string;
  sign(body: Omit<License, 'signature'>, keyId?: string): License;
}

export const createSigner = (): Signer => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign(body, keyId = TEST_KEY_ID) {
      return {
        ...body,
        signature: {
          algorithm: 'Ed25519',
          keyId,
          value: signPayload(null, canonicalDocument(body), privateKey).toString('base64'),
        },
      };
    },
  };
};

export interface LicenseOverrides {
  email?: string;
  plan?: string;
  issuedAt?: string;
  renewAfter?: string;
  marketingConsent?: boolean;
  licenseId?: string;
}

export const licenseBody = (
  overrides: LicenseOverrides = {},
): Omit<License, 'signature'> => ({
  schemaVersion: 1,
  licenseId: overrides.licenseId ?? 'lic_test_0001',
  subject: { email: overrides.email ?? 'dev@example.com' },
  plan: overrides.plan ?? 'toolkit-free',
  issuedAt: overrides.issuedAt ?? NOW,
  ...(overrides.renewAfter === undefined ? {} : { renewAfter: overrides.renewAfter }),
  terms: { version: '2026-07-01', acceptedAt: overrides.issuedAt ?? NOW },
  marketingConsent: overrides.marketingConsent ?? false,
});

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  signer: Signer;
  /** Environment that isolates Govplane state and trusts the test signing key. */
  env: NodeJS.ProcessEnv;
  /** Installs a signed licence at the default location. */
  installLicense(overrides?: LicenseOverrides): License;
  /** Writes a licence file anywhere, without installing it. */
  writeLicenseFile(relativePath: string, license: unknown): string;
  /** Seeds the grace-period anchor, so a given number of days has "passed". */
  setFirstUse(instant: string): void;
  writeText(relativePath: string, content: string): string;
  cleanup(): void;
}

export const createSandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), 'govplane-toolkit-test-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const signer = createSigner();

  const write = (path: string, content: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  return {
    root,
    home,
    project,
    signer,
    env: {
      GOVPLANE_HOME: home,
      GOVPLANE_LICENSE_PUBLIC_KEY: signer.publicKeyPem,
    },
    installLicense(overrides: LicenseOverrides = {}) {
      const license = signer.sign(licenseBody(overrides));
      write(join(home, 'license.json'), stringifyJson(license));
      return license;
    },
    writeLicenseFile(relativePath: string, license: unknown) {
      return write(join(project, relativePath), stringifyJson(license));
    },
    setFirstUse(instant: string) {
      write(
        join(home, 'state.json'),
        stringifyJson({ schemaVersion: 1, toolkitFirstUsedAt: instant }),
      );
    },
    writeText(relativePath: string, content: string) {
      return write(join(project, relativePath), content);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export interface ToolkitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): unknown;
}

/**
 * A terminal-like input carrying scripted answers.
 *
 * A real `Readable` with `isTTY` set, so the prompting code under test is the
 * code that ships rather than a stand-in for it.
 */
export const terminalInput = (answers: string[]): Readable & { isTTY?: boolean } => {
  const stream = Readable.from(answers.map((answer) => `${answer}\n`)) as Readable & {
    isTTY?: boolean;
  };
  stream.isTTY = true;
  return stream;
};

export const runToolkit = async (
  argv: string[],
  sandbox: Sandbox,
  overrides: {
    env?: NodeJS.ProcessEnv;
    now?: string;
    cwd?: string;
    /** Scripted answers for a command that prompts. Implies a TTY. */
    answers?: string[];
  } = {},
): Promise<ToolkitRunResult> => {
  const stdout = memoryStream();
  const stderr = memoryStream();

  const code = await run(argv, {
    streams: {
      stdout,
      stderr,
      ...(overrides.answers === undefined
        ? {}
        : { stdin: terminalInput(overrides.answers) }),
    },
    cwd: overrides.cwd ?? sandbox.project,
    env: { ...sandbox.env, ...overrides.env },
    now: fixedClock(overrides.now ?? NOW),
  });

  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    json() {
      return JSON.parse(stdout.text()) as unknown;
    },
  };
};

/** An instant a given number of days after the reference `NOW`. */
export const daysAfterNow = (days: number): string => (
  new Date(Date.parse(NOW) + days * 24 * 60 * 60 * 1000).toISOString()
);
