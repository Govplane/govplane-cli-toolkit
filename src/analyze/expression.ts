import type { Token } from './lexer.js';

/**
 * A value tree over a token span.
 *
 * The analyzer reads object literals passed to `evaluate()`. It does not need
 * to understand arbitrary JavaScript — it needs to read what it can and
 * **preserve verbatim what it cannot**, which the spec is explicit about:
 * dynamic expressions must never be discarded or silently reduced to their
 * fallback.
 */

export type ValueNode =
  | { kind: 'string'; value: string; raw: string }
  | { kind: 'number'; value: number; raw: string }
  | { kind: 'boolean'; value: boolean; raw: string }
  | { kind: 'null'; raw: string }
  | { kind: 'undefined'; raw: string }
  | { kind: 'object'; properties: PropertyNode[]; raw: string }
  | { kind: 'array'; elements: ValueNode[]; raw: string }
  | { kind: 'dynamic'; raw: string; fallback?: ValueNode };

export interface PropertyNode {
  /** The property name, when it is statically known. */
  key: string | null;
  value: ValueNode;
  /** `{ method }` rather than `{ method: req.method }`. */
  shorthand: boolean;
  /** `...rest` — carried so a spread is reported rather than silently dropped. */
  spread: boolean;
  raw: string;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

const isPunctuator = (token: Token | undefined, value: string): boolean => (
  token !== undefined && token.type === 'punctuator' && token.value === value
);

/**
 * Finds the index just past a balanced group that starts at `open`.
 *
 * Returns the token count length when the group never closes, so a truncated
 * file degrades to "read what is there" rather than looping.
 */
export const matchGroup = (tokens: Token[], open: number): number => {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type === 'punctuator') {
      if (OPENERS.has(token.value)) {
        depth += 1;
      } else if (CLOSERS.has(token.value)) {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
    }
  }
  return tokens.length;
};

/**
 * Finds where an expression ends: the first `,` or closing delimiter that is
 * not nested inside a group.
 */
const expressionEnd = (tokens: Token[], from: number, stopAt: Set<string>): number => {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type !== 'punctuator') {
      continue;
    }
    if (OPENERS.has(token.value)) {
      depth += 1;
    } else if (CLOSERS.has(token.value)) {
      if (depth === 0 && stopAt.has(token.value)) {
        return index;
      }
      depth -= 1;
    } else if (depth === 0 && stopAt.has(token.value)) {
      return index;
    }
  }
  return tokens.length;
};

const rawOf = (source: string, tokens: Token[], from: number, to: number): string => {
  const first = tokens[from];
  const last = tokens[to - 1];
  if (first === undefined || last === undefined) {
    return '';
  }
  return source.slice(first.start, last.end).trim();
};

/**
 * Splits an expression on top-level `||` and `??`.
 *
 * `req.route?.path || "*"` is the shape the spec calls out: a dynamic value
 * with a clear fallback. Recognising it is what separates medium confidence
 * from low.
 */
const splitFallbackChain = (tokens: Token[], from: number, to: number): number[] => {
  const parts: number[] = [from];
  let depth = 0;

  for (let index = from; index < to; index += 1) {
    const token = tokens[index] as Token;
    if (token.type !== 'punctuator') {
      continue;
    }
    if (OPENERS.has(token.value)) depth += 1;
    else if (CLOSERS.has(token.value)) depth -= 1;
    else if (depth === 0 && (token.value === '||' || token.value === '??')) {
      parts.push(index + 1);
    }
  }

  return parts;
};

const LITERAL_IDENTIFIERS: Record<string, ValueNode> = {
  true: { kind: 'boolean', value: true, raw: 'true' },
  false: { kind: 'boolean', value: false, raw: 'false' },
  null: { kind: 'null', raw: 'null' },
  undefined: { kind: 'undefined', raw: 'undefined' },
};

