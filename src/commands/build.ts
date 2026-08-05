import { relative } from 'node:path';
import {
  CliError, ENVIRONMENTS, ExitCode, commonOptions, computeChecksum, etagFromChecksum,
  formatOption, readBoolean, readCliVersion, readString, resolveProject, validateBundle,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
  type RuntimeBundle, type ValidationIssue,
} from '@govplane/cli';
import { requireActivation } from '../activation/guard.js';
import { bundleStats, compileBundle, DEFAULT_ENV } from '../build/compile.js';
import {
  readBuildConfig, reportPath, resolveBundleVersion, resolveOutputPath, resolveWritePath,
  writeBundle, writeReport, type BuildReport,
} from '../build/output.js';
import { checkBuildReadiness } from '../build/readiness.js';
import {
  resolveSigning, signBundle, SIGNING_ALGORITHMS, type BundleSignature,
} from '../build/signing.js';
import { loadDraft, resolveDraftFile } from '../drafts/store.js';

const COMMAND = 'build';

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

const validationFailure = (
  reporter: Reporter,
  heading: string,
  issues: ValidationIssue[],
): CliError => new CliError(heading, {
  code: 'BUILD_VALIDATION_FAILED',
  exitCode: ExitCode.Compatibility,
  details: issueLines(reporter, issues, 'problem'),
});

const printResult = (
  reporter: Reporter,
  input: {
    draftPath: string;
    output: { requestedPath: string; path: string; timestamped: boolean };
    bundle: RuntimeBundle;
    checksum: string;
    etag: string;
    signature: BundleSignature | null;
    warnings: ValidationIssue[];
    reportFile: string | null;
    cwd: string;
  },
): void => {
  reporter.line(reporter.heading('Govplane Build'));
  reporter.line();
  reporter.line('Input:');
  reporter.line(`  Draft: ${displayPath(input.draftPath, input.cwd)}`);
  reporter.line();
  reporter.line('Output:');
  reporter.line(`  Bundle: ${displayPath(input.output.path, input.cwd)}`);
  if (input.output.timestamped) {
    reporter.line(`  Requested: ${displayPath(input.output.requestedPath, input.cwd)}`);
    reporter.line(reporter.muted('  The requested file already existed and was left untouched.'));
  }
  reporter.line(`  Schema: ${input.bundle.schemaVersion}`);
  reporter.line(`  Env: ${input.bundle.env}`);
  reporter.line(`  Bundle version: ${input.bundle.bundleVersion}`);
  reporter.line();
  reporter.line('Integrity:');
  reporter.line(`  Checksum: ${input.checksum}`);
  reporter.line(`  ETag: ${input.etag}`);
  reporter.line();
  reporter.line('Signature:');
  if (input.signature === null) {
    reporter.line('  Enabled: no');
  } else {
    reporter.line('  Enabled: yes');
    reporter.line(`  Algorithm: ${input.signature.algorithm}`);
    reporter.line(`  Key ID: ${input.signature.keyId}`);
  }

  if (input.reportFile !== null) {
    reporter.line();
    reporter.line('Report:');
    reporter.line(`  ${displayPath(input.reportFile, input.cwd)}`);
  }

  reporter.lines(issueLines(reporter, input.warnings, 'warning'));

  reporter.line();
  reporter.line('Result:');
  reporter.line(`  ${reporter.success('Build completed successfully')}`);
};

