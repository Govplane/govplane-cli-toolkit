# `govplane simulate`

Evaluates targets and contexts against a bundle or draft, locally, using the
**published Govplane runtime engine**.

```bash
govplane simulate [options]
```

## Why it can be trusted

`simulate` does not contain decision logic. It loads `@govplane/runtime-sdk` —
the same engine your application evaluates policies with — and asks it. Effect
precedence, priority ordering, tie-breaking and the deny-by-default fallback all
belong to the engine.

A simulator with its own decision logic would eventually disagree with
production, and would be worse than no simulator at all: a confident one that
lies.

## A single evaluation

```bash
govplane simulate \
  --service auth --resource login --action authenticate \
  --context '{"failedAttempts":6}'
```

```text
Govplane Simulation

Input:
  Bundle: policy-bundle.json
  Target: auth / login / authenticate

Signature:
  valid (HMAC_SHA256, local-key-01)

Context:
  failedAttempts: 6

Decision:
  decision: deny
  reason: rule

Match:
  Policy: login-protection
  Rule: deny-after-five

Result:
  Simulation completed successfully
```

The `Match` block distinguishes the three ways a decision arises, because they
mean very different things when you are debugging:

| Match block says | What happened |
| ---------------- | ------------- |
| `Policy: … / Rule: …` | A rule matched and won |
| `No rule matched this target.` | A policy's default effect applied |
| `No policy applied to this target.` | Nothing matched; the engine's own fallback applied |

## Input

| Order | Source |
| ----- | ------ |
| 1 | `--bundle <path>` or `--draft <path>` |
| 2 | `bundle.path` in `govplane.config.json` |
| 3 | `policy-bundle.json` in the working folder |
| 4 | the project's draft file |

A **draft** is compiled in memory before evaluation, so you can simulate
authoring changes without building first:

```bash
govplane simulate --draft ./policy-drafts.json \
  --service auth --resource login --action authenticate
```

Nothing is written to disk when a draft is simulated.

## Targets and context

A target is the three-part question the engine answers. Give it as parts or as
JSON, not both:

```bash
--service auth --resource login --action authenticate
--target '{"service":"auth","resource":"login","action":"authenticate"}'
```

Context can come from exactly one place — inline JSON, a file, or repeated
key-value pairs:

```bash
--context '{"failedAttempts":6,"plan":"pro"}'
--context-file ./contexts/blocked-user.json
--context-value failedAttempts=6 --context-value plan=pro
```

Combining two forms is refused rather than merged. Merging looks helpful right
up to the run where a value came from the file you forgot you had configured.

### Value types

`--context-value` infers the obvious types, and takes a hint when inference
would be wrong:

| Written | Parsed as |
| ------- | --------- |
| `failedAttempts=6` | number `6` |
| `enabled=true` | boolean `true` |
| `missing=null` | `null` |
| `country=ES` | string `"ES"` |
| `postcode:string=28001` | string `"28001"` — not the number 28001 |
| `count:number=3` | number `3` |

Supported hints: `string`, `number`, `boolean`, `null`.

### Keys no rule reads

```text
Note: no rule reads failedAtempts. This bundle reads: failedAttempts.
```

A misspelled context key does not produce a wrong decision — it produces an
*inexplicable* one, because the rule that should have matched never saw its
value. Worth saying; not worth failing over.

## Scenarios and suites

A scenario is one evaluation written down. A suite is a list of them, which
makes policy behaviour testable in CI:

```json
{
  "name": "Login protection",
  "scenarios": [
    {
      "name": "Blocks the sixth attempt",
      "target": { "service": "auth", "resource": "login", "action": "authenticate" },
      "context": { "failedAttempts": 6 },
      "expected": { "decision": "deny", "ruleId": "deny-after-five" }
    },
    {
      "name": "Allows a first attempt",
      "target": { "service": "auth", "resource": "login", "action": "authenticate" },
      "context": { "failedAttempts": 1 },
      "expected": { "decision": "allow", "reason": "default" }
    }
  ]
}
```

```bash
govplane simulate --suite ./simulations/auth-suite.json
```

