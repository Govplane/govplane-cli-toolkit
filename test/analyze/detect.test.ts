import { describe, expect, it } from '@jest/globals';
import { detectCalls, govplaneBindings } from '../../src/analyze/detect.js';
import { tokenize } from '../../src/analyze/lexer.js';

const detect = (source: string) => detectCalls(source, 'src/app.ts');
const bindings = (source: string) => govplaneBindings(tokenize(source).tokens);

describe('govplaneBindings', () => {
  it('reads named, default and namespace imports', () => {
    expect(bindings("import { createPolicyEngine } from '@govplane/runtime-sdk';"))
      .toContain('createPolicyEngine');
    expect(bindings("import govplane from '@govplane/runtime-sdk';"))
      .toContain('govplane');
    expect(bindings("import * as sdk from '@govplane/runtime-sdk';"))
      .toContain('sdk');
  });

  it('binds the local name of an aliased import, not the exported one', () => {
    const found = bindings(
      "import { createPolicyEngine as makeEngine } from '@govplane/runtime-sdk';",
    );
    expect(found).toContain('makeEngine');
    expect(found).not.toContain('createPolicyEngine');
  });

  it('reads a require call', () => {
    expect(bindings("const sdk = require('@govplane/runtime-sdk');")).toContain('sdk');
  });

  it('follows a factory call to the client variable', () => {
    const found = bindings([
      "import { createPolicyEngine } from '@govplane/runtime-sdk';",
      'const enforcer = createPolicyEngine({ getBundle });',
    ].join('\n'));
    expect(found).toContain('enforcer');
  });

  it('follows a two-step chain through a namespace import', () => {
    const found = bindings([
      "const sdk = require('@govplane/runtime-sdk');",
      'const gate = sdk.createClient();',
    ].join('\n'));
    expect(found).toContain('gate');
  });

  it('ignores imports from unrelated modules', () => {
    expect(bindings("import { evaluate } from 'mathjs';")).not.toContain('evaluate');
  });
});

describe('detectCalls', () => {
  it('finds a call through an aliased client with a non-obvious name', () => {
    const result = detect([
      "import { createPolicyEngine } from '@govplane/runtime-sdk';",
      'const enforcer = createPolicyEngine({ getBundle });',
      'await enforcer.evaluate({',
      '  target: { service: "auth", resource: "login", action: "authenticate" },',
      '});',
    ].join('\n'));

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      confidence: 'high',
      matchedBy: 'binding',
    });
  });

  it('finds a call by shape when the client came from somewhere it cannot see', () => {
    const result = detect([
      'export const middleware = (req, res, next) => {',
      '  const decision = req.app.locals.governance.evaluate({',
      '    target: { service: "api", resource: "/health", action: "request" },',
      '  });',
      '};',
    ].join('\n'));

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ matchedBy: 'shape', confidence: 'high' });
  });

  it('reports the line and column of the receiver', () => {
    const result = detect([
      'const a = 1;',
      '',
      '        gp.evaluate({ target: { service: "s", resource: "r", action: "a" } });',
    ].join('\n'));

    expect(result.calls[0]?.location).toEqual({ file: 'src/app.ts', line: 3, column: 9 });
  });

  it('ignores an unrelated evaluate() call', () => {
    const result = detect([
      "import { evaluate } from 'mathjs';",
      'const total = evaluate("2 + 2");',
      'calculator.evaluate({ expression: "1+1" });',
    ].join('\n'));

    expect(result.calls).toEqual([]);
  });

  it('ignores an evaluate() inside a comment or a string', () => {
    const result = detect([
      '// gp.evaluate({ target: { service: "s", resource: "r", action: "a" } });',
      'const doc = "gp.evaluate({ target: { service: 1 } })";',
    ].join('\n'));

    expect(result.calls).toEqual([]);
  });

  it('preserves a dynamic expression and its fallback', () => {
    const result = detect([
      'gp.evaluate({',
      '  target: {',
      '    service: "api-gateway",',
      '    resource: req.route?.path || "*",',
      '    action: "request"',
      '  }',
      '});',
    ].join('\n'));

    expect(result.calls[0]).toMatchObject({
      target: { service: 'api-gateway', resource: '*', action: 'request' },
      confidence: 'medium',
      expressions: {
        resource: { dynamic: true, source: 'req.route?.path || "*"', fallback: '*' },
      },
    });
  });

  it('is low confidence when a component cannot be resolved at all', () => {
    const result = detect([
      'gp.evaluate({',
      '  target: { service: resolveService(req), resource: "login", action: "authenticate" }',
      '});',
    ].join('\n'));

    expect(result.calls[0]).toMatchObject({
      confidence: 'low',
      target: { service: '*' },
      expressions: { service: { dynamic: true, source: 'resolveService(req)' } },
    });
    expect(result.calls[0]?.expressions.service?.fallback).toBeUndefined();
  });

  it('collects context keys with their source expressions', () => {
    const result = detect([
      'gp.evaluate({',
      '  target: { service: "auth", resource: "login", action: "authenticate" },',
      '  context: { method: req.method, attempts: 6, tag: `v${n}`, plan }',
      '});',
    ].join('\n'));

    expect(result.calls[0]?.availableContext).toEqual([
      { key: 'method', source: 'req.method' },
      { key: 'attempts', source: '6', type: 'number' },
      { key: 'tag', source: '`v${n}`', type: 'string' },
      { key: 'plan', source: 'plan' },
    ]);
  });

  it('reports a recognised call whose target it cannot read', () => {
    const result = detect([
      "import { createPolicyEngine } from '@govplane/runtime-sdk';",
      'const gp = createPolicyEngine({ getBundle });',
      'gp.evaluate(request);',
    ].join('\n'));

    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([{ file: 'src/app.ts', line: 3, column: 1 }]);
  });

  it('finds several calls in one file', () => {
    const result = detect([
      'gp.evaluate({ target: { service: "a", resource: "b", action: "c" } });',
      'gp.evaluate({ target: { service: "d", resource: "e", action: "f" } });',
    ].join('\n'));

    expect(result.calls.map((call) => call.target.service)).toEqual(['a', 'd']);
  });

  it('reads a call whose argument contains a nested arrow function', () => {
    const result = detect([
      'gp.evaluate({',
      '  target: { service: "a", resource: "b", action: "c" },',
      '  onDeny: () => { log({ a: 1 }); },',
      '});',
    ].join('\n'));

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.target).toEqual({ service: 'a', resource: 'b', action: 'c' });
  });

  it('reads a call on a receiver produced by a call', () => {
    const result = detect([
      "import { getClient } from '@govplane/runtime-sdk';",
      'getClient({ tenant: "a" }).evaluate({',
      '  target: { service: "a", resource: "b", action: "c" }',
      '});',
    ].join('\n'));

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.matchedBy).toBe('binding');
  });

  it('reads a call on an indexed receiver', () => {
    const result = detect([
      'clients["primary"].evaluate({',
      '  target: { service: "a", resource: "b", action: "c" }',
      '});',
    ].join('\n'));

    expect(result.calls).toHaveLength(1);
  });

  it('needs two recognisable target parts before matching on shape alone', () => {
    const result = detect('thing.evaluate({ target: { service: "a" } });');
    expect(result.calls).toEqual([]);
  });

  it('reads a call on a deeply chained receiver', () => {
    const result = detect(
      'this.deps.governance.evaluate({ target: { service: "a", resource: "b", action: "c" } });',
    );
    expect(result.calls).toHaveLength(1);
  });
});
