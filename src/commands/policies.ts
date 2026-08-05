import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  CliError, ExitCode, commonOptions, formatOption, parseJson, readBoolean, readString,
  readTextFile, resolveProject, validateDraft,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
  type ValidationIssue,
} from '@govplane/cli';
import { activationSummary, requireActivation } from '../activation/guard.js';
import {
  addPolicy, addRule, assertValidDraft, buildDefaults, readPolicyPayload, readRulePayload,
  removePolicy, updatePolicy, updateRule,
} from '../drafts/mutations.js';
import {
  emptyDraft, findPolicy, loadDraft, nextVersionedPath, readDraftFile, resolveDraftFile,
  resolveVersioning, writeDraft,
} from '../drafts/store.js';
import { draftStats, type DraftDocument, type DraftPolicy } from '../drafts/types.js';

const COMMAND = 'policies';

const SUBCOMMANDS = [
  'create-file',
  'list',
  'add-policy',
  'update-policy',
  'remove-policy',
  'add-rule',
  'update-rule',
  'validate',
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

/** Everything a subcommand needs, resolved once. */
interface DraftContext {
  context: CommandContext;
  draftPath: string;
  versioned: boolean;
  generatedAt: string;
}

const prepare = (context: CommandContext, options: { write: boolean }): DraftContext => {
  const project = resolveProject(context, { requireWritable: options.write });
  const draftPath = resolveDraftFile(
    project.workingFolder.path,
    project.config,
    readString(context.options, 'draft'),
  );

  const versionedFlag = context.options.versioned;
  const versioned = resolveVersioning(
    project.config,
    typeof versionedFlag === 'boolean' ? { versioned: versionedFlag } : {},
  );

  context.reporter.debug(`Draft file: ${draftPath}`);
  if (versioned) {
    context.reporter.debug('Draft versioning: enabled');
  }

  return {
    context, draftPath, versioned, generatedAt: context.now().toISOString(),
  };
};

const displayPath = (path: string, cwd: string): string => {
  const relativePath = relative(cwd, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
};

const requireOption = (context: CommandContext, name: string): string => {
  const value = readString(context.options, name);
  if (value === undefined || value.trim() === '') {
    throw new CliError(`--${name} is required.`, {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: ['', 'See the supported options with:', '  govplane help policies'],
    });
  }
  return value;
};

const readJsonInput = (
  context: CommandContext,
  fileOption: string,
  inlineOption: string,
  label: string,
): unknown => {
  const inline = readString(context.options, inlineOption);
  if (inline !== undefined) {
    const parsed = parseJson(inline);
    if (!parsed.ok) {
      throw new CliError(`--${inlineOption} is not valid JSON.`, {
        code: 'INVALID_DRAFT_SCHEMA',
        exitCode: ExitCode.Compatibility,
        details: ['', parsed.message],
      });
    }
    return parsed.value;
  }

  const file = readString(context.options, fileOption);
  if (file === undefined) {
    throw new CliError(`A ${label} is required.`, {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: ['', `Supply one with --${fileOption} <path> or --${inlineOption} '<json>'.`],
    });
  }

  const path = resolve(context.cwd, file);
  const parsed = parseJson(readTextFile(path));
  if (!parsed.ok) {
    throw new CliError(`The ${label} file is not valid JSON: ${path}`, {
      code: 'INVALID_DRAFT_SCHEMA',
      exitCode: ExitCode.Compatibility,
      details: ['', parsed.message],
    });
  }
  return parsed.value;
};

/** Reads the `defaults` block from either the dedicated flags or a payload. */
const readDefaults = (context: CommandContext): DraftPolicy['defaults'] | undefined => {
  const effect = readString(context.options, 'defaults-effect');
  if (effect === undefined) {
    return undefined;
  }

  return buildDefaults({
    effect,
    killSwitchService: readString(context.options, 'kill-switch-service'),
    killSwitchReason: readString(context.options, 'kill-switch-reason'),
    throttleLimit: readString(context.options, 'throttle-limit'),
    throttleWindowSeconds: readString(context.options, 'throttle-window-seconds'),
    throttleKey: readString(context.options, 'throttle-key'),
    customEffect: readString(context.options, 'custom-effect'),
  });
};

const readActiveVersion = (context: CommandContext): number | undefined => {
  const raw = readString(context.options, 'active-version');
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError('--active-version must be a positive whole number.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
    });
  }
  return parsed;
};