```text
Govplane Simulation

Input: policy-bundle.json

Signature:
  valid (HMAC_SHA256, local-key-01)

pass  Blocks the sixth attempt
      auth / login / authenticate → deny (rule)
pass  Allows a first attempt
      auth / login / authenticate → allow (default)
FAIL  Deliberately wrong expectation
      auth / login / authenticate → deny (rule)

Summary:
  Scenarios: 3
  Passed: 2
  Failed: 1
  Duration: 3ms

Scenario failed: Deliberately wrong expectation

  Expected decision: allow
  Actual   decision: deny
```

Any failed expectation exits `1`, so a suite works as a CI gate with no wrapper
script.

### Expectations

Assert `decision`, `reason`, `policyKey`, `ruleId` or `value`. **Only the fields
you declare are checked** — a scenario asserting a decision says nothing about
which rule produced it, and should not start failing because a rule was renamed.

A scenario with no `expected` block always passes; it is being used to *observe*
a decision, not to assert one.

The older spellings `effect` (for `decision`) and `ruleKey` (for `ruleId`) are
still accepted, so existing scenario files keep working.

## Tracing

```bash
govplane simulate --service auth --resource login --action authenticate \
  --context '{"failedAttempts":6}' --trace full
```

```text
Evaluation trace:
  Policies seen: 1
  Rules seen:    1
  Matched:       1

  Rules considered:
    login-protection / deny-after-five  priority 100  matched

  Selected:
    login-protection / deny-after-five (priority 100, effect deny)
```

| Level | Shows |
| ----- | ----- |
| `off` | nothing (default) |
| `errors` | traces only where evaluation failed |
| `sampled` | as production sampling would, but forced so it is deterministic here |
| `full` | every rule considered, and why the winner won |

`--trace` with no value means `--trace full`.

## Signature verification

When the project pins signing key material, the bundle's signature is verified
**before** anything is evaluated. Simulating an artifact you cannot vouch for
tells you what *some* bundle does, not what yours does.

Key material is read from `sign.signing` or `build.signing` in
`govplane.config.json` — verification does not care which step produced the
signature, only how the project signs at all. For ECDSA it also reads
`signature.publicKeyPath`, `GOVPLANE_PUBLIC_KEY` or `GOVPLANE_PUBLIC_KEY_PATH`.

| Status | Meaning | Result |
| ------ | ------- | ------ |
| `valid` | Verified against the pinned key | proceeds |
| `invalid` | The signature does not match | **stops**, exit `4` |
| `missing` | A key is pinned; the bundle carries no signature | **stops**, exit `4` |
| `unverifiable` | Signed with an algorithm whose key is not configured | proceeds, reported |
| `skipped` | Nothing pinned, or the input is a draft | proceeds, reported |

```text
Error: The bundle signature is not valid.

The bundle may have been modified after it was signed.

To simulate anyway, and accept that the results are untrusted:
  govplane simulate --skip-signature-verification

SIGNATURE_INVALID
```

Skipping is loud, on stderr, every time:

```text
Warning: Bundle signature verification was skipped.
Simulation results must not be considered trusted.
```

A **draft** is never verified: it was compiled in memory a moment ago and has no
signature by construction.

## Reports

```bash
govplane simulate --suite ./simulations/auth-suite.json --report
```

Written to `.govplane/reports/simulation-<timestamp>.json`, or to a path you
give: `--report ./out/run.json`.

```json
{
  "cliVersion": "1.0.0",
  "runtimeEngine": "@govplane/runtime-sdk",
  "executedAt": "2026-08-02T11:28:34.443Z",
  "durationMs": 3,
  "input": {
    "documentType": "bundle",
    "documentPath": "/project/policy-bundle.json",
    "bundleVersion": 1,
    "checksum": "sha256:8add…"
  },
  "signature": { "status": "valid", "algorithm": "HMAC_SHA256", "keyId": "local-key-01" },
  "summary": { "total": 3, "asserted": 3, "passed": 2, "failed": 1 },
  "scenarios": [
    {
      "name": "Blocks the sixth attempt",
      "target": { "service": "auth", "resource": "login", "action": "authenticate" },
      "context": { "failedAttempts": 6, "email": "[REDACTED]" },
      "result": {
        "decision": "deny",
        "reason": "rule",
        "policyKey": "login-protection",
        "ruleId": "deny-after-five"
      },
      "expectation": { "defined": true, "passed": true }
    }
  ]
}
```