/** Reads a single token as a literal, when it is one. */
const literalToken = (token: Token): ValueNode | null => {
  if (token.type === 'string') {
    return { kind: 'string', value: token.value, raw: token.raw };
  }
  if (token.type === 'number') {
    const value = Number(token.raw.replace(/_/gu, '').replace(/n$/u, ''));
    return Number.isNaN(value) ? null : { kind: 'number', value, raw: token.raw };
  }
  if (token.type === 'identifier') {
    const known = LITERAL_IDENTIFIERS[token.value];
    return known === undefined ? null : { ...known, raw: token.raw };
  }
  if (token.type === 'template') {
    // A template with no substitution is a constant string.
    const body = token.raw.slice(1, -1);
    return body.includes('${')
      ? null
      : { kind: 'string', value: body, raw: token.raw };
  }
  return null;
};

/** Reads a property key, when it is statically known. */
const propertyKey = (token: Token): string | null => {
  if (token.type === 'identifier') return token.value;
  if (token.type === 'string') return token.value;
  if (token.type === 'number') return token.raw;
  return null;
};

export interface ParsedExpression {
  node: ValueNode;
  /** Index just past the expression. */
  next: number;
}

/**
 * Parses one expression starting at `from`.
 *
 * Stops at a top-level `,` or at any of the closing delimiters in `stopAt`.
 */
export const parseExpression = (
  source: string,
  tokens: Token[],
  from: number,
  stopAt: Set<string> = new Set([',', ')', '}', ']']),
): ParsedExpression => {
  const to = expressionEnd(tokens, from, stopAt);
  const raw = rawOf(source, tokens, from, to);
  const first = tokens[from];

  if (first === undefined || to <= from) {
    return { node: { kind: 'dynamic', raw }, next: to };
  }

  // A single token that is a literal.
  if (to - from === 1) {
    const literal = literalToken(first);
    if (literal !== null) {
      return { node: literal, next: to };
    }
  }

  // `"auth" as const` — a TypeScript assertion over a literal value.
  if (to - from === 3 && tokens[from + 1]?.value === 'as') {
    const literal = literalToken(first);
    if (literal !== null) {
      return { node: { ...literal, raw }, next: to };
    }
  }

  // An object holds expressions and an expression can be an object, so these
  // three functions are genuinely mutually recursive. Function declarations are
  // hoisted, so the forward reference resolves before anything calls it.
  /* eslint-disable @typescript-eslint/no-use-before-define */
  if (isPunctuator(first, '{') && matchGroup(tokens, from) === to) {
    return { node: parseObject(source, tokens, from), next: to };
  }

  if (isPunctuator(first, '[') && matchGroup(tokens, from) === to) {
    return { node: parseArray(source, tokens, from), next: to };
  }
  /* eslint-enable @typescript-eslint/no-use-before-define */

  // Dynamic. Look for a fallback at the end of a `||` / `??` chain.
  const parts = splitFallbackChain(tokens, from, to);
  if (parts.length > 1) {
    const lastStart = parts[parts.length - 1] as number;
    const lastToken = tokens[lastStart];
    if (lastToken !== undefined && to - lastStart === 1) {
      const fallback = literalToken(lastToken);
      if (fallback !== null) {
        return { node: { kind: 'dynamic', raw, fallback }, next: to };
      }
    }
  }

  return { node: { kind: 'dynamic', raw }, next: to };
};

