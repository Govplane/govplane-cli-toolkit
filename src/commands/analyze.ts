import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  CliError, ExitCode, commonOptions, formatOption, readBoolean, readList, readString,
  resolveProject, type CommandContext, type CommandDefinition, type ExitCodeValue,
  type Reporter, type ValidationIssue,
} from '@govplane/cli';
import { requireActivation } from '../activation/guard.js';
import { readAnalyzeConfig } from '../analyze/config.js';
import {
  compareDiscoveries, loadComparisonBundles,
  type BundleValidationFailure, type ComparedDiscovery,
} from '../analyze/compare.js';
import { consolidate } from '../analyze/consolidate.js';
import { detectCalls, type CallSite, type SourceLocation } from '../analyze/detect.js';
import {
  buildDraftDocument, draftGitState, mergeIntoExisting, readExistingDraft, writeDraft,
  type ExistingDraft,
} from '../analyze/draft.js';
import { createPrompter, type Prompter } from '../analyze/prompt.js';
import { reviewDiscoveries } from '../analyze/review.js';
import { collectSourceFiles } from '../analyze/scanner.js';

const COMMAND = 'analyze';
const DEFAULT_DRAFT_FILE = 'policy-drafts.json';

/** Uncovered statuses — the ones `--check` fails on. */
const UNCOVERED = new Set(['missing', 'partially-covered', 'ambiguous']);

const displayPath = (path: string, cwd: string): string => {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
};

const issueLines = (reporter: Reporter, issues: ValidationIssue[]): string[] => {
  const lines: string[] = [];
  issues.slice(0, 10).forEach((issue) => {
    lines.push(`   ${issue.path.replace(/^\$\./u, '')}: ${issue.message}`);
    lines.push(`   ${reporter.muted(issue.code)}`);
  });
  if (issues.length > 10) {
    lines.push(reporter.muted(`   and ${issues.length - 10} more`));
  }
  return lines;
};

/**
 * The source root to scan.
 *
 * Deliberately independent of the working folder, so governance artifacts can
 * live in a subdirectory while the whole project is scanned — the pattern the
 * spec recommends.
 */
const resolveSource = (context: CommandContext, configured: string | undefined): string => {
  const flag = readString(context.options, 'source');
  if (flag !== undefined) {
    return resolve(context.cwd, flag);
  }
  if (configured !== undefined) {
    return resolve(context.cwd, configured);
  }
  return context.cwd;
};

interface Analysis {
  calls: CallSite[];
  filesScanned: number;
  unresolved: SourceLocation[];
  /** Files that could not be opened. */
  unreadable: string[];
  /** Files that did not tokenize cleanly, reported under `--verbose`. */
  recovered: string[];
}

const analyseSources = (files: string[], sourceRoot: string): Analysis => {
  const calls: CallSite[] = [];
  const unresolved: SourceLocation[] = [];
  const unreadable: string[] = [];
  const recovered: string[] = [];

  files.forEach((file) => {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      unreadable.push(file);
      return;
    }

    // Paths are recorded relative to the scanned root, so a draft committed
    // from one machine reads correctly on another.
    const label = relative(sourceRoot, file).split('\\').join('/');
    const result = detectCalls(source, label === '' ? file : label);

    calls.push(...result.calls);
    unresolved.push(...result.unresolved);
    if (result.recovered) {
      recovered.push(label);
    }
  });

  return {
    calls, filesScanned: files.length, unresolved, unreadable, recovered,
  };
};

const reportBundleFailures = (
  reporter: Reporter,
  failures: BundleValidationFailure[],
  cwd: string,
): never => {
  const details: string[] = [''];
  failures.forEach((failure) => {
    details.push(`${displayPath(failure.path, cwd)}:`);
    details.push(...issueLines(reporter, failure.errors));
    details.push('');
  });
  details.push('A bundle that fails validation cannot be compared against.');
  details.push('Nothing was analysed.');

  throw new CliError(
    `${failures.length} bundle${failures.length === 1 ? '' : 's'} failed validation.`,
    { code: 'BUNDLE_VALIDATION_FAILED', exitCode: ExitCode.Compatibility, details },
  );
};

const statusLabel = (reporter: Reporter, status: string): string => {
  if (status === 'covered') return reporter.success('covered');
  if (status === 'missing') return reporter.failure('missing');
  return reporter.warning(status);
};

