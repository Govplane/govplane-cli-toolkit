import { existsSync } from 'node:fs';
import { parseJson, readTextFile } from '@govplane/cli';

/** The `simulate` block of `govplane.config.json`. */
export interface SimulateConfig {
  directory?: string;
  defaultTrace?: string;
  verifySignatures?: boolean;
  reportsDirectory?: string;
  redactContextFields?: string[];
  validateContext?: boolean;
  parseCustomEffect?: boolean;
  contextPolicy?: { allowedKeys: string[] } | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value : undefined
);

export const readSimulateConfig = (configPath: string | null): SimulateConfig => {
  if (configPath === null || !existsSync(configPath)) {
    return {};
  }

  const parsed = parseJson(readTextFile(configPath));
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.simulate)) {
    return {};
  }

  const block = parsed.value.simulate;

  return {
    ...(readString(block.directory) === undefined
      ? {}
      : { directory: readString(block.directory) }),
    ...(readString(block.defaultTrace) === undefined
      ? {}
      : { defaultTrace: readString(block.defaultTrace) }),
    ...(typeof block.verifySignatures === 'boolean'
      ? { verifySignatures: block.verifySignatures }
      : {}),
    ...(readString(block.reportsDirectory) === undefined
      ? {}
      : { reportsDirectory: readString(block.reportsDirectory) }),
    ...(Array.isArray(block.redactContextFields)
      ? {
        redactContextFields: block.redactContextFields
          .filter((field): field is string => typeof field === 'string'),
      }
      : {}),
    ...(typeof block.validateContext === 'boolean'
      ? { validateContext: block.validateContext }
      : {}),
    ...(typeof block.parseCustomEffect === 'boolean'
      ? { parseCustomEffect: block.parseCustomEffect }
      : {}),
    ...(isRecord(block.contextPolicy) && Array.isArray(block.contextPolicy.allowedKeys)
      ? { contextPolicy: block.contextPolicy as { allowedKeys: string[] } }
      : {}),
  };
};
