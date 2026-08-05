# `govplane analyze`

Finds the places your application asks Govplane for a decision, and turns them
into reviewable policy drafts.

```bash
govplane analyze [options]
```

## What it does, and what it refuses to do

`analyze` reads your source code and reports where `evaluate()` is called, what
target each call asks about, and what context it has available. It compares
those targets against the policies you already have, so you can see what is
governed and what is not.

It **never writes a rule, condition, effect or priority**. Discovering where
policy is evaluated is not the same as knowing what it should decide. Every
generated policy is a shell with `"rules": []`, and the decisions stay yours.

```text
Govplane Analysis

Source:
  /Users/example/projects/my-api
  3 files scanned

Discovered 2 policies:

  missing  api-gateway-request
     api-gateway / * / request
     src/middleware/governance.js:7
     confidence: medium

  covered  payments-refund-execute
     payments / refund / execute
     src/payments/audit.ts:3 and 1 more location
     existing: payments-refund-execute

Draft:
  governance/policy-drafts.json

Result:
  Analysis completed successfully

Drafts carry no rules — analyze never invents them.
Add rules with "govplane policies add-rule", then run "govplane build".
```

## Source path and working folder

These are separate on purpose. The source path is the application; the working
folder is where governance artifacts live.

```bash
govplane analyze --source . --working-folder ./governance
```

| Path | Default | Used for |
| ---- | ------- | -------- |
| `--source` | current directory | the code that gets scanned |
| `-w`, `--working-folder` | current directory | config, the draft, `--bundle` paths |

The recommended layout keeps them apart:

```text
project-root/
├── src/
│   └── ...
└── governance/
    ├── govplane.config.json
    ├── policy-drafts.json
    └── policy-bundle.json
```

Set the working folder once and stop repeating it:

```bash
govplane working-folder set ./governance
govplane analyze --source .
```

## How calls are found

The analyzer parses JavaScript and TypeScript rather than pattern-matching text,
so it does not report an `evaluate(` that appears inside a comment, a string or
a disabled block, and it can read an argument containing nested braces, arrow
functions or template literals.

A call is recognised two ways, and either is enough:

| Signal | Example |
| ------ | ------- |
| **Binding** — the receiver traces back to a Govplane import | `import { createPolicyEngine } from '@govplane/runtime-sdk'` → `const enforcer = createPolicyEngine(…)` → `enforcer.evaluate(…)` |
| **Shape** — the call passes a recognisable target | `req.app.locals.governance.evaluate({ target: { service, resource, action } })` |

Shape matters more in practice. It finds the client that arrived through
dependency injection, a framework context, or a local module the analyzer cannot
follow — regardless of what the variable is called. Imports, `require`, aliased
imports and factory calls are all followed for the binding signal.

`node_modules`, `dist`, `build`, `coverage` and the other usual directories are
skipped: `evaluate()` calls in your dependencies are somebody else's policy
surface.

## Dynamic values are preserved, never reduced

A target component that is not a literal keeps its original expression:

```js
resource: req.route?.path || "*"
```

```json
{
  "target": { "service": "api-gateway", "resource": "*", "action": "request" },
  "resourceExpression": {
    "dynamic": true,
    "source": "req.route?.path || \"*\"",
    "fallback": "*"
  }
}
```

Reducing that to `"resource": "*"` would throw away the one piece of information
that tells a reviewer what the value actually is at runtime.

### Confidence

| Level | Meaning |
| ----- | ------- |
| `high` | every target value is a literal |
| `medium` | dynamic values, but each has a clear fallback |
| `low` | a value comes from a function or variable that cannot be resolved |

A component that cannot be resolved at all becomes `*`, with the expression
recorded and the discovery marked `low`.

## Context

Every context key passed at a call site is recorded with the expression it came
from:

```json
"availableContext": [
  { "key": "method", "source": "req.method" },
  { "key": "currency", "source": "'EUR'", "type": "string" },
  { "key": "reviewed", "source": "true", "type": "boolean" }
]
```

`type` appears only where the language guarantees it — a literal, a template
(always a string), `Number(x)`, `!x`. `req.method` is left untyped: calling it a
string would be inventing knowledge the source does not carry.

