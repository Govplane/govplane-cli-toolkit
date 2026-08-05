import { atomicWriteFile, CliError, ExitCode, stringifyJson } from '@govplane/cli';
import { redactContext } from './context.js';
import type { Scenario } from './scenarios.js';

/**
 * Simulation reports.
 *
 * A report is a record of what was evaluated and what came out, suitable for
 * attaching to a pull request or keeping with a release. Context is redacted
 * with the same rules as console output: a report is a file that gets shared.
 */

export interface ReportScenario {
  name: string;
  target: { service: string; resource: string; action: string };
  context: Record<string, unknown>;
  result: Record<string, unknown>;
  expectation: { defined: boolean; passed: boolean };
}

export interface SimulationReport {
  cliVersion: string;
  runtimeEngine: string;
  executedAt: string;
  durationMs: number;
  input: {
    documentType: 'bundle' | 'draft';
    documentPath: string;
    bundleVersion?: number;
    checksum?: string;
  };
  signature: { status: string; algorithm?: string; keyId?: string };
  summary: {
    total: number; asserted: number; passed: number; failed: number;
  };
  scenarios: ReportScenario[];
}

export interface BuildReportInput {
  cliVersion: string;
  runtimeEngine: string;
  executedAt: string;
  durationMs: number;
  documentType: 'bundle' | 'draft';
  documentPath: string;
  bundleVersion?: number | undefined;
  checksum?: string | undefined;
  signature: { status: string; algorithm?: string | undefined; keyId?: string | undefined };
  redactFields: string[];
  outcomes: {
    scenario: Scenario;
    decision: Record<string, unknown>;
    passed: boolean;
  }[];
}

export const buildSimulationReport = (input: BuildReportInput): SimulationReport => {
  const asserted = input.outcomes.filter((entry) => entry.scenario.expected !== undefined);
  const failed = input.outcomes.filter((entry) => !entry.passed);

  return {
    cliVersion: input.cliVersion,
    runtimeEngine: input.runtimeEngine,
    executedAt: input.executedAt,
    durationMs: input.durationMs,
    input: {
      documentType: input.documentType,
      documentPath: input.documentPath,
      ...(input.bundleVersion === undefined ? {} : { bundleVersion: input.bundleVersion }),
      ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
    },
    signature: {
      status: input.signature.status,
      ...(input.signature.algorithm === undefined
        ? {}
        : { algorithm: input.signature.algorithm }),
      ...(input.signature.keyId === undefined ? {} : { keyId: input.signature.keyId }),
    },
    summary: {
      total: input.outcomes.length,
      asserted: asserted.length,
      passed: input.outcomes.length - failed.length,
      failed: failed.length,
    },
    scenarios: input.outcomes.map((entry) => ({
      name: entry.scenario.name,
      target: entry.scenario.target,
      context: redactContext(entry.scenario.context, input.redactFields),
      result: entry.decision,
      expectation: {
        defined: entry.scenario.expected !== undefined,
        passed: entry.passed,
      },
    })),
  };
};

export const writeSimulationReport = (path: string, report: SimulationReport): void => {
  try {
    atomicWriteFile(path, stringifyJson(report));
  } catch (error) {
    throw new CliError(`The simulation report could not be written: ${path}`, {
      code: 'REPORT_WRITE_FAILED',
      exitCode: ExitCode.WriteError,
      cause: error,
    });
  }
};
