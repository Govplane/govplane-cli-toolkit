import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  CliError, ExitCode, commonOptions, fileTimestamp, formatOption, parseJson, readBoolean,
  readCliVersion, readList, readOptional, readString, readTextFile, resolveProject,
  validateBundle,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
  type RuntimeBundle, type ValidationIssue,
} from '@govplane/cli';
import { requireActivation } from '../activation/guard.js';
import { compileBundle } from '../build/compile.js';
import { checkBuildReadiness } from '../build/readiness.js';
import { readVerificationConfig } from '../config/signing.js';
import { loadDraft, resolveDraftFile } from '../drafts/store.js';
import {
  buildContext, formatContext, referencedContextKeys, unusedContextKeys,
} from '../simulate/context.js';
import {
  createSimulator, TRACE_LEVELS, type Simulator, type TraceLevel,
} from '../simulate/engine.js';
import { readSimulateConfig, type SimulateConfig } from '../simulate/config.js';
import { buildSimulationReport, writeSimulationReport } from '../simulate/report.js';
import {
  checkExpectation, readScenario, readSuite, readTarget,
  type Scenario, type Target,
} from '../simulate/scenarios.js';
import {
  checkSignature, resolveVerificationMaterial, type SignatureCheck,
} from '../simulate/signature.js';

const COMMAND = 'simulate';

/** Recorded in reports so a result can be traced to the engine that produced it. */
const RUNTIME_ENGINE = '@govplane/runtime-sdk';
const DEFAULT_BUNDLE_FILE = 'policy-bundle.json';

const displayPath = (path: string, cwd: string): string => {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
};

const formatTarget = (target: Target): string => (
  `${target.service} / ${target.resource} / ${target.action}`
);

