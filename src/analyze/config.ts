import { existsSync } from 'node:fs';
import { parseJson, readTextFile } from '@govplane/cli';

/** The `analyze` block of `govplane.config.json`. */
export interface AnalyzeConfig {
  source?: string;
  exclude?: string[];
  bundles?: string[];
  outputDraft?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value : undefined
);

const readStringList = (value: unknown): string[] | undefined => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : undefined
);

export const readAnalyzeConfig = (configPath: string | null): AnalyzeConfig => {
  if (configPath === null || !existsSync(configPath)) {
    return {};
  }

  const parsed = parseJson(readTextFile(configPath));
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.analyze)) {
    return {};
  }

  const block = parsed.value.analyze;

  return {
    ...(readString(block.source) === undefined ? {} : { source: readString(block.source) }),
    ...(readStringList(block.exclude) === undefined
      ? {}
      : { exclude: readStringList(block.exclude) }),
    ...(readStringList(block.bundles) === undefined
      ? {}
      : { bundles: readStringList(block.bundles) }),
    ...(readString(block.outputDraft) === undefined
      ? {}
      : { outputDraft: readString(block.outputDraft) }),
  };
};