const printDiscoveries = (
  reporter: Reporter,
  discoveries: ComparedDiscovery[],
): void => {
  discoveries.forEach((discovery) => {
    reporter.line();
    reporter.line(`  ${statusLabel(reporter, discovery.status)}  ${discovery.id}`);
    reporter.line(`     ${discovery.target.service} / ${discovery.target.resource}`
      + ` / ${discovery.target.action}`);
    const [first] = discovery.sources;
    if (first !== undefined) {
      const more = discovery.sources.length - 1;
      reporter.line(reporter.muted(`     ${first.file}:${first.line}`
        + (more > 0 ? ` and ${more} more location${more === 1 ? '' : 's'}` : '')));
    }
    if (discovery.confidence !== 'high') {
      reporter.line(reporter.muted(`     confidence: ${discovery.confidence}`));
    }
    if (discovery.matchedPolicies.length > 0) {
      reporter.line(reporter.muted(`     existing: ${discovery.matchedPolicies.join(', ')}`));
    }
  });
};

/** CI mode: report what is uncovered and stop. Nothing is written. */
const runCheck = (
  reporter: Reporter,
  discoveries: ComparedDiscovery[],
): ExitCodeValue => {
  const uncovered = discoveries.filter((discovery) => UNCOVERED.has(discovery.status));

  if (reporter.format === 'json') {
    reporter.json({
      success: uncovered.length === 0,
      mode: 'check',
      uncovered: uncovered.length,
      total: discoveries.length,
      drafts: discoveries.map((discovery) => ({
        id: discovery.id,
        status: discovery.status,
        confidence: discovery.confidence,
        target: discovery.target,
        sources: discovery.sources,
      })),
    });
    return uncovered.length === 0 ? ExitCode.Success : ExitCode.Failure;
  }

  if (uncovered.length === 0) {
    reporter.line(reporter.success(
      discoveries.length === 0
        ? 'No policy evaluation points found.'
        : `All ${discoveries.length} discovered policy draft${discoveries.length === 1 ? ' is' : 's are'} covered.`,
    ));
    return ExitCode.Success;
  }

  reporter.line(`Found ${uncovered.length} uncovered policy draft${uncovered.length === 1 ? '' : 's'}`);
  uncovered.forEach((discovery) => {
    reporter.line();
    reporter.line(`${discovery.target.service} / ${discovery.target.resource}`
      + ` / ${discovery.target.action}`);
    const [first] = discovery.sources;
    if (first !== undefined) {
      reporter.line(`${first.file}:${first.line}`);
    }
  });

  return ExitCode.Failure;
};

/**
 * Decides how to treat an existing draft file.
 *
 * The spec requires confirmation before overwriting, and a warning when the
 * file carries uncommitted work. Without a terminal to ask, the command stops
 * and names the flag that settles it: silently overwriting a developer's drafts
 * because nobody was there to object is the one outcome to rule out.
 */
const resolveDisposition = async (
  context: CommandContext,
  existing: ExistingDraft,
  prompter: Prompter,
  reporter: Reporter,
): Promise<'overwrite' | 'merge'> => {
  const force = readBoolean(context.options, 'force');
  const merge = readBoolean(context.options, 'merge');

  if (force && merge) {
    throw new CliError('--force and --merge ask for opposite things.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        '--force replaces the existing draft; --merge adds to it. Choose one.',
      ],
    });
  }

  if (force) return 'overwrite';
  if (merge) return 'merge';

  const gitState = draftGitState(existing.path);

  if (!prompter.interactive) {
    const details = [
      '',
      `Existing draft: ${displayPath(existing.path, context.cwd)}`,
    ];
    if (gitState === 'modified') {
      details.push('It has uncommitted changes.');
    } else if (existing.hasAuthoredContent) {
      details.push('It contains policies that have been edited since discovery.');
    }
    details.push(
      '',
      'Choose what should happen to it:',
      '  --merge    add newly discovered targets, keeping everything already there',
      '  --force    replace it with the new analysis',
    );

    throw new CliError('A draft file already exists.', {
      code: 'DRAFT_EXISTS',
      exitCode: ExitCode.Conflict,
      details,
    });
  }

  reporter.line();
  reporter.line(`A draft file already exists: ${displayPath(existing.path, context.cwd)}`);
  if (gitState === 'modified') {
    reporter.line(reporter.warning('It has uncommitted changes that overwriting would lose.'));
  } else if (existing.hasAuthoredContent) {
    reporter.line(reporter.warning('It contains policies that have been edited since discovery.'));
  }

  const answer = await prompter.ask(
    'Add the new discoveries to it, or replace it?',
    ['merge', 'overwrite'],
    'merge',
  );
  return answer === 'overwrite' ? 'overwrite' : 'merge';
};

