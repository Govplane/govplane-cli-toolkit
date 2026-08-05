import type {
  CallSite, Confidence, ContextField, DynamicExpression, SourceLocation, TargetComponent,
} from './detect.js';

/**
 * Draft consolidation.
 *
 * Several evaluation calls often describe one logical policy: the same target
 * checked in a middleware, a controller and a test helper. The spec fixes the
 * canonical identity as `service + resource + action`, and requires merged
 * drafts to aggregate every discovered context key and every source location.
 */

export interface Discovery {
  id: string;
  target: Record<TargetComponent, string>;
  expressions: Partial<Record<TargetComponent, DynamicExpression>>;
  availableContext: ContextField[];
  confidence: Confidence;
  sources: SourceLocation[];
}

/**
 * The canonical identity of a target: `service + resource + action`.
 *
 * The separator is a unit character rather than a space or a slash, because a
 * resource is frequently a URL path and a service name can contain anything the
 * application chose. Every comparison of two targets goes through this function
 * so there is only one encoding to agree on.
 */
const IDENTITY_SEPARATOR = String.fromCharCode(31);

export const targetIdentity = (target: Record<TargetComponent, string>): string => (
  [target.service, target.resource, target.action].join(IDENTITY_SEPARATOR)
);

/** Acronyms that read wrong in title case. Presentation only. */
const ACRONYMS = new Set([
  'api', 'id', 'url', 'uri', 'http', 'https', 'sql', 'ui', 'io', 'jwt', 'sso',
  'acl', 'cdn', 'dns', 'ip', 'db', 'gql', 'rpc', 'crm', 'pdf', 'csv', 'sms',
]);

const slug = (value: string): string => value
  .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
  .toLowerCase()
  .replace(/[^a-z0-9]+/gu, '-')
  .replace(/^-+|-+$/gu, '');

/**
 * Derives a stable identifier from a target.
 *
 * Wildcard components carry no information and are left out, so
 * `api-gateway / * / request` becomes `api-gateway-request`.
 */
export const discoveryId = (target: Record<TargetComponent, string>): string => {
  const parts = [target.service, target.resource, target.action]
    .filter((part) => part !== '*' && part !== '')
    .map(slug)
    .filter((part) => part !== '');

  // A component repeated across the target adds nothing to the name.
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.join('-') || 'discovered-policy';
};

export const friendlyName = (id: string): string => id
  .split('-')
  .filter((word) => word !== '')
  .map((word) => (ACRONYMS.has(word)
    ? word.toUpperCase()
    : word.charAt(0).toUpperCase() + word.slice(1)))
  .join(' ');

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

const compareLocations = (left: SourceLocation, right: SourceLocation): number => (
  left.file.localeCompare(right.file)
  || left.line - right.line
  || left.column - right.column
);

/**
 * Merges context fields discovered at different call sites.
 *
 * A key seen twice keeps the richer description: an entry that resolved a type
 * beats one that did not, because the second call site simply told us less
 * about the same field.
 */
const mergeContext = (existing: ContextField[], incoming: ContextField[]): ContextField[] => {
  const byKey = new Map<string, ContextField>();

  [...existing, ...incoming].forEach((field) => {
    const current = byKey.get(field.key);
    if (current === undefined) {
      byKey.set(field.key, field);
      return;
    }
    byKey.set(field.key, {
      key: field.key,
      ...(current.source ?? field.source ? { source: current.source ?? field.source } : {}),
      ...(current.type ?? field.type ? { type: current.type ?? field.type } : {}),
    });
  });

  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
};

/**
 * Consolidates call sites into discoveries.
 *
 * Output order is by identifier, and every aggregated list is sorted, so the
 * same source tree always produces the same document.
 */
export const consolidate = (calls: CallSite[]): Discovery[] => {
  const byIdentity = new Map<string, Discovery>();

  calls.forEach((call) => {
    const identity = targetIdentity(call.target);
    const existing = byIdentity.get(identity);

    if (existing === undefined) {
      byIdentity.set(identity, {
        id: discoveryId(call.target),
        target: call.target,
        expressions: { ...call.expressions },
        availableContext: mergeContext([], call.availableContext),
        confidence: call.confidence,
        sources: [call.location],
      });
      return;
    }

    existing.availableContext = mergeContext(existing.availableContext, call.availableContext);
    existing.sources.push(call.location);

    // The most resolved reading of a target wins: if one call site spelled it
    // out in literals, that is what the target is.
    if (CONFIDENCE_RANK[call.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = call.confidence;
    }

    // Keep the first expression seen for each component; sources are sorted
    // afterwards, so "first" is deterministic across runs.
    (Object.keys(call.expressions) as TargetComponent[]).forEach((component) => {
      if (existing.expressions[component] === undefined) {
        existing.expressions[component] = call.expressions[component];
      }
    });
  });

  const discoveries = [...byIdentity.values()];
  discoveries.forEach((discovery) => {
    discovery.sources.sort(compareLocations);
  });

  // Two different targets can slug to the same identifier — `/users/:id` and
  // `/users/{id}` for instance. Suffix deterministically rather than emitting
  // a document with duplicate ids.
  const used = new Map<string, number>();
  discoveries
    .sort((left, right) => (
      left.id.localeCompare(right.id)
      || targetIdentity(left.target).localeCompare(targetIdentity(right.target))
    ))
    .forEach((discovery) => {
      const seen = used.get(discovery.id) ?? 0;
      used.set(discovery.id, seen + 1);
      if (seen > 0) {
        discovery.id = `${discovery.id}-${seen + 1}`;
      }
    });

  return discoveries;
};