/**
 * Writes a mutated draft, after checking it against the draft validator.
 *
 * `previous` is the document as it was, so only problems this edit introduced
 * block the write. An `analyze` draft is deliberately incomplete until a
 * developer supplies the effects, and every edit toward completing it must be
 * allowed to land.
 */
const persist = (
  draft: DraftContext,
  document: DraftDocument,
  summary: { action: string; details: Record<string, unknown>; lines: string[] },
  previous?: DraftDocument,
): ExitCodeValue => {
  assertValidDraft(document, previous);

  const written = writeDraft(draft.draftPath, document, { versioned: draft.versioned });
  const { reporter } = draft.context;
  const stats = draftStats(document);

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      action: summary.action,
      draftFile: written.path,
      versioned: written.versioned,
      ...summary.details,
      stats,
    });
    return ExitCode.Success;
  }

  reporter.lines(summary.lines);
  reporter.line();
  reporter.line(`Draft file: ${displayPath(written.path, draft.context.cwd)}`);
  if (written.versioned) {
    reporter.line(reporter.muted('  (written as a new version; the previous file is unchanged)'));
  }
  return ExitCode.Success;
};

const createFile = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const force = readBoolean(context.options, 'force');
  const env = readString(context.options, 'env');

  if (existsSync(draft.draftPath) && !draft.versioned && !force) {
    throw new CliError(`A draft file already exists: ${draft.draftPath}`, {
      code: 'DRAFT_FILE_EXISTS',
      exitCode: ExitCode.Conflict,
      details: [
        '',
        'Use --force to replace it, or --versioned to write the next version instead.',
      ],
    });
  }

  const document = emptyDraft(draft.generatedAt, env);
  const written = writeDraft(draft.draftPath, document, { versioned: draft.versioned });

  if (context.reporter.format === 'json') {
    context.reporter.json({
      success: true,
      action: 'create-file',
      draftFile: written.path,
      versioned: written.versioned,
    });
    return ExitCode.Success;
  }

  context.reporter.line(`Draft file created: ${displayPath(written.path, context.cwd)}`);
  context.reporter.line();
  context.reporter.line('Add your first policy with:');
  context.reporter.line(
    '  govplane policies add-policy --policy-key <key> --defaults-effect allow',
  );
  return ExitCode.Success;
};

const list = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: false });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);
  const { reporter } = context;
  const { document } = loaded;

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      draftFile: loaded.path,
      shape: loaded.shape,
      ...(document.env === undefined ? {} : { env: document.env }),
      policies: document.policies.map((policy) => ({
        policyKey: policy.policyKey,
        activeVersion: policy.activeVersion,
        defaultsEffect: policy.defaults?.effect ?? null,
        rules: policy.rules?.length ?? 0,
      })),
    });
    return ExitCode.Success;
  }

  reporter.line(reporter.heading('Govplane Policies'));
  reporter.line();
  reporter.line(`Draft file: ${displayPath(loaded.path, context.cwd)}`);
  if (loaded.shape === 'analyze') {
    reporter.line(reporter.muted('  (an analyze document, shown in build-ready form)'));
  }
  reporter.line();
  reporter.line(`Policies: ${document.policies.length}`);
  reporter.line();

  if (document.policies.length === 0) {
    reporter.line('This draft has no policies yet.');
    reporter.line();
    reporter.line('Add one with:');
    reporter.line('  govplane policies add-policy --policy-key <key> --defaults-effect allow');
    return ExitCode.Success;
  }

  const rows = document.policies.map((policy) => [
    policy.policyKey,
    String(policy.activeVersion ?? 1),
    policy.defaults?.effect ?? '—',
    String(policy.rules?.length ?? 0),
  ]);
  const headers = ['KEY', 'ACTIVE VERSION', 'DEFAULT EFFECT', 'RULES'];
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => (row[index] ?? '').length),
  ));
  const renderRow = (cells: string[]): string => cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 0, ' '))
    .join('  ')
    .trimEnd();

  reporter.line(renderRow(headers));
  rows.forEach((row) => reporter.line(renderRow(row)));

  if (reporter.verbose) {
    document.policies.forEach((policy) => {
      reporter.line();
      reporter.line(`${policy.policyKey}:`);
      const rules = policy.rules ?? [];
      if (rules.length === 0) {
        reporter.line('  (no rules)');
        return;
      }
      rules.forEach((rule) => {
        const target = rule.target === undefined
          ? '—'
          : `${rule.target.service} / ${rule.target.resource} / ${rule.target.action}`;
        reporter.line(`  ${rule.id}  priority ${rule.priority}  ${target}  ${rule.effect?.type}`);
      });
    });
  }

  return ExitCode.Success;
};

