import { tokenize, type Token } from './lexer.js';
import {
  matchGroup, parseExpression, property, staticString,
  type PropertyNode, type ValueNode,
} from './expression.js';

/**
 * Finding Govplane evaluation calls in a source file.
 *
 * The spec asks the analyzer to recognise "aliases, imported client instances
 * and local variables rather than relying only on identifier names". Two
 * independent signals are used, and either is enough:
 *
 * 1. **Binding** — the receiver traces back to something imported from a
 *    Govplane module, directly or through a factory call.
 * 2. **Shape** — the call is `<anything>.evaluate({ target: { … } })` with a
 *    recognisable target. Nothing else in a typical codebase looks like that,
 *    and it catches the client that arrived through dependency injection, a
 *    framework context, or a local re-export this file cannot see.
 *
 * Shape is the stronger signal in practice: it does not care what the variable
 * was called or how it got there.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface DynamicExpression {
  dynamic: true;
  source: string;
  fallback?: string;
}

export interface ContextField {
  key: string;
  source?: string;
  type?: string;
}

export type TargetComponent = 'service' | 'resource' | 'action';

export interface CallSite {
  target: Record<TargetComponent, string>;
  /** Preserved originals for components that were not literals. */
  expressions: Partial<Record<TargetComponent, DynamicExpression>>;
  availableContext: ContextField[];
  confidence: Confidence;
  location: SourceLocation;
  /** How this call was recognised, for `--verbose`. */
  matchedBy: 'binding' | 'shape';
}

export interface DetectionResult {
  calls: CallSite[];
  /**
   * Calls that were recognised as Govplane evaluations but whose target could
   * not be read at all — a variable, a helper call, a spread. Reported rather
   * than dropped, so a developer is never told "nothing found" when something
   * was found and not understood.
   */
  unresolved: SourceLocation[];
  /** True when the file could not be tokenized cleanly. */
  recovered: boolean;
}

const GOVPLANE_MODULE = /govplane/iu;

/** Factory names that produce a client, used when the import is indirect. */
const CLIENT_FACTORIES = new Set([
  'createPolicyEngine', 'createClient', 'createGovplaneClient', 'createEngine',
  'GovplaneClient', 'PolicyEngine', 'Govplane',
]);

const isPunctuator = (token: Token | undefined, ...values: string[]): boolean => (
  token !== undefined && token.type === 'punctuator' && values.includes(token.value)
);

const isIdentifier = (token: Token | undefined, value?: string): boolean => (
  token !== undefined && token.type === 'identifier'
  && (value === undefined || token.value === value)
);

/** Walks backwards past a balanced group whose closer sits at `close`. */
const groupStart = (tokens: Token[], close: number): number => {
  const openers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const closer = tokens[close]?.value ?? '';
  const opener = openers[closer];
  if (opener === undefined) {
    return close;
  }

  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const token = tokens[index] as Token;
    if (token.type !== 'punctuator') {
      continue;
    }
    if (token.value === closer) {
      depth += 1;
    } else if (token.value === opener) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return 0;
};

/**
 * Reads the member chain that a call is made on.
 *
 * `this.deps.govplane.evaluate(` yields `['this', 'deps', 'govplane']`.
 */
const receiverChain = (tokens: Token[], dotIndex: number): string[] => {
  const segments: string[] = [];
  let index = dotIndex - 1;

  while (index >= 0) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }

    if (token.type === 'identifier') {
      segments.unshift(token.value);
      index -= 1;
    } else if (isPunctuator(token, ')', ']')) {
      // A call or index in the chain: `getClient().evaluate(`.
      index = groupStart(tokens, index) - 1;
      continue;
    } else {
      break;
    }

    if (isPunctuator(tokens[index], '.', '?.')) {
      index -= 1;
      continue;
    }
    break;
  }

  return segments;
};

/**
 * Collects the identifiers in this file that refer to Govplane.
 *
 * Covers ESM imports, `require`, and variables assigned from either — including
 * through a factory call, which is how the SDK is normally instantiated.
 */