const run = async (context: CommandContext): Promise<ExitCodeValue> => {
  requireActivation(context, COMMAND);

  const { reporter } = context;
  const project = resolveProject(context);
  const config = readAnalyzeConfig(project.configPath);
  const generatedAt = context.now().toISOString();

  const sourceRoot = resolveSource(context, config.source);
  const check = readBoolean(context.options, 'check');
  const wantsInteractive = readBoolean(context.options, 'interactive');

  reporter.debug(`Source path:    ${sourceRoot}`);
  reporter.debug(`Working folder: ${project.workingFolder.path}`);

  // Bundles are resolved from the working folder, not the source path: they are
  // governance artifacts, and the spec is explicit about where they live.
  const bundlePaths = [
    ...readList(context.options, 'bundle'),
    ...(readList(context.options, 'bundle').length > 0 ? [] : config.bundles ?? []),
  ].map((path) => (isAbsolute(path) ? path : resolve(project.workingFolder.path, path)));

  const { bundles, failures } = loadComparisonBundles(bundlePaths);
  if (failures.length > 0) {
    reportBundleFailures(reporter, failures, context.cwd);
  }
  reporter.debug(`Bundles compared: ${bundles.length}`);

  const scan = collectSourceFiles(sourceRoot, {
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
  });
  reporter.debug(`Files scanned: ${scan.files.length}`);

  const analysis = analyseSources(scan.files, sourceRoot);
  const discoveries = compareDiscoveries(consolidate(analysis.calls), bundles);

  analysis.recovered.forEach((file) => {
    reporter.debug(`Partially parsed: ${file}`);
  });
  analysis.unreadable.forEach((file) => {
    reporter.debug(`Could not read: ${file}`);
  });

  if (check) {
    return runCheck(reporter, discoveries);
  }

  // One input surface for the whole invocation. The review loop and the
  // overwrite confirmation both read from the terminal, and two readline
  // interfaces over one stdin fight over the same bytes.
  //
  // Not gated on `--interactive`: the spec requires confirmation before an
  // existing draft is replaced, whether or not the discoveries were reviewed.
  const prompter = createPrompter({
    stdin: context.stdin,
    reporter,
    disabled: reporter.quiet || reporter.format === 'json',
  });

  if (wantsInteractive && !prompter.interactive) {
    prompter.close();
    throw new CliError('--interactive needs a terminal to read from.', {
      code: 'NOT_INTERACTIVE',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        'Run it from a terminal, or drop --interactive to write every discovery.',
      ],
    });
  }

  let selected = discoveries;
  let review;
  let added = selected;
  let skipped: ComparedDiscovery[] = [];
  let disposition: 'overwrite' | 'merge' | 'create' = 'create';
  let document: unknown;
  let draftPath: string;

  try {
    if (wantsInteractive) {
      review = await reviewDiscoveries(discoveries, prompter, reporter);
      selected = review.accepted;
    }

    const outputFlag = readString(context.options, 'output-draft');
    draftPath = resolve(
      project.workingFolder.path,
      outputFlag ?? config.outputDraft ?? project.config.draft?.path ?? DEFAULT_DRAFT_FILE,
    );

    added = selected;
    document = buildDraftDocument(selected, generatedAt);

    const existing = readExistingDraft(draftPath);
    if (existing !== null) {
      disposition = await resolveDisposition(context, existing, prompter, reporter);

      if (disposition === 'merge') {
        const result = mergeIntoExisting(existing, selected, generatedAt);
        document = result.document;
        added = result.added;
        skipped = result.skipped;
      }
    }
  } finally {
    prompter.close();
  }

  writeDraft(draftPath, document);

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      source: sourceRoot,
      workingFolder: project.workingFolder.path,
      draft: { path: draftPath, disposition },
      stats: {
        filesScanned: analysis.filesScanned,
        discovered: discoveries.length,
        written: added.length,
        alreadyPresent: skipped.length,
        unresolvedCalls: analysis.unresolved.length,
      },
      drafts: selected.map((discovery) => ({
        id: discovery.id,
        status: discovery.status,
        confidence: discovery.confidence,
        target: discovery.target,
        availableContext: discovery.availableContext,
        sources: discovery.sources,
      })),
    });
    return ExitCode.Success;
  }

  if (reporter.quiet) {
    return ExitCode.Success;
  }

  reporter.line(reporter.heading('Govplane Analysis'));
  reporter.line();
  reporter.line('Source:');
  reporter.line(`  ${displayPath(sourceRoot, context.cwd)}`);
  reporter.line(`  ${analysis.filesScanned} file${analysis.filesScanned === 1 ? '' : 's'} scanned`);

  if (bundles.length > 0) {
    reporter.line();
    reporter.line('Compared against:');
    bundles.forEach(({ path }) => reporter.line(`  ${displayPath(path, context.cwd)}`));
  }

  if (discoveries.length === 0) {
    reporter.line();
    reporter.line('No Govplane evaluation points were found.');
    reporter.line();
    reporter.line(reporter.muted('The analyzer looks for evaluate() calls on a Govplane client,'));
    reporter.line(reporter.muted(
      'and for any evaluate({ target: { … } }) whatever the client is called.',
    ));
  } else {
    reporter.line();
    reporter.line(`Discovered ${discoveries.length} polic${discoveries.length === 1 ? 'y' : 'ies'}:`);
    printDiscoveries(reporter, selected);
  }

  if (analysis.unresolved.length > 0) {
    reporter.line();
    reporter.line(reporter.warning(
      `${analysis.unresolved.length} evaluation call${analysis.unresolved.length === 1 ? '' : 's'} `
      + 'could not be read:',
    ));
    analysis.unresolved.slice(0, 5).forEach((location) => {
      reporter.line(reporter.muted(`  ${location.file}:${location.line}`));
    });
    reporter.line(reporter.muted('  The target was not a literal object at the call site.'));
  }

  if (review !== undefined) {
    if (review.ignored.length > 0) {
      reporter.line();
      reporter.line(`Ignored ${review.ignored.length} draft${review.ignored.length === 1 ? '' : 's'}.`);
    }
    review.renamed.forEach((entry) => {
      reporter.line(reporter.muted(`  renamed ${entry.from} → ${entry.to}`));
    });
    review.merged.forEach((entry) => {
      reporter.line(reporter.muted(`  merged ${entry.from} into ${entry.into}`));
    });
  }

  reporter.line();
  reporter.line('Draft:');
  reporter.line(`  ${displayPath(draftPath, context.cwd)}`
    + (disposition === 'merge' ? '  (merged)' : ''));
  if (disposition === 'merge') {
    reporter.line(`  ${added.length} added, ${skipped.length} already present`);
  }

  reporter.line();
  reporter.line('Result:');
  reporter.line(`  ${reporter.success('Analysis completed successfully')}`);

  if (selected.length > 0) {
    reporter.line();
    reporter.line(reporter.muted('Drafts carry no rules — analyze never invents them.'));
    reporter.line(reporter.muted(
      'Add rules with "govplane policies add-rule", then run "govplane build".',
    ));
  }

  return ExitCode.Success;
};