const addPolicyCommand = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);

  const payloadOption = readString(context.options, 'policy-file')
    ?? readString(context.options, 'policy-json');

  const input = payloadOption === undefined
    ? {
      policyKey: requireOption(context, 'policy-key'),
      defaults: readDefaults(context) ?? ((): never => {
        throw new CliError('--defaults-effect is required.', {
          code: 'INVALID_ARGUMENTS',
          exitCode: ExitCode.InvalidArguments,
          details: ['', 'For example: --defaults-effect allow'],
        });
      })(),
      ...(readActiveVersion(context) === undefined
        ? {}
        : { activeVersion: readActiveVersion(context) as number }),
      friendlyName: readString(context.options, 'friendly-name'),
      description: readString(context.options, 'description'),
    }
    : readPolicyPayload(readJsonInput(context, 'policy-file', 'policy-json', 'policy payload'));

  const document = addPolicy(loaded.document, input);

  return persist(draft, document, {
    action: 'add-policy',
    details: { policyKey: input.policyKey },
    lines: [
      `Policy added: ${input.policyKey}`,
      '',
      `Active version: ${input.activeVersion ?? 1}`,
      `Defaults effect: ${input.defaults.effect}`,
    ],
  }, loaded.document);
};

const updatePolicyCommand = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);
  const policyKey = requireOption(context, 'policy-key');

  const document = updatePolicy(loaded.document, {
    policyKey,
    defaults: readDefaults(context),
    activeVersion: readActiveVersion(context),
    friendlyName: readString(context.options, 'friendly-name'),
    description: readString(context.options, 'description'),
  });

  const updated = findPolicy(document, policyKey) as DraftPolicy;

  return persist(draft, document, {
    action: 'update-policy',
    details: { policyKey },
    lines: [
      `Policy updated: ${policyKey}`,
      '',
      `Active version: ${updated.activeVersion}`,
      `Defaults effect: ${updated.defaults?.effect ?? 'not set'}`,
    ],
  }, loaded.document);
};

const removePolicyCommand = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);
  const policyKey = requireOption(context, 'policy-key');
  const policy = findPolicy(loaded.document, policyKey);
  const ruleCount = policy?.rules?.length ?? 0;

  // Removing a policy with rules discards work, so it needs an explicit
  // confirmation in a workflow that has no interactive prompt.
  if (ruleCount > 0 && !readBoolean(context.options, 'force')) {
    throw new CliError(`"${policyKey}" still has ${ruleCount} rule(s).`, {
      code: 'POLICY_NOT_EMPTY',
      exitCode: ExitCode.Conflict,
      details: ['', 'Remove it and its rules with:', `  govplane policies remove-policy --policy-key ${policyKey} --force`],
    });
  }

  const document = removePolicy(loaded.document, policyKey);

  return persist(draft, document, {
    action: 'remove-policy',
    details: { policyKey, removedRules: ruleCount },
    lines: [`Policy removed: ${policyKey}`],
  }, loaded.document);
};

const addRuleCommand = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);
  const policyKey = requireOption(context, 'policy-key');
  const rule = readRulePayload(readJsonInput(context, 'rule-file', 'rule-json', 'rule'));
  const document = addRule(loaded.document, policyKey, rule);

  return persist(draft, document, {
    action: 'add-rule',
    details: { policyKey, ruleId: rule.id },
    lines: [
      `Rule added to ${policyKey}: ${rule.id}`,
      '',
      `Priority: ${rule.priority}`,
      `Effect: ${rule.effect.type}`,
    ],
  }, loaded.document);
};

