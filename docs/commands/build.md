# `govplane build`

Compiles local policy drafts into a deterministic, validated runtime bundle —
the artifact the Govplane SDK evaluates.

```bash
govplane build [options]
```

Local files only. Build never reads policies from Govplane, and never contacts
it.

## The short version

```bash
govplane build
```

```text
Govplane Build

Input:
  Draft: policy-drafts.json

Output:
  Bundle: policy-bundle.json
  Schema: 1
  Env: prod
  Bundle version: 1

Integrity:
  Checksum: sha256:2f7d…
  ETag: "2f7d…"

Signature:
  Enabled: no

Result:
  Build completed successfully
```

## The pipeline

1. Resolve and load the draft.
2. Check it is complete enough to build.
3. Map draft policies to their runtime shape.
4. Compile with deterministic ordering.
5. Validate the result against the runtime bundle rules.
6. Build the canonical projection.
7. Compute the checksum and ETag.
8. Resolve `bundleVersion`.
9. Sign, when `--signed`.
10. Write the bundle.

Nothing is written until every step before it has passed, so a failed build
never leaves a half-made bundle behind.

## Input

| Order | Source |
| ----- | ------ |
| 1 | `--draft <path>` (relative to the working folder) |
| 2 | `draft.path` in `govplane.config.json` |
| 3 | `policy-drafts.json` in the working folder |

Both draft shapes work: the build-ready documents `govplane policies` writes,
and the `drafts[]` documents `govplane analyze` produces, which are normalised
before compilation.

## Output

| Order | Source |
| ----- | ------ |
| 1 | `--output <path>` |
| 2 | `bundle.path` from the configuration, inside `build.outputDirectory` when one is set |
| 3 | `policy-bundle.json` in the working folder |

**An existing bundle is never overwritten.** If the target path is taken, build
writes a timestamped file beside it and reports both paths:

```text
Output:
  Bundle: policy-bundle.2026-07-30T15-22-31Z.json
  Requested: policy-bundle.json
  The requested file already existed and was left untouched.
```

A bundle may already be deployed, signed, or pinned by checksum somewhere.
Writing beside it is recoverable; overwriting it is not.

## Determinism

The same draft always compiles to the same canonical bytes, and therefore the
same checksum:

- Policies are sorted by `policyKey`, ascending.
- Rules are sorted by `priority` descending, then `id` ascending.
- `generatedAt` and `bundleVersion` sit outside the canonical projection, so a
  rebuild of unchanged policies produces an identical checksum.

That last point is what makes the checksum useful: it identifies the *policy
content*, not the moment you happened to run the command.

### What the runtime sees

Compilation keeps only runtime-relevant fields. Authoring metadata — a friendly
name, a description, the target `analyze` discovered — is dropped rather than
carried into the signed payload.

Every rule is written with an explicit `status`, defaulting to `active`. This
matters more than it looks: the runtime engine evaluates a rule **only** when
its status is exactly `"active"`, so a rule compiled without one would silently
never fire.

## Scope

`orgId` and `projectId` are optional for a local build and omitted entirely when
not supplied:

```bash
govplane build --org-id org_1 --project-id proj_1
```

Without them the build succeeds with a warning, because a bundle with no scope
cannot be used in Isolated Mode, which checks it. Note that `govplane validate`
uses the cloud-compatible profile and will report the missing scope as an
**error** — set both when the bundle is destined for a real deployment.

`env` defaults to the draft's environment, then to `prod`.

## Versioning

`bundleVersion` is a **monotonically increasing revision counter**, numbered the
same way Govplane numbers materialised bundles. Keeping the two in step means a
locally built bundle stays comparable to a remotely materialised one when the
CLI is connected to Govplane Cloud.

```text
build → v1   policy-bundle.json
build → v2   policy-bundle.2026-07-31T08-27-44Z.json
build → v3   policy-bundle.2026-07-31T08-27-45Z.json
build → v4   policy-bundle.2026-07-31T08-27-47Z.json
```

### Per scope

The counter runs per scope — the combination of `orgId`, `projectId` and `env` —
exactly as the control plane does. Bundles for different scopes keep independent
sequences:

```bash
govplane build --env prod      # v1, v2, v3 …
govplane build --env staging   # v1, v2 …   its own sequence
```

### How the next version is found

Build reads every bundle in the **output family** — the requested path plus the
timestamped files written beside it — takes the highest `bundleVersion` among
those whose scope matches, and adds one.

The family matters: because build never overwrites, the requested path holds v1
forever and the newest revision is a timestamped sibling. Reading only the
requested path would hand out version 2 on every build after the first.

Neighbours that cannot be read, are not valid JSON, or carry no usable version
are skipped rather than treated as errors.

### The version does not affect the checksum

`bundleVersion` sits outside the canonical projection, so incrementing it leaves
the checksum untouched. Rebuilding unchanged policies gives a new version number
and an identical checksum — which is what makes the checksum a statement about
policy content rather than about when you ran the command.

## Signing

Off unless asked for. `--signed` signs the **same canonical bytes the checksum
covers**, so anything that can verify one can verify the other.