## Consolidation

Calls that share a `service + resource + action` become one draft, aggregating
every context key and every source location:

```text
  covered  payments-refund-execute
     payments / refund / execute
     src/payments/audit.ts:3 and 1 more location
```

Output is fully ordered — discoveries by identifier, sources and context keys
sorted — so re-running over unchanged source produces a byte-identical draft.

## Bundle comparison

```bash
govplane analyze --bundle ./policy-bundle.json
govplane analyze --bundle ./prod.json --bundle ./staging.json
```

`--bundle` paths resolve from the **working folder**, not the source path.

| Status | Meaning |
| ------ | ------- |
| `covered` | one existing policy has a rule for this target |
| `ambiguous` | more than one does — which should own it is your call, not the analyzer's |
| `partially-covered` | a policy governs the same service and part of the rest |
| `missing` | nothing governs it |

A bundle wildcard covers a specific target: a rule on `api / * / request` covers
`api / /health / request`, so no duplicate policy is proposed.

Coverage is judged by **rule** targets. A policy with a default effect and no
rules declares no target, so it covers nothing specific — which is why a policy
you have created but not yet written a rule for still reports as `missing`.

### Bundles must pass validation first

Every `--bundle` is checked against the same structural rules the remote path
enforces when it materialises a bundle — `schemaVersion`, scope fields, `env`,
effects, rule targets, condition AST. A bundle that fails cannot be compared
against meaningfully, so nothing is analysed:

```text
Error: 1 bundle failed validation.

governance/broken.json:
   orgId: orgId and projectId are required.
   MISSING_SCOPE_FIELDS

A bundle that fails validation cannot be compared against.
Nothing was analysed.

BUNDLE_VALIDATION_FAILED
```

## The draft it writes

Output path, in order: `--output-draft`, then `analyze.outputDraft` or
`draft.path` in configuration, then `policy-drafts.json` in the working folder.

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-08-02T16:42:02.420Z",
  "drafts": [
    {
      "id": "api-gateway-request",
      "status": "missing",
      "confidence": "medium",
      "target": { "service": "api-gateway", "resource": "*", "action": "request" },
      "resourceExpression": {
        "dynamic": true,
        "source": "req.route?.path || \"*\"",
        "fallback": "*"
      },
      "availableContext": [
        { "key": "method", "source": "req.method" },
        { "key": "path", "source": "req.path" }
      ],
      "suggestedPolicy": {
        "policyKey": "api-gateway-request",
        "friendlyName": "API Gateway Request",
        "target": { "service": "api-gateway", "resource": "*", "action": "request" },
        "rules": []
      },
      "sources": [
        { "file": "src/middleware/governance.js", "line": 7, "column": 26 }
      ]
    }
  ]
}
```

Source paths are relative to the scanned root, so a draft committed from one
machine reads correctly on another.

### An existing draft is never overwritten silently

```text
Error: A draft file already exists.

Existing draft: governance/policy-drafts.json
It has uncommitted changes.

Choose what should happen to it:
  --merge    add newly discovered targets, keeping everything already there
  --force    replace it with the new analysis

DRAFT_EXISTS
```

In a terminal you are asked instead, and warned when the file has uncommitted
changes or has been edited since discovery.

`--merge` appends only targets the draft does not already know about, and never
rewrites an entry you may have edited. It keeps the shape the file already had,
so a draft you have been authoring with `govplane policies` stays build-ready
rather than turning into a mixture of two formats.

```text
Draft:
  governance/policy-drafts.json  (merged)
  1 added, 2 already present
```

## CI mode

```bash
govplane analyze --check
```

Exits non-zero when uncovered drafts exist, and **writes nothing**:

```text
Found 2 uncovered policy drafts

api-gateway / * / request
src/middleware/governance.js:7

payments / refund / execute
src/payments/audit.ts:3
```

This is governance drift detection: a new `evaluate()` call with no policy
behind it fails the build.

```yaml
- run: govplane analyze --check --bundle ./governance/policy-bundle.json
```

A bundle that fails parity validation also fails `--check`, and is reported
first.

## Interactive review

```bash
govplane analyze --interactive
```

Steps through each discovery:

```text
[1/2]  api-gateway-request
  Target:     api-gateway / * / request
  Status:     missing
  Confidence: medium
  Found in:   src/middleware/governance.js:7

  What should happen to this draft? [accept/ignore/rename/merge/context/quit]