A report records which engine produced the result, and against which bundle
version and checksum, so a decision can be traced back to the artifact that
made it.

### Redaction

Context fields named in `simulate.redactContextFields` are masked in console
output **and** in reports — a report is a file that gets attached to pull
requests. Matching is case-insensitive. The value used for evaluation is never
altered, so redaction cannot change a decision.

## Options

```text
--bundle <path>                  Bundle to simulate against
--draft <path>                   Draft to simulate against
--scenario <path>                Scenario file to run
--suite <path>                   Suite of scenarios to run
--target <json>                  Target as a JSON object
--service <value>                Target service
--resource <value>               Target resource
--action <value>                 Target action
--context <json>                 Context as a JSON object
--context-file <path>            Context from a JSON file
--context-value <key=value>      One context value; repeatable
--trace [level]                  off, errors, sampled or full (default: full)
--skip-signature-verification    Simulate without verifying the signature
--report [path]                  Write a simulation report
--format <text|json>             Output format
--quiet                          Suppress non-essential output
--verbose                        Show resolved paths and the input document
-w, --working-folder <path>      Working folder
--config <path>                  Configuration file
-h, --help                       Command help
```

## Configuration

```json
{
  "simulate": {
    "directory": "./simulations",
    "defaultTrace": "off",
    "reportsDirectory": ".govplane/reports",
    "redactContextFields": ["email", "ssn", "token"],
    "validateContext": false,
    "parseCustomEffect": false,
    "contextPolicy": { "allowedKeys": ["failedAttempts", "plan", "country"] }
  }
}
```

### Context validation

`validateContext` is **off** by default. The runtime ships a short sample
allow-list as its default context policy; enforcing it here would reject the
very keys a bundle's own rules read, and correct input would fail.

Pin `contextPolicy.allowedKeys` to your application's real policy and set
`validateContext: true` when you want simulation to reproduce the constraints
production actually enforces.

## JSON output

```json
{
  "success": true,
  "input": { "documentType": "bundle", "documentPath": "/project/policy-bundle.json" },
  "signature": { "status": "valid", "algorithm": "HMAC_SHA256", "keyId": "local-key-01" },
  "scenarios": [
    {
      "name": "Simulation",
      "target": { "service": "auth", "resource": "login", "action": "authenticate" },
      "result": {
        "decision": "deny",
        "reason": "rule",
        "policyKey": "login-protection",
        "ruleId": "deny-after-five"
      },
      "expectation": { "defined": false, "passed": true }
    }
  ],
  "summary": { "total": 1, "asserted": 0, "passed": 1, "failed": 0, "durationMs": 2 }
}
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Every scenario ran, and every expectation held |
| `1` | At least one expectation failed |
| `2` | Bundle, draft, scenario file or working-folder error |
| `3` | Invalid arguments — no target, or conflicting ways of giving one |
| `4` | Bundle validation failed, a scenario was malformed, or the signature was invalid or missing |
| `6` | The runtime engine could not evaluate a target, or the report could not be written |
| `7` | Not activated and the grace period has ended |

Every failure prints its stable error code as the last line, so CI can match on
something that will not change when the wording improves.

## Where this sits

```text
policies  →  policy-drafts.json
                    ↓  (compiled in memory)
              simulate  ←────────────────┐
                    ↓                    │
build     →  policy-bundle.json  ────────┘
                    ↓
sign      →  policy-bundle.json (signed)  →  SDK
```

```bash
govplane policies add-rule --policy-key login-protection --rule-file ./deny-retries.json
govplane simulate --draft ./policy-drafts.json --suite ./simulations/auth-suite.json
govplane build --signed
govplane simulate --suite ./simulations/auth-suite.json --report
```

Simulating the draft catches a mistake before it is built; simulating the signed
bundle proves the artifact you are about to ship behaves as intended.