const run = (context: CommandContext): ExitCodeValue => {
  requireActivation(context, COMMAND);

  const { reporter } = context;
  const project = resolveProject(context, { requireWritable: true });
  const build = readBuildConfig(project.configPath);
  const startedAt = context.now();
  const generatedAt = startedAt.toISOString();

  // 1. Resolve and load the draft.
  const draftPath = resolveDraftFile(
    project.workingFolder.path,
    project.config,
    readString(context.options, 'draft'),
  );
  reporter.debug(`Draft: ${draftPath}`);
  const draft = loadDraft(draftPath, generatedAt);
  if (draft.shape === 'analyze') {
    reporter.debug('Draft shape: analyze (normalised into build-ready policies)');
  }

  // 2. Validate draft completeness before anything is compiled.
  const readiness = checkBuildReadiness(draft.document);
  if (readiness.length > 0) {
    throw validationFailure(
      reporter,
      `Build could not start. Draft validation failed with ${readiness.length} `
        + `error${readiness.length === 1 ? '' : 's'}.`,
      readiness,
    );
  }

  if (draft.document.policies.length === 0) {
    throw new CliError('Build could not start. The draft contains no policies.', {
      code: 'BUILD_VALIDATION_FAILED',
      exitCode: ExitCode.Compatibility,
      details: [
        '',
        'Add one with:',
        '  govplane policies add-policy --policy-key <key> --defaults-effect allow',
      ],
    });
  }

  // 3-4. Map to runtime shape and compile deterministically.
  const requestedOutput = resolveOutputPath(
    project.workingFolder.path,
    project.config,
    build,
    readString(context.options, 'output'),
  );
  const strategy = build.bundleVersionStrategy;
  if (strategy !== undefined && strategy !== 'increment') {
    reporter.debug(`Unsupported bundleVersionStrategy "${strategy}"; using "increment".`);
  }

  // The scope is resolved before the version, because the revision counter runs
  // per scope — exactly as the control plane numbers bundles per org, project
  // and env.
  const env = readString(context.options, 'env')
    ?? build.env
    ?? draft.document.env
    ?? DEFAULT_ENV;
  const orgId = readString(context.options, 'org-id') ?? build.scope?.orgId ?? undefined;
  const projectId = readString(context.options, 'project-id')
    ?? build.scope?.projectId
    ?? undefined;

  const bundleVersion = resolveBundleVersion(requestedOutput, { orgId, projectId, env });
  reporter.debug(`Bundle version: ${bundleVersion}`);

  const bundle = compileBundle({
    draft: draft.document,
    generatedAt,
    bundleVersion,
    env,
    orgId,
    projectId,
  });

  // 5. Runtime bundle validation parity, in the local-first profile.
  const parity = build.validateParity !== false;
  const validation = parity
    ? validateBundle(bundle, { scope: 'optional' })
    : { issues: { errors: [], warnings: [] } };

  if (validation.issues.errors.length > 0) {
    throw validationFailure(
      reporter,
      `The compiled bundle failed runtime validation with ${validation.issues.errors.length} `
        + `error${validation.issues.errors.length === 1 ? '' : 's'}.`,
      validation.issues.errors,
    );
  }

  // 6-7. Canonical projection, checksum and etag.
  const checksum = computeChecksum(bundle);
  const etag = etagFromChecksum(checksum);
  bundle.checksum = checksum;

  // 9. Optional signing, over the same canonical bytes the checksum covers.
  const signed = readBoolean(context.options, 'signed') || build.signed === true;
  let signature: BundleSignature | null = null;

  if (signed) {
    const input = resolveSigning(
      {
        algorithm: readString(context.options, 'signing-algorithm'),
        keyId: readString(context.options, 'signing-key-id'),
        hmacSecret: readString(context.options, 'hmac-secret'),
        hmacSecretEnv: readString(context.options, 'hmac-secret-env'),
        ecdsaPrivateKey: readString(context.options, 'ecdsa-private-key'),
      },
      build.signing ?? {},
      context.env,
      project.workingFolder.path,
    );

    reporter.debug(`Signing with ${input.algorithm}, key source ${input.keySource}`);
    signature = signBundle(bundle, input);
    bundle.signature = signature;
  }

  // 10. Write the bundle, never over an existing one.
  const output = resolveWritePath(requestedOutput, startedAt);
  writeBundle(output.path, bundle);

  const stats = bundleStats(bundle);
  // Validation runs before signing, so its "unsigned bundle" warning is stale
  // once a signature has been attached. Reporting it anyway would be untrue.
  const warnings = (validation.issues.warnings as ValidationIssue[])
    .filter((warning) => !(signature !== null && warning.code === 'UNSIGNED_BUNDLE'));

  let reportFile: string | null = null;
  const wantsReport = readBoolean(context.options, 'report')
    || readString(context.options, 'report-path') !== undefined;
  if (wantsReport) {
    reportFile = reportPath(
      project.workingFolder.path,
      startedAt,
      readString(context.options, 'report-path'),
    );
    const report: BuildReport = {
      cliVersion: readCliVersion(),
      builtAt: generatedAt,
      input: { draftPath },
      output: {
        requestedPath: output.requestedPath,
        bundlePath: output.path,
        schemaVersion: 1,
        env: bundle.env,
        bundleVersion,
        checksum,
        etag,
      },
      validation: { errors: 0, warnings: warnings.length },
      signing: signature === null
        ? { signed: false }
        : { signed: true, algorithm: signature.algorithm, keyId: signature.keyId },
      stats,
    };
    writeReport(reportFile, report);
  }

  const strict = readBoolean(context.options, 'strict');
  const outcome = strict && warnings.length > 0 ? ExitCode.Failure : ExitCode.Success;

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      input: { draftPath },
      output: {
        requestedPath: output.requestedPath,
        bundlePath: output.path,
        schemaVersion: 1,
        env: bundle.env,
        bundleVersion,
        checksum,
        etag,
        signed: signature !== null,
        ...(signature === null
          ? {}
          : { signatureAlgorithm: signature.algorithm, signatureKeyId: signature.keyId }),
      },
      ...(reportFile === null ? {} : { reportPath: reportFile }),
      warnings,
      stats,
    });
    return outcome;
  }

  printResult(reporter, {
    draftPath,
    output,
    bundle,
    checksum,
    etag,
    signature,
    warnings,
    reportFile,
    cwd: context.cwd,
  });

  if (outcome !== ExitCode.Success) {
    reporter.error('');
    reporter.error('Strict mode: warnings are treated as requiring attention.');
  }

  return outcome;
};

