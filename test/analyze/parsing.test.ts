import { describe, expect, it } from '@jest/globals';
import { tokenize, type Token } from '../../src/analyze/lexer.js';
import {
  parseExpression, property, staticString, type ValueNode,
} from '../../src/analyze/expression.js';

const values = (source: string): Token[] => tokenize(source).tokens;

const parse = (source: string): ValueNode => {
  const tokens = values(source);
  return parseExpression(source, tokens, 0).node;
};

describe('tokenize', () => {
  it('reports 1-based line and column', () => {
    const [first, second] = values('const a = 1;\n  const b = 2;');
    expect(first).toMatchObject({ value: 'const', line: 1, column: 1 });
    expect(second).toMatchObject({ value: 'a', line: 1, column: 7 });

    const tokens = values('const a = 1;\n  const b = 2;');
    const b = tokens.find((token) => token.value === 'b');
    expect(b).toMatchObject({ line: 2, column: 9 });
  });

  it('does not see code inside a line comment', () => {
    const tokens = values('// client.evaluate({})\nreal;');
    expect(tokens.map((token) => token.value)).toEqual(['real', ';']);
  });

  it('does not see code inside a block comment', () => {
    const tokens = values('/* client.evaluate({\n}) */ real;');
    expect(tokens.map((token) => token.value)).toEqual(['real', ';']);
    expect(tokens[0]).toMatchObject({ line: 2, column: 7 });
  });

  it('does not see code inside a string', () => {
    const tokens = values('const s = "client.evaluate({})";');
    expect(tokens.filter((token) => token.value === 'evaluate')).toEqual([]);
  });

  it('decodes string escapes', () => {
    expect(parse('"a\\nb"')).toEqual({ kind: 'string', value: 'a\nb', raw: '"a\\nb"' });
    expect(parse('"\\u0041"')).toMatchObject({ value: 'A' });
    expect(parse('"\\x41"')).toMatchObject({ value: 'A' });
    expect(parse('"\\u{1F600}"')).toMatchObject({ value: '\u{1F600}' });
    expect(parse('"say \\"hi\\""')).toMatchObject({ value: 'say "hi"' });
  });

  it('keeps a template literal whole, including nested substitutions', () => {
    const tokens = values('`a${ `b${ c }` }d`;');
    expect(tokens[0]).toMatchObject({ type: 'template', raw: '`a${ `b${ c }` }d`' });
  });

  it('treats a slash as a regex only where a value can appear', () => {
    expect(values('return /ab+/g;')[1]).toMatchObject({ type: 'regex', raw: '/ab+/g' });
    expect(values('const r = /a\\/b/;')[3]).toMatchObject({ type: 'regex' });
    // Division, not a regex: the rest of the line must still tokenize.
    const divided = values('const x = total / count / 2;');
    expect(divided.filter((token) => token.type === 'regex')).toEqual([]);
    expect(divided[divided.length - 2]).toMatchObject({ value: '2' });
  });

  it('falls back to division when a regex would run past the line', () => {
    const tokens = values('const x = a / b;\nconst y = c / d;');
    expect(tokens.filter((token) => token.type === 'regex')).toEqual([]);
  });

  it('reads a whole file without throwing when it is malformed', () => {
    const result = tokenize('const a = "unterminated\nclient.evaluate({});');
    expect(result.recovered).toBe(true);
    expect(result.tokens.some((token) => token.value === 'evaluate')).toBe(true);
  });
});

describe('parseExpression', () => {
  it('reads literals', () => {
    expect(parse('"auth"')).toMatchObject({ kind: 'string', value: 'auth' });
    expect(parse('42')).toMatchObject({ kind: 'number', value: 42 });
    expect(parse('true')).toMatchObject({ kind: 'boolean', value: true });
    expect(parse('null')).toMatchObject({ kind: 'null' });
    expect(parse('`plain`')).toMatchObject({ kind: 'string', value: 'plain' });
  });

  it('reads a literal through a TypeScript assertion', () => {
    expect(parse('"auth" as const')).toMatchObject({ kind: 'string', value: 'auth' });
  });

  it('reads a nested object', () => {
    const node = parse('{ target: { service: "auth", action: "login" }, n: 1 }');
    expect(staticString(property(property(node, 'target') as ValueNode, 'service')))
      .toBe('auth');
    expect(staticString(property(node, 'n'))).toBe('1');
  });

  it('reads an array', () => {
    const node = parse('["a", "b"]');
    expect(node.kind).toBe('array');
    expect(node.kind === 'array' && node.elements.map((entry) => staticString(entry)))
      .toEqual(['a', 'b']);
  });

  it('preserves a dynamic expression verbatim and finds its fallback', () => {
    const node = parse('req.route?.path || "*"');
    expect(node).toMatchObject({
      kind: 'dynamic',
      raw: 'req.route?.path || "*"',
      fallback: { kind: 'string', value: '*' },
    });
  });

  it('finds a fallback through a nullish chain', () => {
    expect(parse('a ?? b ?? "last"')).toMatchObject({
      fallback: { kind: 'string', value: 'last' },
    });
  });

  it('does not invent a fallback when the last operand is not a literal', () => {
    expect(parse('a || b()')).toEqual({ kind: 'dynamic', raw: 'a || b()' });
  });

  it('does not mistake a nested || for a fallback', () => {
    const node = parse('{ resource: f(a || "x") }');
    expect(property(node, 'resource')).toEqual({
      kind: 'dynamic',
      raw: 'f(a || "x")',
    });
  });

  it('records shorthand properties by name', () => {
    const node = parse('{ method, path }');
    expect(node.kind === 'object' && node.properties.map((entry) => entry.key))
      .toEqual(['method', 'path']);
    expect(node.kind === 'object' && node.properties.every((entry) => entry.shorthand))
      .toBe(true);
  });

  it('records a spread rather than dropping it', () => {
    const node = parse('{ ...base, a: 1 }');
    expect(node.kind === 'object' && node.properties[0]).toMatchObject({
      spread: true,
      key: null,
    });
  });

  it('gives a computed key a null name', () => {
    const node = parse('{ [key]: 1, b: 2 }');
    expect(node.kind === 'object' && node.properties.map((entry) => entry.key))
      .toEqual([null, 'b']);
  });

  it('survives an object containing an arrow function with braces and commas', () => {
    const node = parse('{ a: (x, y) => { return x + y; }, service: "auth" }');
    expect(staticString(property(node, 'service'))).toBe('auth');
  });

  it('survives a trailing comma', () => {
    const node = parse('{ service: "auth", }');
    expect(staticString(property(node, 'service'))).toBe('auth');
  });

  it('keeps a template with substitution dynamic', () => {
    const node = parse('{ resource: `/users/${id}` }');
    expect(property(node, 'resource')).toMatchObject({
      kind: 'dynamic',
      raw: '`/users/${id}`',
    });
  });
});