export const analyzeCommand: CommandDefinition = {
  name: 'analyze',
  summary: 'Discover policy evaluation points in source code',
  usage: 'govplane analyze [options]',
  description: 'Statically analyse an application for Govplane evaluate() calls, compare what '
    + 'is found against existing bundles, and write a reviewable policy draft.',
  requiresToolkit: true,
  options: [
    {
      name: 'source',
      type: 'string',
      placeholder: '<path>',
      description: 'Root directory to scan (default: current directory)',
    },
    {
      name: 'output-draft',
      type: 'string',
      placeholder: '<path>',
      description: 'Where to write the draft',
    },
    {
      name: 'bundle',
      type: 'string',
      placeholder: '<path>',
      description: 'Bundle to compare against; repeatable',
      repeatable: true,
    },
    {
      name: 'check',
      type: 'boolean',
      description: 'Report uncovered drafts and exit non-zero (CI mode)',
    },
    {
      name: 'interactive',
      type: 'boolean',
      description: 'Step through each discovery',
    },
    {
      name: 'merge',
      type: 'boolean',
      description: 'Add new discoveries to an existing draft',
    },
    {
      name: 'force',
      type: 'boolean',
      description: 'Replace an existing draft',
    },
    formatOption,
    ...commonOptions,
  ],
  examples: [
    'govplane analyze --source .',
    'govplane analyze --source . --working-folder ./governance',
    'govplane analyze --bundle ./policy-bundle.json',
    'govplane analyze --check',
    'govplane analyze --interactive',
  ],
  run,
};