export const govplaneBindings = (tokens: Token[]): Set<string> => {
  const bindings = new Set<string>();

  const isGovplaneModule = (token: Token | undefined): boolean => (
    token !== undefined && token.type === 'string' && GOVPLANE_MODULE.test(token.value)
  );

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;

    // import … from '@govplane/…'
    if (isIdentifier(token, 'import')) {
      const from = tokens.findIndex(
        (candidate, at) => at > index && isIdentifier(candidate, 'from'),
      );
      const specifier = from === -1 ? undefined : tokens[from + 1];
      if (from === -1 || !isGovplaneModule(specifier)) {
        continue;
      }
      // Every identifier between `import` and `from` that is a binding name.
      for (let at = index + 1; at < from; at += 1) {
        const candidate = tokens[at] as Token;
        if (candidate.type !== 'identifier' || candidate.value === 'as'
          || candidate.value === 'type') {
          continue;
        }
        // In `{ a as b }` only `b` binds; `as` is followed by the local name.
        const next = tokens[at + 1];
        if (isIdentifier(next, 'as')) {
          continue;
        }
        bindings.add(candidate.value);
      }
      continue;
    }

    // const … = require('@govplane/…')
    if (isIdentifier(token, 'require') && isPunctuator(tokens[index + 1], '(')
      && isGovplaneModule(tokens[index + 2])) {
      // Walk back to the declarator name(s).
      for (let at = index - 1; at >= 0 && at > index - 12; at -= 1) {
        const candidate = tokens[at] as Token;
        if (candidate.type === 'identifier'
          && !['const', 'let', 'var', 'await'].includes(candidate.value)) {
          bindings.add(candidate.value);
        }
        if (candidate.type === 'punctuator' && candidate.value === ';') {
          break;
        }
      }
    }
  }

  // A second pass: variables assigned from a known binding or a client factory.
  // Runs after imports so it can see them, and repeats so a two-step chain
  // (`const sdk = require(…)`, `const gp = sdk.createClient()`) resolves.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (!isPunctuator(tokens[index], '=') ) {
        continue;
      }
      const name = tokens[index - 1];
      if (name === undefined || name.type !== 'identifier') {
        continue;
      }

      // The root identifier of the assigned expression.
      let at = index + 1;
      if (isIdentifier(tokens[at], 'await') || isIdentifier(tokens[at], 'new')) {
        at += 1;
      }
      const root = tokens[at];
      if (root === undefined || root.type !== 'identifier') {
        continue;
      }

      const chain = [root.value];
      let cursor = at + 1;
      while (isPunctuator(tokens[cursor], '.', '?.') && isIdentifier(tokens[cursor + 1])) {
        chain.push((tokens[cursor + 1] as Token).value);
        cursor += 2;
      }

      const fromBinding = bindings.has(root.value);
      const fromFactory = chain.some((segment) => CLIENT_FACTORIES.has(segment));
      if (fromBinding || fromFactory) {
        bindings.add(name.value);
      }
    }
  }

  return bindings;
};

/**
 * A type this analyzer can state as fact rather than guess.
 *
 * Only language-level certainties are reported: a template literal always
 * produces a string, `Number(x)` always produces a number. `req.method` is
 * left untyped — inferring `string` there would be inventing knowledge the
 * source does not carry, which the spec forbids.
 */