/** Parses an object literal whose `{` is at `open`. */
export function parseObject(source: string, tokens: Token[], open: number): ValueNode {
  const close = matchGroup(tokens, open) - 1;
  const properties: PropertyNode[] = [];
  let index = open + 1;

  while (index < close) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (isPunctuator(token, ',')) {
      index += 1;
      continue;
    }

    // Spread: `...defaults`.
    if (isPunctuator(token, '...')) {
      const parsed = parseExpression(source, tokens, index + 1, new Set([',', '}']));
      properties.push({
        key: null,
        value: parsed.node,
        shorthand: false,
        spread: true,
        raw: rawOf(source, tokens, index, parsed.next),
      });
      index = parsed.next;
      continue;
    }

    // Skip modifiers that can precede a key in object or class syntax.
    const modifier = token.type === 'identifier'
      && ['async', 'get', 'set'].includes(token.value);
    if (modifier
      && tokens[index + 1] !== undefined && !isPunctuator(tokens[index + 1], ':')
      && !isPunctuator(tokens[index + 1], ',') && !isPunctuator(tokens[index + 1], '(')) {
      index += 1;
      continue;
    }

    let key: string | null = null;
    let keyStart = index;

    if (isPunctuator(token, '[')) {
      // Computed key: `[dynamicKey]: value`. The name is not statically known.
      index = matchGroup(tokens, index);
    } else {
      key = propertyKey(token);
      index += 1;
    }

    const separator = tokens[index];

    // Shorthand: `{ method }` or `{ method, path }`.
    if (key !== null && (separator === undefined || isPunctuator(separator, ',')
      || isPunctuator(separator, '}'))) {
      properties.push({
        key,
        value: { kind: 'dynamic', raw: key },
        shorthand: true,
        spread: false,
        raw: rawOf(source, tokens, keyStart, index),
      });
      continue;
    }

    // A method: `{ evaluate() {} }`. Recorded as dynamic, never as a value.
    if (isPunctuator(separator, '(')) {
      const bodyStart = matchGroup(tokens, index);
      const end = isPunctuator(tokens[bodyStart], '{')
        ? matchGroup(tokens, bodyStart)
        : bodyStart;
      properties.push({
        key,
        value: { kind: 'dynamic', raw: rawOf(source, tokens, keyStart, end) },
        shorthand: false,
        spread: false,
        raw: rawOf(source, tokens, keyStart, end),
      });
      index = end;
      continue;
    }

    if (!isPunctuator(separator, ':')) {
      // Not a shape this parser models; skip to the next comma so one odd
      // property does not discard the rest of the object.
      const skipTo = expressionEnd(tokens, index, new Set([',', '}']));
      index = skipTo === index ? index + 1 : skipTo;
      continue;
    }

    keyStart = index + 1;
    const parsed = parseExpression(source, tokens, keyStart, new Set([',', '}']));
    properties.push({
      key,
      value: parsed.node,
      shorthand: false,
      spread: false,
      raw: rawOf(source, tokens, keyStart, parsed.next),
    });
    index = parsed.next;
  }

  return {
    kind: 'object',
    properties,
    raw: rawOf(source, tokens, open, close + 1),
  };
}

/** Parses an array literal whose `[` is at `open`. */
export function parseArray(source: string, tokens: Token[], open: number): ValueNode {
  const close = matchGroup(tokens, open) - 1;
  const elements: ValueNode[] = [];
  let index = open + 1;

  while (index < close) {
    if (isPunctuator(tokens[index], ',')) {
      index += 1;
      continue;
    }
    const parsed = parseExpression(source, tokens, index, new Set([',', ']']));
    elements.push(parsed.node);
    index = parsed.next === index ? index + 1 : parsed.next;
  }

  return {
    kind: 'array',
    elements,
    raw: rawOf(source, tokens, open, close + 1),
  };
}

/** Reads a named property from an object node. */
export const property = (node: ValueNode, name: string): ValueNode | undefined => {
  if (node.kind !== 'object') {
    return undefined;
  }
  return node.properties.find((entry) => entry.key === name && !entry.spread)?.value;
};

/** The static string value of a node, when it has one. */
export const staticString = (node: ValueNode | undefined): string | undefined => {
  if (node === undefined) {
    return undefined;
  }
  if (node.kind === 'string') {
    return node.value;
  }
  if (node.kind === 'number' || node.kind === 'boolean') {
    return String(node.value);
  }
  return undefined;
};
