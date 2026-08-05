import type { Reporter } from '@govplane/cli';
import type { ComparedDiscovery } from './compare.js';
import { friendlyName } from './consolidate.js';
import type { Prompter } from './prompt.js';

/**
 * Interactive review.
 *
 * The spec asks for a step-through that lets the developer accept a draft,
 * ignore it, rename the policy, merge it into another, or review the detected
 * context. Nothing here changes what was *discovered* — it changes which
 * discoveries are written and what they are called. The analyzer's findings
 * stay the analyzer's findings.
 */

export interface ReviewOutcome {
  accepted: ComparedDiscovery[];
  ignored: ComparedDiscovery[];
  /** Renames applied, for the summary. */
  renamed: { from: string; to: string }[];
  merged: { from: string; into: string }[];
}

const CHOICES = ['accept', 'ignore', 'rename', 'merge', 'context', 'quit'];

const describe = (reporter: Reporter, discovery: ComparedDiscovery, position: string): void => {
  reporter.line();
  reporter.line(reporter.heading(`${position}  ${discovery.id}`));
  reporter.line(`  Target:     ${discovery.target.service} / ${discovery.target.resource}`
    + ` / ${discovery.target.action}`);
  reporter.line(`  Status:     ${discovery.status}`);
  reporter.line(`  Confidence: ${discovery.confidence}`);

  if (discovery.matchedPolicies.length > 0) {
    reporter.line(`  Existing:   ${discovery.matchedPolicies.join(', ')}`);
  }

  const [first, ...rest] = discovery.sources;
  if (first !== undefined) {
    reporter.line(`  Found in:   ${first.file}:${first.line}`);
    rest.slice(0, 2).forEach((location) => {
      reporter.line(`              ${location.file}:${location.line}`);
    });
    if (rest.length > 2) {
      reporter.line(reporter.muted(`              and ${rest.length - 2} more`));
    }
  }
};

const showContext = (reporter: Reporter, discovery: ComparedDiscovery): void => {
  reporter.line();
  if (discovery.availableContext.length === 0) {
    reporter.line('  No context fields were passed at these call sites.');
    return;
  }

  reporter.line('  Context available to this policy:');
  discovery.availableContext.forEach((field) => {
    const type = field.type === undefined ? '' : ` [${field.type}]`;
    const source = field.source === undefined || field.source === field.key
      ? ''
      : `  ${reporter.muted(`← ${field.source}`)}`;
    reporter.line(`    ${field.key}${type}${source}`);
  });
};

/**
 * Steps through discoveries with the developer.
 *
 * Quitting keeps everything reviewed so far and accepts the remainder
 * unchanged: a review interrupted half way should not silently discard the
 * findings the developer has not looked at yet.
 */
export const reviewDiscoveries = async (
  discoveries: ComparedDiscovery[],
  prompter: Prompter,
  reporter: Reporter,
): Promise<ReviewOutcome> => {
  const accepted: ComparedDiscovery[] = [];
  const ignored: ComparedDiscovery[] = [];
  const renamed: { from: string; to: string }[] = [];
  const merged: { from: string; into: string }[] = [];

  reporter.line();
  reporter.line(`Reviewing ${discoveries.length} discover${discoveries.length === 1 ? 'y' : 'ies'}.`);
  reporter.line(reporter.muted('accept, ignore, rename, merge, context, quit — Enter accepts.'));

  for (let index = 0; index < discoveries.length; index += 1) {
    const discovery = discoveries[index] as ComparedDiscovery;
    const position = `[${index + 1}/${discoveries.length}]`;
    let settled = false;

    while (!settled) {
      describe(reporter, discovery, position);
      // Sequential by nature: each answer decides what to show next.
       
      const answer = await prompter.ask('  What should happen to this draft?', CHOICES, 'accept');

      switch (answer) {
        case 'ignore':
          ignored.push(discovery);
          settled = true;
          break;

        case 'context':
          showContext(reporter, discovery);
          break;

        case 'rename': {
           
          const name = await prompter.askLine('  New policy key:');
          if (name !== '') {
            renamed.push({ from: discovery.id, to: name });
            discovery.id = name;
          }
          break;
        }

        case 'merge': {
          const targets = accepted.filter((entry) => entry.id !== discovery.id);
          if (targets.length === 0) {
            reporter.line(reporter.muted('  Nothing accepted yet to merge into.'));
            break;
          }
          reporter.line();
          reporter.line('  Merge into:');
          targets.forEach((entry) => reporter.line(`    ${entry.id}`));
           
          const into = await prompter.askLine('  Policy key to merge into:');
          const destination = targets.find((entry) => entry.id === into);
          if (destination === undefined) {
            reporter.line(reporter.muted('  No such draft; leaving this one as it is.'));
            break;
          }
          // Merging keeps every source location and context key from both, the
          // same aggregation consolidation performs automatically.
          destination.sources = [...destination.sources, ...discovery.sources]
            .sort((left, right) => (
              left.file.localeCompare(right.file) || left.line - right.line
            ));
          const keys = new Set(destination.availableContext.map((field) => field.key));
          discovery.availableContext.forEach((field) => {
            if (!keys.has(field.key)) {
              destination.availableContext.push(field);
            }
          });
          destination.availableContext.sort((left, right) => left.key.localeCompare(right.key));
          merged.push({ from: discovery.id, into: destination.id });
          settled = true;
          break;
        }

        case 'quit':
          accepted.push(...discoveries.slice(index));
          return {
            accepted, ignored, renamed, merged,
          };

        default:
          accepted.push(discovery);
          settled = true;
      }
    }
  }

  return {
    accepted, ignored, renamed, merged,
  };
};

/** The name a reviewed discovery should be presented under. */
export const displayName = (discovery: ComparedDiscovery): string => friendlyName(discovery.id);