export const buildCommand: CommandDefinition = {
  name: 'build',
  summary: 'Build a policy bundle from drafts',
  usage: 'govplane build [options]',
  description: 'Compile local policy drafts into a deterministic, validated runtime bundle. '
    + 'Uses local files only and never contacts Govplane.',
  requiresToolkit: true,
  options: [
    { name: 'draft', type: 'string', placeholder: '<path>', description: 'Draft file to compile' },
    {
      name: 'output',
      type: 'string',
      placeholder: '<path>',
      description: 'Where to write the bundle',
    },
    {
      name: 'env',
      type: 'string',
      placeholder: '<env>',
      choices: [...ENVIRONMENTS],
      description: `Environment recorded in the bundle (default ${DEFAULT_ENV})`,
    },
    {
      name: 'org-id',
      type: 'string',
      placeholder: '<value>',
      description: 'Organisation the bundle belongs to',
    },
    {
      name: 'project-id',
      type: 'string',
      placeholder: '<value>',
      description: 'Project the bundle belongs to',
    },
    { name: 'signed', type: 'boolean', description: 'Sign the bundle' },
    {
      name: 'signing-algorithm',
      type: 'string',
      placeholder: '<algorithm>',
      choices: [...SIGNING_ALGORITHMS],
      description: 'Signing algorithm',
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
    { name: 'report', type: 'boolean', description: 'Write a build report' },
    {
      name: 'report-path',
      type: 'string',
      placeholder: '<path>',
      description: 'Where to write the build report',
    },
    { name: 'strict', type: 'boolean', description: 'Treat warnings as requiring attention' },
    formatOption,
    ...commonOptions,
  ],
  examples: [
    'govplane build',
    'govplane build --draft ./policy-drafts.json --output ./dist/bundle.json',
    'govplane build --env staging --org-id org_1 --project-id proj_1',
    'govplane build --signed --hmac-secret-env GOVPLANE_HMAC_SECRET',
    'govplane build --format json --quiet',
  ],
  run,
};