const inferType = (node: ValueNode): string | undefined => {
  if (node.kind === 'string' || node.kind === 'number' || node.kind === 'boolean') {
    return node.kind;
  }
  if (node.kind === 'array') return 'array';
  if (node.kind === 'object') return 'object';
  if (node.kind === 'null' || node.kind === 'undefined') return undefined;

  const {raw} = node;
  if (raw.startsWith('`')) return 'string';
  if (/^String\s*\(/u.test(raw)) return 'string';
  if (/^(Number|parseInt|parseFloat)\s*\(/u.test(raw)) return 'number';
  if (/^Boolean\s*\(/u.test(raw)) return 'boolean';
  if (/^!/u.test(raw)) return 'boolean';
  if (/\.length$/u.test(raw)) return 'number';
  return undefined;
};

const readContext = (node: ValueNode | undefined): ContextField[] => {
  if (node === undefined || node.kind !== 'object') {
    return [];
  }

  return node.properties
    .filter((entry): entry is PropertyNode & { key: string } => (
      entry.key !== null && !entry.spread
    ))
    .map((entry) => {
      const type = inferType(entry.value);
      const source = entry.shorthand ? entry.key : entry.value.raw;
      return {
        key: entry.key,
        ...(source === entry.key && entry.shorthand ? { source } : { source }),
        ...(type === undefined ? {} : { type }),
      };
    });
};

interface ReadComponent {
  value: string;
  expression?: DynamicExpression;
  resolved: 'literal' | 'fallback' | 'unknown';
}

const readComponent = (node: ValueNode | undefined): ReadComponent => {
  if (node === undefined) {
    return { value: '*', resolved: 'unknown' };
  }

  const literal = staticString(node);
  if (literal !== undefined) {
    return { value: literal, resolved: 'literal' };
  }

  if (node.kind === 'dynamic') {
    const fallback = staticString(node.fallback);
    if (fallback !== undefined) {
      return {
        value: fallback,
        expression: { dynamic: true, source: node.raw, fallback },
        resolved: 'fallback',
      };
    }
    return {
      value: '*',
      expression: { dynamic: true, source: node.raw },
      resolved: 'unknown',
    };
  }

  return { value: '*', expression: { dynamic: true, source: node.raw }, resolved: 'unknown' };
};

const COMPONENTS: TargetComponent[] = ['service', 'resource', 'action'];

/** True when a node looks like a Govplane target, whatever the receiver is called. */
const looksLikeTarget = (node: ValueNode | undefined): boolean => {
  if (node === undefined || node.kind !== 'object') {
    return false;
  }
  const named = node.properties.filter(
    (entry) => entry.key !== null && COMPONENTS.includes(entry.key as TargetComponent),
  );
  return named.length >= 2;
};

/**
 * Finds every Govplane evaluation call in one source file.
 *
 * `file` is used only for reporting; it is never read here.
 */
export const detectCalls = (source: string, file: string): DetectionResult => {
  const { tokens, recovered } = tokenize(source);
  const bindings = govplaneBindings(tokens);
  const calls: CallSite[] = [];
  const unresolved: SourceLocation[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (!isIdentifier(token, 'evaluate') || !isPunctuator(tokens[index + 1], '(')) {
      continue;
    }

    const dotIndex = index - 1;
    const chained = isPunctuator(tokens[dotIndex], '.', '?.');
    const chain = chained ? receiverChain(tokens, dotIndex) : [];

    // A bare `evaluate(` only counts when `evaluate` itself was imported.
    const boundReceiver = chained
      ? chain.some((segment) => bindings.has(segment))
      : bindings.has('evaluate');

    const argumentsEnd = matchGroup(tokens, index + 1);
    const firstArgument = parseExpression(
      source,
      tokens,
      index + 2,
      new Set([',', ')']),
    ).node;

    const targetNode = property(firstArgument, 'target');
    const shaped = looksLikeTarget(targetNode);

    if (!boundReceiver && !shaped) {
      continue;
    }

    const location: SourceLocation = {
      file,
      line: token.line,
      // The column of the receiver, which is where a reader looks for the call.
      column: (chained ? tokens[dotIndex - chain.length] ?? token : token).column,
    };

    if (targetNode === undefined) {
      unresolved.push(location);
      index = argumentsEnd - 1;
      continue;
    }

    const read = COMPONENTS.map((component) => (
      [component, readComponent(property(targetNode, component))] as const
    ));

    const target = {} as Record<TargetComponent, string>;
    const expressions: Partial<Record<TargetComponent, DynamicExpression>> = {};
    read.forEach(([component, result]) => {
      target[component] = result.value;
      if (result.expression !== undefined) {
        expressions[component] = result.expression;
      }
    });

    // Confidence follows the spec: literals everywhere is high; dynamic values
    // that all carry a clear fallback is medium; anything unresolvable is low.
    const states = read.map(([, result]) => result.resolved);
    let confidence: Confidence = 'low';
    if (states.every((state) => state === 'literal')) {
      confidence = 'high';
    } else if (states.every((state) => state !== 'unknown')) {
      confidence = 'medium';
    }

    calls.push({
      target,
      expressions,
      availableContext: readContext(property(firstArgument, 'context')),
      confidence,
      location,
      matchedBy: boundReceiver ? 'binding' : 'shape',
    });

    index = argumentsEnd - 1;
  }

  return { calls, unresolved, recovered };
};