const updateRuleCommand = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: true });
  const loaded = loadDraft(draft.draftPath, draft.generatedAt);
  const policyKey = requireOption(context, 'policy-key');
  const ruleId = requireOption(context, 'rule-id');
  const rule = readRulePayload(readJsonInput(context, 'rule-file', 'rule-json', 'rule'));
  const document = updateRule(loaded.document, policyKey, ruleId, rule);

  return persist(draft, document, {
    action: 'update-rule',
    details: { policyKey, ruleId },
    lines: [
      `Rule updated in ${policyKey}: ${ruleId}`,
      '',
      `Priority: ${rule.priority}`,
      `Effect: ${rule.effect.type}`,
    ],
  }, loaded.document);
};

const printIssues = (reporter: Reporter, issues: ValidationIssue[], label: string): string[] => {
  if (issues.length === 0) {
    return [];
  }
  const lines = ['', `${issues.length} ${label}${issues.length === 1 ? '' : 's'} found:`];
  issues.forEach((issue, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${issue.path.replace(/^\$\./, '')}`);
    lines.push(`   ${issue.message}`);
    lines.push(`   ${reporter.muted(issue.code)}`);
  });
  return lines;
};

const validate = (context: CommandContext): ExitCodeValue => {
  const draft = prepare(context, { write: false });
  // Validated as written, not as normalised: the verdict has to match the one
  // `govplane validate --type draft` gives the same file.
  const document = readDraftFile(draft.draftPath);
  const { reporter } = context;
  const { issues, stats } = validateDraft(document);
  const strict = readBoolean(context.options, 'strict');
  const valid = issues.errors.length === 0 && !(strict && issues.warnings.length > 0);

  if (reporter.format === 'json') {
    reporter.json({
      success: valid,
      draftFile: draft.draftPath,
      errors: issues.errors,
      warnings: issues.warnings,
      stats,
    });
    return valid ? ExitCode.Success : ExitCode.Compatibility;
  }

  if (issues.errors.length === 0) {
    reporter.line(`${reporter.success('✓')} Draft file is valid.`);
    reporter.line();
    reporter.line(`Policies: ${stats.policies}`);
    reporter.line(`Rules:    ${stats.rules}`);
    reporter.lines(printIssues(reporter, issues.warnings, 'warning'));

    if (strict && issues.warnings.length > 0) {
      reporter.error('');
      reporter.error('Strict mode: warnings are treated as errors.');
      return ExitCode.Compatibility;
    }
    return ExitCode.Success;
  }

  reporter.error(
    `${reporter.failure('Draft validation failed:')} ${displayPath(draft.draftPath, context.cwd)}`,
  );
  reporter.errorLines(printIssues(reporter, issues.errors, 'error'));
  reporter.errorLines(printIssues(reporter, issues.warnings, 'warning'));
  return ExitCode.Compatibility;
};

const HANDLERS: Record<Subcommand, (context: CommandContext) => ExitCodeValue> = {
  'create-file': createFile,
  list,
  'add-policy': addPolicyCommand,
  'update-policy': updatePolicyCommand,
  'remove-policy': removePolicyCommand,
  'add-rule': addRuleCommand,
  'update-rule': updateRuleCommand,
  validate,
};

const run = (context: CommandContext): ExitCodeValue => {
  const status = requireActivation(context, COMMAND);
  const subcommand = context.positionals[0];

  if (subcommand === undefined) {
    throw new CliError('A subcommand is required.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        `Available subcommands: ${SUBCOMMANDS.join(', ')}`,
        '',
        'For example:',
        '  govplane policies list',
      ],
    });
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new CliError(`Unknown policies subcommand: ${subcommand}`, {
      code: 'UNKNOWN_SUBCOMMAND',
      exitCode: ExitCode.InvalidArguments,
      details: ['', `Available subcommands: ${SUBCOMMANDS.join(', ')}`],
    });
  }

  const code = HANDLERS[subcommand as Subcommand](context);

  // Structured consumers get the activation state alongside the result; the
  // text path already had it printed by the guard.
  if (context.reporter.format === 'json' && status.state !== 'activated') {
    context.reporter.debug(JSON.stringify({ activation: activationSummary(status) }));
  }

  return code;
};

export const policiesCommand: CommandDefinition = {
  name: 'policies',
  summary: 'Manage local policy drafts',
  usage: 'govplane policies <subcommand> [options]',
  description: 'Create and edit local Govplane policy drafts. Drafts are the authoring '
    + 'format that "govplane build" compiles into a runtime bundle.',
  requiresToolkit: true,
  subcommands: [
    { name: 'create-file', summary: 'Create a new draft file' },
    { name: 'list', summary: 'List the policies in a draft file' },
    { name: 'add-policy', summary: 'Add a policy' },
    { name: 'update-policy', summary: 'Update an existing policy' },
    { name: 'remove-policy', summary: 'Remove a policy' },
    { name: 'add-rule', summary: 'Add a rule to a policy' },
    { name: 'update-rule', summary: 'Replace a rule in a policy' },
    { name: 'validate', summary: 'Validate the draft file' },
  ],
  options: [
    {
      name: 'draft', type: 'string', placeholder: '<path>', description: 'Draft file to use',
    },
    {
      name: 'policy-key', type: 'string', placeholder: '<key>', description: 'Policy to act on',
    },
    {
      name: 'defaults-effect',
      type: 'string',
      placeholder: '<effect>',
      choices: ['allow', 'deny', 'kill_switch', 'throttle', 'custom'],
      description: 'Default effect for the policy',
    },
    {
      name: 'active-version',
      type: 'string',
      placeholder: '<number>',
      description: 'Active version of the policy (default 1)',
    },
    {
      name: 'friendly-name',
      type: 'string',
      placeholder: '<name>',
      description: 'Human-readable policy name',
    },
    {
      name: 'description',
      type: 'string',
      placeholder: '<text>',
      description: 'Policy description',
    },
    {
      name: 'kill-switch-service',
      type: 'string',
      placeholder: '<service>',
      description: 'Service a kill_switch default applies to',
    },
    {
      name: 'kill-switch-reason',
      type: 'string',
      placeholder: '<text>',
      description: 'Reason recorded with a kill_switch default',
    },
    {
      name: 'throttle-limit',
      type: 'string',
      placeholder: '<number>',
      description: 'Throttle limit',
    },
    {
      name: 'throttle-window-seconds',
      type: 'string',
      placeholder: '<number>',
      description: 'Throttle window, in seconds',
    },
    {
      name: 'throttle-key',
      type: 'string',
      placeholder: '<key>',
      description: 'Context key a throttle counts against',
    },
    {
      name: 'custom-effect',
      type: 'string',
      placeholder: '<value>',
      description: 'Value for a custom default effect',
    },
    {
      name: 'policy-file',
      type: 'string',
      placeholder: '<path>',
      description: 'Policy payload as a JSON file',
    },
    {
      name: 'policy-json',
      type: 'string',
      placeholder: '<json>',
      description: 'Policy payload as inline JSON',
    },
    {
      name: 'rule-id', type: 'string', placeholder: '<id>', description: 'Rule to act on',
    },
    {
      name: 'rule-file',
      type: 'string',
      placeholder: '<path>',
      description: 'Rule payload as a JSON file',
    },
    {
      name: 'rule-json',
      type: 'string',
      placeholder: '<json>',
      description: 'Rule payload as inline JSON',
    },
    {
      name: 'env',
      type: 'string',
      placeholder: '<env>',
      choices: ['prod', 'staging', 'dev', 'test'],
      description: 'Environment recorded in a new draft file',
    },
    { name: 'versioned', type: 'boolean', description: 'Write to the next versioned draft file' },
    {
      name: 'force',
      type: 'boolean',
      description: 'Replace a file, or remove a policy that has rules',
    },
    { name: 'strict', type: 'boolean', description: 'Treat validation warnings as errors' },
    formatOption,
    ...commonOptions,
  ],
  examples: [
    'govplane policies create-file',
    'govplane policies add-policy --policy-key login-protection --defaults-effect allow',
    'govplane policies add-rule --policy-key login-protection --rule-file ./deny-retries.json',
    'govplane policies list --verbose',
    'govplane policies validate --strict',
  ],
  run,
};

export const policiesSubcommands = SUBCOMMANDS;
export { nextVersionedPath };
