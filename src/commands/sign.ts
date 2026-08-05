import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  CliError, ExitCode, commonOptions, computeChecksum, etagFromChecksum, formatOption,
  parseJson, readBoolean, readString, readTextFile, resolveProject, validateBundle,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
  type RuntimeBundle, type ValidationIssue,
} from '@govplane/cli';
import { requireActivation } from '../activation/guard.js';
import { bundleStats } from '../build/compile.js';
import { writeBundle } from '../build/output.js';
import {
  resolveSigning, signBundle, SIGNING_ALGORITHMS, type BundleSignature,
} from '../build/signing.js';
import { readSigningConfig } from '../config/signing.js';

const COMMAND = 'sign';
const DEFAULT_BUNDLE_FILE = 'policy-bundle.json';

const displayPath = (path: string, cwd: string): string => {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
};

const issueLines = (
  reporter: Reporter,
  issues: ValidationIssue[],
  label: string,
): string[] => {
  if (issues.length === 0) {
    return [];
  }

  const lines = ['', `${issues.length} ${label}${issues.length === 1 ? '' : 's'}:`];
  issues.forEach((issue, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${issue.path.replace(/^\$\./, '')}`);
    lines.push(`   ${issue.message}`);
    lines.push(`   ${reporter.muted(issue.code)}`);
  });
  return lines;
};

/** Reads the bundle to sign, refusing anything that is not a JSON document. */
const loadBundle = (path: string): RuntimeBundle => {
  if (!existsSync(path)) {
    throw new CliError(`Bundle file not found: ${path}`, {
      code: 'BUNDLE_NOT_FOUND',
      exitCode: ExitCode.FileError,
      details: [
        '',
        'Specify a path with --bundle, or set bundle.path in govplane.config.json.',
        '',
        'Build one with:',
        '  govplane build',
      ],
    });
  }

  const parsed = parseJson(readTextFile(path));
  if (!parsed.ok) {
    throw new CliError(`The bundle is not valid JSON: ${path}`, {
      code: 'BUNDLE_INVALID_JSON',
      exitCode: ExitCode.FileError,
      details: ['', parsed.message],
    });
  }

  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new CliError(`The bundle must be a JSON object: ${path}`, {
      code: 'BUNDLE_INVALID_JSON',
      exitCode: ExitCode.FileError,
    });
  }

  return parsed.value as RuntimeBundle;
};

/**
 * Refuses to sign a bundle that already carries a signature.
 *
 * Re-signing is deliberately manual. Replacing a signature silently would make
 * it impossible to tell, from the artifact alone, whether the bundle had been
 * signed once by the intended key or repeatedly by whatever key was to hand.
 */
const assertUnsigned = (bundle: RuntimeBundle, path: string): void => {
  if (!('signature' in bundle)) {
    return;
  }

  throw new CliError('The bundle already contains a signature.', {
    code: 'BUNDLE_ALREADY_SIGNED',
    exitCode: ExitCode.Compatibility,
    details: [
      '',
      `Input: ${path}`,
      '',
      'To re-sign, remove the existing signature field first. There is no override:',
      'replacing a signature is an explicit decision, not a flag.',
    ],
  });
};

interface SignOutput {
  path: string;
  inPlace: boolean;
}

/** Resolves where the signed bundle goes, refusing to clobber an unrelated file. */
const resolveOutput = (
  context: CommandContext,
  bundlePath: string,
  workingFolder: string,
): SignOutput => {
  const explicit = readString(context.options, 'output');
  if (explicit === undefined) {
    return { path: bundlePath, inPlace: true };
  }

  const path = resolve(workingFolder, explicit);

  if (existsSync(path) && !readBoolean(context.options, 'force-output')) {
    throw new CliError(`The output path already exists: ${path}`, {
      code: 'OUTPUT_PATH_EXISTS',
      exitCode: ExitCode.WriteError,
      details: ['', 'Use --force-output to allow overwriting it.'],
    });
  }

  return { path, inPlace: false };
};

const printResult = (
  reporter: Reporter,
  input: {
    bundlePath: string;
    output: SignOutput;
    checksum: string;
    etag: string;
    signature: BundleSignature;
    warnings: ValidationIssue[];
    cwd: string;
  },
): void => {
  reporter.line(reporter.heading('Govplane Sign'));
  reporter.line();
  reporter.line('Input:');
  reporter.line(`  Bundle: ${displayPath(input.bundlePath, input.cwd)}`);
  reporter.line();
  reporter.line('Integrity:');
  reporter.line(`  Checksum: ${input.checksum}  ${reporter.muted('(recomputed)')}`);
  reporter.line(`  ETag: ${input.etag}`);
  reporter.line();
  reporter.line('Signature:');
  reporter.line(`  Algorithm: ${input.signature.algorithm}`);
  reporter.line(`  Key ID:    ${input.signature.keyId}`);
  reporter.line();
  reporter.line('Output:');
  if (input.output.inPlace) {
    const path = displayPath(input.output.path, input.cwd);
    reporter.line(`  Bundle: ${path}  ${reporter.muted('(in-place)')}`);
  } else {
    reporter.line(`  Source:  ${displayPath(input.bundlePath, input.cwd)}`);
    reporter.line(`  Written: ${displayPath(input.output.path, input.cwd)}`);
  }

  reporter.lines(issueLines(reporter, input.warnings, 'warning'));

  reporter.line();
  reporter.line('Result:');
  reporter.line(`  ${reporter.success('Bundle signed successfully')}`);
};

const run = (context: CommandContext): ExitCodeValue => {
  requireActivation(context, COMMAND);

  const { reporter } = context;
  const project = resolveProject(context, { requireWritable: true });

  // 1. Resolve and load the bundle.
  const bundlePath = resolve(
    project.workingFolder.path,
    readString(context.options, 'bundle')
      ?? project.config.bundle?.path
      ?? DEFAULT_BUNDLE_FILE,
  );
  reporter.debug(`Bundle: ${bundlePath}`);

  const bundle = loadBundle(bundlePath);

  // 2. Refuse a bundle that is already signed, before touching any key material.
  assertUnsigned(bundle, bundlePath);

  // 3. Validate against the runtime rules, in the local-first profile.
  //
  // A checksum that disagrees with the contents is not a reason to refuse: sign
  // recomputes it a few lines below, and a bundle carrying a stale checksum is
  // precisely one of the cases this command exists to repair.
  const validation = validateBundle(bundle, { scope: 'optional' });
  const errors = validation.issues.errors.filter(
    (issue) => issue.code !== 'CHECKSUM_MISMATCH',
  );

  if (errors.length > 0) {
    throw new CliError(
      `The bundle failed validation with ${errors.length} `
        + `error${errors.length === 1 ? '' : 's'}. Nothing was signed.`,
      {
        code: 'BUNDLE_VALIDATION_FAILED',
        exitCode: ExitCode.Compatibility,
        details: issueLines(reporter, errors, 'problem'),
      },
    );
  }

  // 4. Resolve the output before signing, so a path collision is reported
  //    without a key ever being read.
  const output = resolveOutput(context, bundlePath, project.workingFolder.path);

  // 5. Recompute integrity: the input may carry a stale checksum, or none, and
  //    the signed artifact has to reflect what it actually contains.
  const checksum = computeChecksum(bundle);
  const etag = etagFromChecksum(checksum);

  const previous = typeof bundle.checksum === 'string' ? bundle.checksum : undefined;
  if (previous !== undefined && previous !== checksum) {
    reporter.debug(`Checksum recomputed (was ${previous})`);
  }

  // 6. Sign the canonical payload — the same preimage the checksum covers, and
  //    the same one `govplane build --signed` uses.
  const signingInput = resolveSigning(
    {
      algorithm: readString(context.options, 'signing-algorithm'),
      keyId: readString(context.options, 'signing-key-id'),
      hmacSecret: readString(context.options, 'hmac-secret'),
      hmacSecretEnv: readString(context.options, 'hmac-secret-env'),
      ecdsaPrivateKey: readString(context.options, 'ecdsa-private-key'),
    },
    readSigningConfig(project.configPath, 'sign'),
    context.env,
    project.workingFolder.path,
    { section: 'sign', keyIdFrom: 'source', requireAlgorithm: true },
  );

  reporter.debug(`Signing with ${signingInput.algorithm}, key source ${signingInput.keySource}`);

  const withChecksum = { ...bundle, checksum } as RuntimeBundle;
  const signature = signBundle(withChecksum, signingInput);

  // The signature goes last, so it reads as an envelope around the document
  // rather than as one field lost among the policies.
  const signed = { ...withChecksum, signature };

  // 7. Write atomically. When --output was given the input is never touched.
  writeBundle(output.path, signed);

  const stats = bundleStats(signed);
  const warnings = (validation.issues.warnings)
    .filter((warning) => warning.code !== 'UNSIGNED_BUNDLE');

  const strict = readBoolean(context.options, 'strict');
  const outcome = strict && warnings.length > 0 ? ExitCode.Failure : ExitCode.Success;

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      input: { bundlePath },
      output: {
        bundlePath: output.path,
        inPlace: output.inPlace,
        schemaVersion: signed.schemaVersion,
        env: signed.env,
        ...(signed.bundleVersion === undefined ? {} : { bundleVersion: signed.bundleVersion }),
        checksum,
        etag,
        signatureAlgorithm: signature.algorithm,
        signatureKeyId: signature.keyId,
      },
      warnings,
      stats,
    });
    return outcome;
  }

  printResult(reporter, {
    bundlePath, output, checksum, etag, signature, warnings, cwd: context.cwd,
  });

  if (outcome !== ExitCode.Success) {
    reporter.error('');
    reporter.error('Strict mode: warnings are treated as requiring attention.');
  }

  return outcome;
};

export const signCommand: CommandDefinition = {
  name: 'sign',
  summary: 'Sign a policy bundle',
  usage: 'govplane sign [options]',
  description: 'Apply a signature to an existing unsigned runtime bundle, using local key '
    + 'material only. The same signing engine as "govplane build --signed".',
  requiresToolkit: true,
  options: [
    {
      name: 'bundle',
      type: 'string',
      placeholder: '<path>',
      description: 'Bundle to sign (default: policy-bundle.json)',
    },
    {
      name: 'signing-algorithm',
      type: 'string',
      placeholder: '<algorithm>',
      choices: [...SIGNING_ALGORITHMS],
      description: 'Signing algorithm (required)',
    },
    {
      name: 'signing-key-id',
      type: 'string',
      placeholder: '<value>',
      description: 'Key identifier recorded in the signature',
    },
    {
      name: 'hmac-secret',
      type: 'string',
      placeholder: '<hex>',
      description: 'HMAC secret as 64 hex characters (prefer --hmac-secret-env)',
    },
    {
      name: 'hmac-secret-env',
      type: 'string',
      placeholder: '<var>',
      description: 'Environment variable holding the HMAC secret',
    },
    {
      name: 'ecdsa-private-key',
      type: 'string',
      placeholder: '<path>',
      description: 'ECDSA private key in PEM form',
    },
    {
      name: 'output',
      type: 'string',
      placeholder: '<path>',
      description: 'Write the signed bundle here instead of in-place',
    },
    {
      name: 'force-output',
      type: 'boolean',
      description: 'Allow overwriting an existing --output',
    },
    { name: 'strict', type: 'boolean', description: 'Treat warnings as requiring attention' },
    formatOption,
    ...commonOptions,
  ],
  examples: [
    'govplane sign --signing-algorithm HMAC_SHA256 --hmac-secret-env GOVPLANE_HMAC_SECRET',
    'govplane sign --signing-algorithm ECDSA_SHA_256 --ecdsa-private-key ./keys/signing.pem',
    'govplane sign --output ./dist/policy-bundle.signed.json',
  ],
  run,
};