> 
```

| Answer | Effect |
| ------ | ------ |
| `accept` (or Enter) | keep it |
| `ignore` | leave it out of the draft |
| `rename` | give the policy a different key |
| `merge` | fold it into a draft already accepted, keeping both sets of evidence |
| `context` | show the detected context fields |
| `quit` | stop reviewing and accept everything remaining |

A unique prefix works, so `i` is `ignore`. Ctrl-D accepts the rest rather than
losing the answers already given. Without a terminal, `--interactive` is an
error rather than a command that waits forever.

## Options

```text
--source <path>              Root directory to scan (default: current directory)
--output-draft <path>        Where to write the draft
--bundle <path>              Bundle to compare against; repeatable
--check                      Report uncovered drafts and exit non-zero (CI mode)
--interactive                Step through each discovery
--merge                      Add new discoveries to an existing draft
--force                      Replace an existing draft
--format <text|json>         Output format
--quiet                      Suppress non-essential output
--verbose                    Show resolved paths and per-file diagnostics
-w, --working-folder <path>  Working folder
--config <path>              Configuration file
-h, --help                   Command help
```

`--merge` and `--force` are additions to the option list in the spec, required
by its own instruction that overwriting an existing draft must be confirmed:
without a terminal there has to be a way to say which you meant.

## Configuration

```json
{
  "analyze": {
    "source": "./src",
    "exclude": ["*.test.ts", "src/**/fixtures/*", "legacy"],
    "bundles": ["policy-bundle.json"],
    "outputDraft": "policy-drafts.json"
  }
}
```

`exclude` adds to the built-in list. A bare name matches any path segment; `*`
matches within a segment and `**` across them.

## JSON output

```json
{
  "success": true,
  "source": "/project",
  "workingFolder": "/project/governance",
  "draft": { "path": "/project/governance/policy-drafts.json", "disposition": "merge" },
  "stats": {
    "filesScanned": 3,
    "discovered": 2,
    "written": 1,
    "alreadyPresent": 1,
    "unresolvedCalls": 0
  },
  "drafts": [
    {
      "id": "payments-refund-execute",
      "status": "covered",
      "confidence": "high",
      "target": { "service": "payments", "resource": "refund", "action": "execute" },
      "availableContext": [{ "key": "amount", "source": "amount" }],
      "sources": [{ "file": "src/payments/audit.ts", "line": 3, "column": 41 }]
    }
  ]
}
```

`--check --format json` reports `uncovered` and `total` instead.

## Calls it could not read

```text
1 evaluation call could not be read:
  src/dynamic.js:3
  The target was not a literal object at the call site.
```

A call like `gp.evaluate(request)` is recognised as a Govplane evaluation but its
target lives in a variable. It is reported rather than dropped, so you are never
told "nothing found" when something was found and not understood.

A file that does not parse cleanly is analysed as far as it can be, and named
under `--verbose`. One malformed file never fails the run.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Analysis completed |
| `1` | `--check` found uncovered drafts |
| `2` | Source, bundle or working-folder error |
| `3` | Invalid arguments, or `--interactive` with no terminal |
| `4` | A comparison bundle failed validation |
| `5` | A draft already exists and neither `--merge` nor `--force` was given |
| `6` | The draft could not be written |
| `7` | Not activated and the grace period has ended |

## Where this sits

```text
Source code
    ↓
analyze  ──── compares against ────  policy-bundle.json
    ↓
policy-drafts.json
    ↓
you add rules, conditions, effects and priorities
    ↓
build  →  sign  →  SDK
```

```bash
govplane analyze --source . -w ./governance
govplane policies -w ./governance update-policy --policy-key api-gateway-request --defaults-effect allow
govplane policies -w ./governance add-rule --policy-key api-gateway-request --rule-file ./rule.json
govplane build -w ./governance
govplane analyze --source . -w ./governance --check --bundle policy-bundle.json
```

The last line is the loop closing: what analyze discovered is now covered by a
policy you wrote, and CI will say so.
