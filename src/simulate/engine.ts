import { createPolicyEngine } from '@govplane/runtime-sdk';
import { CliError, ExitCode, type RuntimeBundle } from '@govplane/cli';
import type { Target } from './scenarios.js';

/**
 * The evaluation engine.
 *
 * Simulation runs the **published Govplane runtime engine** — the same
 * `@govplane/runtime-sdk` an application evaluates policies with. Nothing in
 * this file decides anything: effect precedence, priority ordering,
 * tie-breaking and the deny-by-default fallback all belong to the engine.
 *
 * That is the whole point of the command. A simulator with its own decision
 * logic would eventually disagree with production, and would be worse than no
 * simulator at all — it would be a confident one that lies.
 */

export type TraceLevel = 'off' | 'errors' | 'sampled' | 'full';

export const TRACE_LEVELS: TraceLevel[] = ['off', 'errors', 'sampled', 'full'];

export interface ContextPolicy {
  allowedKeys: string[];
  maxStringLen?: number;
  maxArrayLen?: number;
  blockLikelyPiiKeys?: boolean;
}

export interface EngineOptions {
  /** Reject context values the runtime's context policy would reject. */
  validateContext?: boolean;
  /** The context policy to enforce, when validation is on. */
  contextPolicy?: ContextPolicy | undefined;
  /** JSON-parse custom effect values into `parsedValue`. */
  parseCustomEffect?: boolean;
}

export interface Evaluation {
  decision: Record<string, unknown>;
  trace?: Record<string, unknown> | undefined;
}

export interface Simulator {
  evaluate(target: Target, context: Record<string, unknown>, trace: TraceLevel): Evaluation;
}

/**
 * Builds a simulator over a compiled bundle.
 *
 * The bundle is handed to the engine exactly as it will reach the SDK, so a
 * decision here is the decision an application would get.
 */
export const createSimulator = (
  bundle: RuntimeBundle,
  options: EngineOptions = {},
): Simulator => {
  const engine = createPolicyEngine({
    getBundle: () => bundle as never,
    // Off unless a policy is pinned. The runtime's default context policy is a
    // short sample allow-list meant to be replaced per application; enforcing it
    // here would reject the very keys a bundle's own rules read, and simulation
    // would fail on correct input. When a policy *is* configured, it is passed
    // through so simulation reproduces the application's real constraints.
    validateContext: options.validateContext ?? false,
    ...(options.contextPolicy === undefined
      ? {}
      : { contextPolicy: options.contextPolicy }),
    ...(options.parseCustomEffect === undefined
      ? {}
      : { parseCustomEffect: options.parseCustomEffect }),
  });

  return {
    evaluate(target, context, trace) {
      try {
        if (trace === 'off') {
          return { decision: engine.evaluate({ target, context }) };
        }

        // `force` makes a sampled trace deterministic: a simulation the user
        // explicitly asked to trace must always produce one, where production
        // sampling is probabilistic.
        const result = engine.evaluateWithTrace(
          { target, context },
          { level: trace, force: true },
        ) as Record<string, unknown>;

        const { trace: produced, ...decision } = result;
        return {
          decision,
          ...(produced === undefined
            ? {}
            : { trace: produced as Record<string, unknown> }),
        };
      } catch (error) {
        throw new CliError(
          `The runtime engine could not evaluate this target: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            code: 'RUNTIME_EVALUATION_ERROR',
            exitCode: ExitCode.RuntimeEvaluationError,
            details: [
              '',
              `Target: ${target.service} / ${target.resource} / ${target.action}`,
            ],
            cause: error,
          },
        );
      }
    },
  };
};

/** True when no rule matched and the decision came from a policy default. */
export const isFallback = (decision: Record<string, unknown>): boolean => (
  decision.reason === 'default'
);