```bash
# HMAC — a shared 256-bit secret, as 64 hex characters
govplane build --signed --hmac-secret-env GOVPLANE_HMAC_SECRET

# ECDSA — a local P-256 private key
govplane build --signed \
  --signing-algorithm ECDSA_SHA_256 \
  --ecdsa-private-key ./keys/signing-private.pem \
  --signing-key-id local-ec-01
```

| Algorithm | Key | Signature |
| --------- | --- | --------- |
| `HMAC_SHA256` | 64 hex characters (256-bit) | lowercase hex |
| `ECDSA_SHA_256` | unencrypted EC private key, PEM | base64 DER |

Secret precedence: `--hmac-secret`, then `--hmac-secret-env`, then
`build.signing.hmacSecretEnv`. **Prefer the environment forms** — a secret passed
as `--hmac-secret` lands in your shell history and in the process list.

The signature is embedded inline:

```json
{
  "signature": {
    "algorithm": "ECDSA_SHA_256",
    "keyId": "local-ec-01",
    "value": "MEUCIG…"
  }
}
```

Verify it with the basic CLI:

```bash
govplane inspect ./policy-bundle.json --signature --public-key ./keys/signing-public.pem
```

### Key material never appears in output

No secret, private key, or fragment of either is ever printed — including with
`--verbose`. Errors name the *source* of a key, never its contents:

```text
Error: Signing failed for key source GOVPLANE_HMAC_SECRET.

Reason: invalid hex length (expected 64 hexadecimal characters, got 6).
```

A build that cannot sign fails and writes nothing. Signing is never skipped
silently.

## Reports

```bash
govplane build --report
govplane build --report-path ./reports/build.json
```

Default location: `.govplane/reports/build-<timestamp>.json`. The report records
the CLI version, timestamps, input and output paths, counts, validation summary,
checksum, ETag, `bundleVersion` and signing status — never key material.

> The specification writes this as `--report [path]`. It is split into a boolean
> `--report` and `--report-path <path>` so that a bare `--report` can never
> swallow the next argument.

## Warnings

Warnings do not fail a build. `--strict` treats them as requiring attention and
exits `1`, with the bundle still written — the build succeeded, the warnings are
advisory. That is the setting for CI.

Common ones: missing scope, a policy with no rules, a broad `*` resource, an
unsigned bundle.

## Options

```text
--draft <path>                   Draft file to compile
--output <path>                  Where to write the bundle
--env <prod|staging|dev|test>    Environment recorded in the bundle
--org-id <value>                 Organisation the bundle belongs to
--project-id <value>             Project the bundle belongs to
--signed                         Sign the bundle
--signing-algorithm <algorithm>  HMAC_SHA256 or ECDSA_SHA_256
--signing-key-id <value>         Key identifier recorded in the signature
--hmac-secret <hex>              HMAC secret (prefer --hmac-secret-env)
--hmac-secret-env <var>          Environment variable holding the HMAC secret
--ecdsa-private-key <path>       ECDSA private key, PEM
--report                         Write a build report
--report-path <path>             Where to write the build report
--strict                         Treat warnings as requiring attention
--format <text|json>             Output format
--quiet                          Suppress non-essential output
--verbose                        Show resolved paths and pipeline stages
-w, --working-folder <path>      Working folder
--config <path>                  Configuration file
-h, --help                       Command help
```

## Configuration

```json
{
  "draft": { "path": "policy-drafts.json" },
  "bundle": { "path": "policy-bundle.json" },
  "build": {
    "env": "prod",
    "outputDirectory": "dist",
    "signed": false,
    "validateParity": true,
    "bundleVersionStrategy": "increment",
    "scope": { "orgId": null, "projectId": null },
    "signing": {
      "algorithm": "HMAC_SHA256",
      "keyId": "local-key-01",
      "hmacSecretEnv": "GOVPLANE_HMAC_SECRET",
      "ecdsaPrivateKeyPath": "./keys/signing-private.pem"
    }
  }
}
```

`validateParity: false` skips the post-compilation validation. It exists for
debugging; leaving it on is strongly recommended, since it is what keeps a local
bundle acceptable to the runtime.

## JSON output

```bash
govplane build --format json --quiet
```

```json
{
  "success": true,
  "input": { "draftPath": "/project/policy-drafts.json" },
  "output": {
    "requestedPath": "/project/policy-bundle.json",
    "bundlePath": "/project/policy-bundle.2026-07-30T15-22-31Z.json",
    "schemaVersion": 1,
    "env": "prod",
    "bundleVersion": 7,
    "checksum": "sha256:2f7d…",
    "etag": "\"2f7d…\"",
    "signed": true,
    "signatureAlgorithm": "ECDSA_SHA_256",
    "signatureKeyId": "local-key-01"
  },
  "warnings": [],
  "stats": { "policies": 12, "rules": 34 }
}
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Build completed |
| `1` | Completed, but `--strict` and warnings were present |
| `2` | Draft file or working-folder error |
| `3` | Invalid CLI arguments |
| `4` | Draft or runtime validation failed |
| `5` | Signing failed |
| `6` | The bundle or report could not be written |
| `7` | Not activated and the grace period has ended |

## Where this sits

```text
analyze  →  policies  →  build  →  simulate
                          ↓
                    policy-bundle.json  →  SDK
```

```bash
govplane policies validate
govplane build --signed --hmac-secret-env GOVPLANE_HMAC_SECRET
govplane inspect ./policy-bundle.json --policies
```
