import type { RuntimePolicy, RuntimeRule } from '@govplane/cli';

/**
 * Draft document model.
 *
 * A draft is the authoring format: what a developer edits before `build`
 * compiles it into a runtime bundle. Drafts are persisted in **build-ready**
 * shape, which is a runtime policy set without the bundle's scope and integrity
 * metadata.
 *
 * See `specs/cli-toolkit/cli_toolkit_policies_spec.md`.
 */

export const DRAFT_SCHEMA_VERSION = '1.0';

export interface DraftDocument {
  schemaVersion: number | string;
  generatedAt?: string;
  env?: string;
  policies: RuntimePolicy[];
}

export type DraftPolicy = RuntimePolicy;
export type DraftRule = RuntimeRule;

/** How a draft document arrived, before normalisation. */
export type DraftShape = 'build-ready' | 'analyze' | 'empty';

export interface LoadedDraft {
  document: DraftDocument;
  path: string;
  /** The shape as found on disk. `analyze` documents are normalised on load. */
  shape: DraftShape;
}

export interface DraftStats {
  policies: number;
  rules: number;
}

export const draftStats = (document: DraftDocument): DraftStats => ({
  policies: document.policies.length,
  rules: document.policies.reduce(
    (total, policy) => total + (Array.isArray(policy.rules) ? policy.rules.length : 0),
    0,
  ),
});