const issueLines = (reporter: Reporter, issues: ValidationIssue[]): string[] => {
  const lines = ['', `${issues.length} problem${issues.length === 1 ? '' : 's'}:`];
  issues.forEach((issue, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${issue.path.replace(/^\$\./, '')}`);
    lines.push(`   ${issue.message}`);
    lines.push(`   ${reporter.muted(issue.code)}`);
  });
  return lines;
};

interface SimulationInput {
  documentType: 'bundle' | 'draft';
  path: string;
  bundle: RuntimeBundle;
}

/**
 * Resolves what to simulate against.
 *
 * Precedence: explicit bundle, explicit draft, configured bundle, default
 * bundle, configured draft, default draft. A bundle wins over a draft because
 * it is the artifact that actually ships.
 */
const resolveInput = (
  context: CommandContext,
  project: ReturnType<typeof resolveProject>,
  generatedAt: string,
): SimulationInput => {
  const bundleFlag = readString(context.options, 'bundle');
  const draftFlag = readString(context.options, 'draft');

  if (bundleFlag !== undefined && draftFlag !== undefined) {
    throw new CliError('Options --bundle and --draft cannot be used together.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: ['', 'Simulate against one document at a time.'],
    });
  }

  const workingFolder = project.workingFolder.path;

  const loadBundleFile = (path: string): SimulationInput => {
    const parsed = parseJson(readTextFile(path));
    if (!parsed.ok) {
      throw new CliError(`The bundle is not valid JSON: ${path}`, {
        code: 'BUNDLE_INVALID_JSON',
        exitCode: ExitCode.FileError,
        details: ['', parsed.message],
      });
    }
    return { documentType: 'bundle', path, bundle: parsed.value as RuntimeBundle };
  };

  /**
   * A draft is compiled in memory before evaluation.
   *
   * Simulation always runs against a runtime bundle, so drafts go through the
   * same compilation `build` performs. Testing a draft therefore tests what
   * building it would produce, not an approximation of it.
   */
  const loadDraftFile = (path: string): SimulationInput => {
    const draft = loadDraft(path, generatedAt);
    const readiness = checkBuildReadiness(draft.document);

    if (readiness.length > 0) {
      throw new CliError(
        `The draft cannot be simulated: ${readiness.length} `
          + `field${readiness.length === 1 ? '' : 's'} required for evaluation `
          + `${readiness.length === 1 ? 'is' : 'are'} missing or invalid.`,
        {
          code: 'DRAFT_NOT_SIMULATABLE',
          exitCode: ExitCode.Compatibility,
          details: [
            ...issueLines(context.reporter, readiness),
            '',
            'Complete the draft, then simulate again.',
          ],
        },
      );
    }

    return {
      documentType: 'draft',
      path,
      bundle: compileBundle({ draft: draft.document, generatedAt, bundleVersion: 1 }),
    };
  };

  if (bundleFlag !== undefined) {
    return loadBundleFile(resolve(workingFolder, bundleFlag));
  }
  if (draftFlag !== undefined) {
    return loadDraftFile(resolve(workingFolder, draftFlag));
  }

  const configuredBundle = resolve(
    workingFolder,
    project.config.bundle?.path ?? DEFAULT_BUNDLE_FILE,
  );
  if (existsSync(configuredBundle)) {
    return loadBundleFile(configuredBundle);
  }

  const configuredDraft = resolveDraftFile(workingFolder, project.config);
  if (existsSync(configuredDraft)) {
    return loadDraftFile(configuredDraft);
  }

  throw new CliError(`No bundle or draft was found in ${workingFolder}`, {
    code: 'DOCUMENT_NOT_FOUND',
    exitCode: ExitCode.FileError,
    details: [
      '',
      'Expected:',
      `  ${DEFAULT_BUNDLE_FILE}`,
      '  policy-drafts.json',
      '',
      'Point at one with --bundle <path> or --draft <path>.',
    ],
  });
};

/** Reads the scenarios to run: a suite, a scenario file, or flags. */
const resolveScenarios = (context: CommandContext, workingFolder: string): Scenario[] => {
  const suitePath = readString(context.options, 'suite');
  const scenarioPath = readString(context.options, 'scenario');

  if (suitePath !== undefined && scenarioPath !== undefined) {
    throw new CliError('Options --suite and --scenario cannot be used together.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
    });
  }

  const readDocument = (path: string, label: string): unknown => {
    const resolved = resolve(workingFolder, path);
    if (!existsSync(resolved)) {
      throw new CliError(`${label} file not found: ${resolved}`, {
        code: 'SCENARIO_NOT_FOUND',
        exitCode: ExitCode.FileError,
      });
    }
    const parsed = parseJson(readTextFile(resolved));
    if (!parsed.ok) {
      throw new CliError(`The ${label.toLowerCase()} file is not valid JSON: ${resolved}`, {
        code: 'INVALID_SCENARIO',
        exitCode: ExitCode.Compatibility,
        details: ['', parsed.message],
      });
    }
    return parsed.value;
  };

  if (suitePath !== undefined) {
    return readSuite(readDocument(suitePath, 'Suite'), suitePath).scenarios;
  }

  if (scenarioPath !== undefined) {
    return [readScenario(readDocument(scenarioPath, 'Scenario'), scenarioPath, scenarioPath)];
  }

  // A single evaluation described entirely by flags.
  const targetJson = readString(context.options, 'target');
  const parts = {
    service: readString(context.options, 'service'),
    resource: readString(context.options, 'resource'),
    action: readString(context.options, 'action'),
  };
  const usesParts = Object.values(parts).some((value) => value !== undefined);

  if (targetJson !== undefined && usesParts) {
    throw new CliError('--target cannot be combined with --service, --resource or --action.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
    });
  }

  const evaluationContext = buildContext({
    inline: readString(context.options, 'context'),
    file: readString(context.options, 'context-file'),
    values: readList(context.options, 'context-value'),
    cwd: workingFolder,
  }) ?? {};

  if (targetJson !== undefined) {
    const parsed = parseJson(targetJson);
    if (!parsed.ok) {
      throw new CliError('--target is not valid JSON.', {
        code: 'INVALID_ARGUMENTS',
        exitCode: ExitCode.InvalidArguments,
        details: ['', parsed.message],
      });
    }
    return [{
      name: 'Simulation',
      target: readTarget(parsed.value, '--target'),
      context: evaluationContext,
    }];
  }

  if (!usesParts) {
    throw new CliError('Nothing to simulate.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        'Describe an evaluation with --service, --resource and --action,',
        'or run a scenario with --scenario <path> or --suite <path>.',
        '',
        'For example:',
        '  govplane simulate --service auth --resource login --action authenticate',
      ],
    });
  }

  return [{
    name: 'Simulation',
    target: readTarget(parts, 'target'),
    context: evaluationContext,
  }];
};

const resolveTrace = (context: CommandContext, config: SimulateConfig): TraceLevel => {
  const requested = readOptional(context.options, 'trace');

  // A bare `--trace` means "show me", without a strong opinion on how much.
  if (requested === true) {
    return 'sampled';
  }
  if (requested === undefined) {
    return (config.defaultTrace ?? 'off') as TraceLevel;
  }
  return requested as TraceLevel;
};

interface ScenarioOutcome {
  scenario: Scenario;
  decision: Record<string, unknown>;
  trace?: Record<string, unknown> | undefined;
  passed: boolean;
  mismatches: { field: string; expected: string; actual: string }[];
}

const runScenario = (
  simulator: Simulator,
  scenario: Scenario,
  trace: TraceLevel,
): ScenarioOutcome => {
  const evaluation = simulator.evaluate(scenario.target, scenario.context, trace);
  const expectation = checkExpectation(scenario.expected, evaluation.decision);

  return {
    scenario,
    decision: evaluation.decision,
    ...(evaluation.trace === undefined ? {} : { trace: evaluation.trace }),
    passed: expectation.passed,
    mismatches: expectation.mismatches,
  };
};

const printDecision = (
  reporter: Reporter,
  outcome: ScenarioOutcome,
  redactFields: string[],
): void => {
  const { decision } = outcome;

  reporter.line('Context:');
  reporter.lines(formatContext(outcome.scenario.context, redactFields));
  reporter.line();
  reporter.line('Decision:');
  reporter.line(`  decision: ${String(decision.decision)}`);
  reporter.line(`  reason: ${String(decision.reason)}`);

  reporter.line();
  reporter.line('Match:');

  // A decision with reason "default" is the absence of a match, however it is
  // labelled. Printing a policy and an em dash for the rule would read as a
  // partial match and hide the fact that no rule fired at all.
  if (decision.reason === 'rule') {
    reporter.line(`  Policy: ${String(decision.policyKey)}`);
    reporter.line(`  Rule: ${String(decision.ruleId)}`);
  } else if (decision.policyKey !== undefined) {
    reporter.line('  No rule matched this target.');
    reporter.line(`  The default effect of "${String(decision.policyKey)}" applied.`);
  } else {
    reporter.line('  No policy matched this target.');
    reporter.line(`  The runtime fell back to: ${String(decision.decision)}`);
  }

  if (decision.value !== undefined) {
    reporter.line();
    reporter.line('Custom effect:');
    reporter.line(`  value: ${String(decision.value)}`);
  }
};

const printTrace = (reporter: Reporter, trace: Record<string, unknown>): void => {
  reporter.line();
  reporter.line('Evaluation trace:');
  reporter.line(`  Policies seen: ${String((trace.summary as Record<string, unknown>)?.policiesSeen ?? '—')}`);
  reporter.line(`  Rules seen:    ${String((trace.summary as Record<string, unknown>)?.rulesSeen ?? '—')}`);
  reporter.line(`  Matched:       ${String((trace.summary as Record<string, unknown>)?.matched ?? '—')}`);

  const {rules} = trace;
  if (Array.isArray(rules) && rules.length > 0) {
    reporter.line();
    reporter.line('  Rules considered:');
    rules.forEach((entry) => {
      const rule = entry as Record<string, unknown>;
      const state = rule.matched === true
        ? 'matched'
        : `skipped (${String(rule.discardedReason ?? 'no reason given')})`;
      reporter.line(`    ${String(rule.policyKey)} / ${String(rule.ruleId)}  `
        + `priority ${String(rule.priority)}  ${state}`);
    });
  }

  const winner = trace.winner as Record<string, unknown> | undefined;
  if (winner !== undefined) {
    reporter.line();
    reporter.line('  Selected:');
    reporter.line(`    ${String(winner.policyKey)} / ${String(winner.ruleId)} `
      + `(priority ${String(winner.priority)}, effect ${String(winner.effectType)})`);
  }
};

const printSignature = (reporter: Reporter, signature: SignatureCheck): void => {
  reporter.line();
  reporter.line('Signature:');
  reporter.line(`  ${signature.status}${
    signature.keyId === undefined ? '' : ` (${signature.algorithm}, ${signature.keyId})`
  }`);
  if (signature.reason !== undefined) {
    reporter.line(`  ${reporter.muted(signature.reason)}`);
  }
};

const run = (context: CommandContext): ExitCodeValue => {
  requireActivation(context, COMMAND);

  const { reporter } = context;
  const project = resolveProject(context);
  const config = readSimulateConfig(project.configPath);
  const startedAt = context.now();
  const generatedAt = startedAt.toISOString();

  const input = resolveInput(context, project, generatedAt);
  reporter.debug(`Input: ${input.path} (${input.documentType})`);

  // A bundle is validated the way the runtime would see it; a draft was already
  // checked for readiness and compiled, so it cannot be invalid here.
  if (input.documentType === 'bundle') {
    const validation = validateBundle(input.bundle, { scope: 'optional' });
    if (validation.issues.errors.length > 0) {
      throw new CliError(
        `The bundle failed validation with ${validation.issues.errors.length} `
          + `error${validation.issues.errors.length === 1 ? '' : 's'}. Nothing was simulated.`,
        {
          code: 'BUNDLE_VALIDATION_FAILED',
          exitCode: ExitCode.Compatibility,
          details: issueLines(reporter, validation.issues.errors),
        },
      );
    }
  }

  // Signature verification, when a signing configuration is pinned.
  //
  // Only a bundle can be verified. A draft is the authoring source: it was
  // compiled in memory a moment ago and has no signature by construction, so
  // there is nothing a pinned key could say about it.
  const skipSignature = readBoolean(context.options, 'skip-signature-verification');
  const material = skipSignature || input.documentType === 'draft'
    ? { pinned: false }
    : resolveVerificationMaterial(
      project.config,
      readVerificationConfig(project.configPath),
      context.env,
      project.workingFolder.path,
    );

  const signature = input.documentType === 'draft'
    ? { status: 'skipped' as const, reason: 'A draft is compiled locally and is never signed.' }
    : checkSignature(input.bundle, material);

  if (skipSignature) {
    reporter.error('Warning: Bundle signature verification was skipped.');
    reporter.error('Simulation results must not be considered trusted.');
    reporter.error('');
  } else if (signature.status === 'invalid' || signature.status === 'missing') {
    throw new CliError(
      signature.status === 'missing'
        ? 'The bundle carries no signature, but a signing configuration is pinned.'
        : 'The bundle signature is not valid.',
      {
        code: signature.status === 'missing' ? 'SIGNATURE_MISSING' : 'SIGNATURE_INVALID',
        exitCode: ExitCode.Compatibility,
        details: [
          '',
          signature.reason ?? 'The bundle may have been modified after it was signed.',
          '',
          'To simulate anyway, and accept that the results are untrusted:',
          '  govplane simulate --skip-signature-verification',
        ],
      },
    );
  }

  const scenarios = resolveScenarios(context, project.workingFolder.path);
  const trace = resolveTrace(context, config);
  const redactFields = config.redactContextFields ?? [];

  const simulator = createSimulator(input.bundle, {
    ...(config.validateContext === undefined
      ? {}
      : { validateContext: config.validateContext }),
    ...(config.contextPolicy === undefined ? {} : { contextPolicy: config.contextPolicy }),
    ...(config.parseCustomEffect === undefined
      ? {}
      : { parseCustomEffect: config.parseCustomEffect }),
  });

  // A key no rule reads is almost always a typo, and produces a decision that
  // looks inexplicable rather than wrong. Worth saying; not worth failing over.
  const referenced = referencedContextKeys(input.bundle);
  const strayKeys = [...new Set(
    scenarios.flatMap((scenario) => unusedContextKeys(scenario.context, referenced)),
  )];

  if (strayKeys.length > 0 && !reporter.quiet && reporter.format === 'text') {
    reporter.line(reporter.muted(
      `Note: no rule reads ${strayKeys.join(', ')}. `
      + `This bundle reads: ${referenced.join(', ')}.`,
    ));
    reporter.line();
  }

  const outcomes = scenarios.map((scenario) => runScenario(simulator, scenario, trace));
  const failed = outcomes.filter((outcome) => !outcome.passed);
  const asserted = outcomes.filter((outcome) => outcome.scenario.expected !== undefined);
  const durationMs = Date.now() - startedAt.getTime();

  const reportRequest = readOptional(context.options, 'report');
  let reportFile: string | null = null;
  if (reportRequest !== undefined) {
    const directory = config.reportsDirectory ?? '.govplane/reports';
    reportFile = typeof reportRequest === 'string'
      ? resolve(project.workingFolder.path, reportRequest)
      : resolve(
        project.workingFolder.path,
        directory,
        `simulation-${fileTimestamp(startedAt)}.json`,
      );

    writeSimulationReport(reportFile, buildSimulationReport({
      cliVersion: readCliVersion(),
      runtimeEngine: RUNTIME_ENGINE,
      executedAt: generatedAt,
      durationMs,
      documentType: input.documentType,
      documentPath: input.path,
      bundleVersion: input.bundle.bundleVersion,
      checksum: input.bundle.checksum,
      signature,
      redactFields,
      outcomes,
    }));
  }

  const outcome = failed.length > 0 ? ExitCode.Failure : ExitCode.Success;

  if (reporter.format === 'json') {
    reporter.json({
      success: failed.length === 0,
      input: {
        documentType: input.documentType,
        documentPath: input.path,
      },
      signature: {
        status: signature.status,
        ...(signature.algorithm === undefined ? {} : { algorithm: signature.algorithm }),
        ...(signature.keyId === undefined ? {} : { keyId: signature.keyId }),
      },
      scenarios: outcomes.map((entry) => ({
        name: entry.scenario.name,
        target: entry.scenario.target,
        result: entry.decision,
        expectation: {
          defined: entry.scenario.expected !== undefined,
          passed: entry.passed,
          ...(entry.mismatches.length === 0 ? {} : { mismatches: entry.mismatches }),
        },
        ...(entry.trace === undefined ? {} : { trace: entry.trace }),
      })),
      summary: {
        total: outcomes.length,
        asserted: asserted.length,
        passed: outcomes.length - failed.length,
        failed: failed.length,
        durationMs,
      },
      ...(reportFile === null ? {} : { reportPath: reportFile }),
    });
    return outcome;
  }

  // A single evaluation reads as a result; a suite reads as a test run.
  if (outcomes.length === 1 && scenarios[0]?.expected === undefined) {
    const [only] = outcomes as [ScenarioOutcome];

    if (!reporter.quiet) {
      reporter.line(reporter.heading('Govplane Simulation'));
      reporter.line();
      reporter.line('Input:');
      reporter.line(`  ${input.documentType === 'bundle' ? 'Bundle' : 'Draft'}: ${displayPath(input.path, context.cwd)}`);
      reporter.line(`  Target: ${formatTarget(only.scenario.target)}`);
      if (material.pinned || skipSignature) {
        printSignature(reporter, signature);
      }
      reporter.line();
      printDecision(reporter, only, redactFields);
      if (only.trace !== undefined) {
        printTrace(reporter, only.trace);
      }
      if (reportFile !== null) {
        reporter.line();
        reporter.line('Report:');
        reporter.line(`  ${displayPath(reportFile, context.cwd)}`);
      }
      reporter.line();
      reporter.line('Result:');
      reporter.line(`  ${reporter.success('Simulation completed successfully')}`);
    }
    return outcome;
  }

  if (!reporter.quiet) {
    reporter.line(reporter.heading('Govplane Simulation'));
    reporter.line();
    reporter.line(`Input: ${displayPath(input.path, context.cwd)}`);
    if (material.pinned || skipSignature) {
      printSignature(reporter, signature);
    }
    reporter.line();

    outcomes.forEach((entry) => {
      const mark = entry.passed ? reporter.success('pass') : reporter.failure('FAIL');
      reporter.line(`${mark}  ${entry.scenario.name}`);
      reporter.line(`      ${formatTarget(entry.scenario.target)} → ${String(entry.decision.decision)}`
        + ` (${String(entry.decision.reason)})`);
      if (entry.trace !== undefined) {
        printTrace(reporter, entry.trace);
      }
    });

    reporter.line();
    reporter.line('Summary:');
    reporter.line(`  Scenarios: ${outcomes.length}`);
    reporter.line(`  Passed: ${outcomes.length - failed.length}`);
    reporter.line(`  Failed: ${failed.length}`);
    reporter.line(`  Duration: ${durationMs}ms`);

    if (reportFile !== null) {
      reporter.line();
      reporter.line('Report:');
      reporter.line(`  ${displayPath(reportFile, context.cwd)}`);
    }
  }

  // Failures are reported even in quiet mode: a silent failing suite would be
  // worse than no suite.
  failed.forEach((entry) => {
    reporter.error('');
    reporter.error(`Scenario failed: ${entry.scenario.name}`);
    entry.mismatches.forEach((mismatch) => {
      reporter.error('');
      reporter.error(`  Expected ${mismatch.field}: ${mismatch.expected}`);
      reporter.error(`  Actual   ${mismatch.field}: ${mismatch.actual}`);
    });
  });

  return outcome;
};

export const simulateCommand: CommandDefinition = {
  name: 'simulate',
  summary: 'Simulate policy evaluations locally',
  usage: 'govplane simulate [options]',
  description: 'Evaluate targets and contexts against a bundle or draft using the Govplane '
    + 'runtime engine, so policy behaviour can be checked before it ships.',
  requiresToolkit: true,
  options: [
    {
      name: 'bundle',
      type: 'string',
      placeholder: '<path>',
      description: 'Bundle to simulate against',
    },
    {
      name: 'draft',
      type: 'string',
      placeholder: '<path>',
      description: 'Draft to simulate against',
    },
    {
      name: 'scenario', type: 'string', placeholder: '<path>', description: 'Scenario file to run',
    },
    {
      name: 'suite',
      type: 'string',
      placeholder: '<path>',
      description: 'Suite of scenarios to run',
    },
    {
      name: 'target', type: 'string', placeholder: '<json>', description: 'Target as a JSON object',
    },
    {
      name: 'service', type: 'string', placeholder: '<value>', description: 'Target service',
    },
    {
      name: 'resource', type: 'string', placeholder: '<value>', description: 'Target resource',
    },
    {
      name: 'action', type: 'string', placeholder: '<value>', description: 'Target action',
    },
    {
      name: 'context',
      type: 'string',
      placeholder: '<json>',
      description: 'Context as a JSON object',
    },
    {
      name: 'context-file',
      type: 'string',
      placeholder: '<path>',
      description: 'Context from a JSON file',
    },
    {
      name: 'context-value',
      type: 'string',
      placeholder: '<key=value>',
      description: 'One context value; repeatable',
      repeatable: true,
    },
    {
      name: 'trace',
      type: 'string',
      placeholder: '<level>',
      choices: [...TRACE_LEVELS],
      optionalValue: true,
      description: 'Explain the evaluation (off, errors, sampled, full)',
    },
    {
      name: 'skip-signature-verification',
      type: 'boolean',
      description: 'Simulate without verifying the bundle signature',
    },
    {
      name: 'report',
      type: 'string',
      placeholder: '<path>',
      optionalValue: true,
      description: 'Write a simulation report',
    },
    formatOption,
    ...commonOptions,
  ],
  examples: [
    'govplane simulate --service auth --resource login --action authenticate',
    'govplane simulate --service auth --resource login --action authenticate \\',
    '  --context \'{"failedAttempts":6}\' --trace full',
    'govplane simulate --suite ./simulations/auth-suite.json',
    'govplane simulate --scenario ./simulations/login-blocked.json --format json',
  ],
  run,
};
