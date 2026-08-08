# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-08

### Security

- `resolveApiUrl` no longer trims trailing slashes with `replace(/\/+$/, '')`.
  That pattern backtracks quadratically: a `GOVPLANE_API_URL` of many slashes
  followed by any other character cost O(n²) — 40 000 slashes took over half a
  second. Replaced with a single reverse scan, which is linear and returns the
  same string for every input. Reported by CodeQL as a polynomial regular
  expression on uncontrolled data.
- The local stub activation service (`scripts/stub-activation-server.mjs`, a
  development-only script that is not part of the published package) escaped
  neither of the two request-derived values it interpolated into its
  confirmation page. The activation code lands inside a quoted attribute, so
  `?code=" onfocus=… autofocus="` broke out of it and ran script. Both values
  are now HTML-escaped, and the code is additionally narrowed to the alphabet a
  real code uses. Reported by CodeQL as reflected cross-site scripting.

## [1.0.0] - 2026-08-05

### Added

- `govplane analyze` — discovers Govplane policy evaluation points in an
  application's source code and writes reviewable policy drafts.
  - Real parsing rather than pattern matching: a purpose-built JavaScript and
    TypeScript tokenizer and expression parser, so an `evaluate(` inside a
    comment or a string is not reported, and an argument containing nested
    braces, arrow functions or template literals is read correctly. Written in
    the toolkit rather than taken as a dependency, which keeps the package's
    runtime dependencies at two.
  - Calls are recognised by **binding** (the receiver traces back to a Govplane
    import, through aliases, `require` and factory calls) or by **shape** (a
    recognisable `target` at the call site). Shape finds the client that arrived
    through dependency injection or a module the analyzer cannot follow,
    whatever the variable is called.
  - Dynamic target values are preserved verbatim alongside their fallback rather
    than reduced to it, with `high` / `medium` / `low` confidence recording how
    much of each target could be resolved.
  - Context keys recorded with the expression they came from. A type is stated
    only where the language guarantees it — a literal, a template, `Number(x)` —
    never inferred from a name.
  - Calls consolidated by `service + resource + action`, aggregating every
    context key and source location. Fully ordered output, so re-running over
    unchanged source produces a byte-identical draft.
  - Comparison against existing bundles as `covered`, `partially-covered`,
    `missing` or `ambiguous`, using the same deterministic ordering as remote
    bundle compilation. Every `--bundle` must first pass the same structural
    validation the remote path enforces, and nothing is analysed if one fails.
  - `--check` for CI: non-zero when uncovered drafts exist, and writes nothing.
  - `--interactive` review: accept, ignore, rename, merge, review context, quit.
  - An existing draft is never overwritten silently — confirmed in a terminal,
    or `--merge` / `--force` outside one, with a warning when the file has
    uncommitted changes. Merging appends only unknown targets, never rewrites an
    edited entry, and keeps the shape the file already had.
  - Never writes a rule, condition, effect or priority. Every generated policy
    is a shell with `"rules": []`.

- `govplane simulate` — evaluates targets and contexts against a bundle or draft
  locally, before anything ships.
  - Runs the published `@govplane/runtime-sdk` engine rather than reimplementing
    evaluation. Effect precedence, priority ordering, tie-breaking and the
    deny-by-default fallback all belong to the engine, so a simulated decision
    is the decision an application would get.
  - Simulates a draft by compiling it in memory, so authoring changes can be
    checked without building first. Nothing is written to disk.
  - Scenario and suite files with optional expectations on `decision`, `reason`,
    `policyKey`, `ruleId` and `value`. Only declared fields are checked, so a
    scenario asserting a decision does not break when a rule is renamed. A
    failed expectation exits `1`, making a suite a CI gate on its own.
  - Verifies the bundle signature before evaluating, when the project pins key
    material; an invalid or missing signature stops the run, and
    `--skip-signature-verification` warns loudly on stderr every time.
  - Trace levels `off`, `errors`, `sampled` and `full`, with sampling forced so
    a trace the user asked for is always produced.
  - Context from inline JSON, a file, or repeated `key=value` pairs with type
    inference and explicit `key:type=value` hints. Supplying context two ways is
    refused rather than silently merged.
  - Flags context keys no rule reads — a misspelled key produces an
    inexplicable decision rather than a wrong one, which is worth saying and not
    worth failing over.
  - JSON reports recording the engine, bundle version, checksum, signature
    status and every scenario outcome, with `simulate.redactContextFields`
    masking sensitive values in console output and reports alike. Redaction
    never touches the values used for evaluation.
  - Context validation is off unless `simulate.contextPolicy` is pinned: the
    runtime's default context policy is a sample allow-list that would reject
    the very keys a bundle's own rules read.

- `govplane sign` — signs an existing unsigned runtime bundle with local key
  material, in place or to a new path.
  - The same signing engine as `build --signed`: signing the same content with
    the same key produces byte-identical signatures, which the test suite
    asserts rather than assumes.
  - Refuses a bundle that already carries a signature, with no override flag —
    replacing a signature stays an explicit decision.
  - Recomputes the checksum and ETag before signing, so a stale or missing
    checksum is repaired rather than rejected.
  - Validates the bundle and resolves the output path before any key material is
    read, and writes atomically.
  - Derives `keyId` from the key source (environment variable name, or key
    filename) when none is given; requires `--signing-key-id` for an inline
    secret rather than inventing an identifier.
  - Reads its own `sign.signing` configuration block, separate from
    `build.signing`. (`simulate` reads both when verifying: a project that
    builds signed and never runs `sign` still has key material pinned, and
    skipping verification silently is the one outcome a verifier must not
    produce.)

- `govplane build` — compiles local drafts into a deterministic, validated
  runtime bundle, using local files only.
  - Deterministic compilation: policies by key, rules by priority then id, with
    `generatedAt` and `bundleVersion` outside the canonical projection, so a
    rebuild of unchanged policies yields an identical checksum.
  - Every compiled rule carries an explicit `status`, defaulting to `active` —
    the runtime engine evaluates a rule only when its status is exactly
    `"active"`, so a rule compiled without one would silently never fire.
  - Runtime validation parity in a local-first profile, where `orgId` and
    `projectId` are optional and their absence is a warning rather than an
    error.
  - Optional signing with `HMAC_SHA256` or `ECDSA_SHA_256` over the same
    canonical bytes the checksum covers. No secret or private key ever reaches
    an output stream; errors name the key source, never its contents.
  - Never overwrites an existing bundle: writes a timestamped file beside it and
    reports both paths.
  - `bundleVersion` is a monotonically increasing revision counter kept per
    scope (`orgId`, `projectId`, `env`), mirroring how the control plane numbers
    materialised bundles. The next version comes from the highest version across
    the whole output family, so the sequence keeps climbing across builds rather
    than stalling once the requested path stops being rewritten. Incrementing it
    never changes the checksum.
  - Optional build report via `--report` / `--report-path`.

- `govplane policies` — local draft authoring, with `create-file`, `list`,
  `add-policy`, `update-policy`, `remove-policy`, `add-rule`, `update-rule` and
  `validate`. Drafts are written deterministically (policies by key, rules by
  priority then id) and atomically, and every mutation is checked against the
  draft validator before it is written.
  - Both draft shapes are accepted: build-ready documents and the `drafts[]`
    documents `govplane analyze` produces. Analyze documents are normalised for
    editing, keeping the target analyze discovered.
  - `validate` judges the file as written, so its verdict matches
    `govplane validate --type draft` on the same file.
  - Optional semantic-suffix versioning (`policy-drafts.v2.json`), configured by
    `policies.versioning.enabled` and overridable with `--versioned` /
    `--no-versioned`.
  - Guards that refuse to lose work silently: `create-file` will not overwrite,
    `remove-policy` will not discard rules, and `update-rule` will not rename a
    rule — each explains the flag that proceeds anyway.

- `govplane activate` — browser-confirmed device activation (RFC 8628 style).
  The CLI shows a short code, the browser captures the email address, versioned
  terms acceptance and an optional marketing preference, and the CLI receives a
  signed licence and verifies it locally. `--no-browser` for headless machines,
  `--license <path>` for air-gapped machines, `--force` to re-activate.
- `govplane license` — activation status, with `verify` and `remove`
  subcommands. `signature.value` is never printed in any output.
- Offline-verifiable licences: Ed25519 signature over the canonical bytes of the
  whole document, checked against public keys shipped with the package and
  selected by `keyId` so keys can be rotated without invalidating licences.
- 30-day grace period anchored on first toolkit use, escalating from a one-line
  reminder to a short notice, then to exit code `7`. Only toolkit commands are
  ever gated; `validate`, `inspect`, `version`, `help`, `working-folder`, the SDK
  and existing bundles never are.
- `requireActivation()` — the single gate the five remaining CLI Toolkit commands
  will call.
- CI support through `GOVPLANE_LICENSE` and `GOVPLANE_LICENSE_FILE`, with the
  activation notice printed from the first run in CI rather than after 30 days.
- `scripts/stub-activation-server.mjs` — a local stand-in for the activation
  service, signing with an in-memory key generated per run, so the whole flow can
  be developed and demonstrated before the production endpoints exist.
- Documentation covering activation, CI usage, privacy and architecture.

### Changed

- **The package is the CLI Toolkit, not the Runtime Kit.** Help text, command
  descriptions, messages and documentation use the new name throughout. Requires
  `@govplane/cli` 1.0.1, which renames the corresponding exports.
- **The licence email address is masked in human-readable output.** Every command
  that prints it to a terminal now shows `dev@*******` rather than the full
  address. Terminals are shoulder-surfed, screen-shared, pasted into issues and
  captured by CI log collectors; the local part is enough to confirm which
  account is active, and the domain — the part that identifies an employer or a
  client — is dropped.

  The mask is a fixed width regardless of the real domain, so its length is not
  disclosed either, and a value that is not shaped like an address is masked in
  full rather than half-printed.

  `--format json` still reports the address unmasked. That output is read by
  scripts, and `license.json` on the same machine already holds the address in
  the clear, so masking it there would cost utility without buying any privacy.
- Documentation no longer refers to "safe bundle" generation. The SDK replaced
  that concept with local bundles, verified identically whatever their source.

### Fixed

- Depends on `@govplane/runtime-sdk` 2.x, whose bundle verification finally
  matches what the CLI signs. `simulate` runs on the same refactored engine and
  its full suite passes unchanged, which is the parity evidence for the port.

- Added `test/integration/signingParity.test.ts`: signs a bundle with the CLI
  and verifies it with the SDK. The toolkit is the only package that depends on
  both, so it is where the two implementations can be proved to still agree on
  which bytes a signature covers — the divergence that made the 2.0 SDK
  necessary.

- `govplane policies` mutations no longer refuse an edit because of a problem
  that was already in the draft. Only problems the edit **introduces** block the
  write. `analyze` deliberately writes policies without `defaults` — inventing
  an effect nobody chose is not its job — and validating the whole document on
  every edit made that draft impossible to complete: repairing the first policy
  was blocked by the second still being incomplete. `policies validate` and
  `build` still judge the whole document, so nothing incomplete reaches a bundle.

### Notes

- After activation the toolkit makes **no** network requests: no licence check,
  no heartbeat, no telemetry. The free licence does not expire and is not
  machine-bound.
- `keys/license-key-01.pem` is the public half of the production licence signing
  key. Its private half is held by the activation service and never ships — see
  [`SECURITY.md`](SECURITY.md).
- Every CLI Toolkit command is now implemented; none falls back to the CLI's
  built-in placeholder.

[Unreleased]: https://github.com/govplane/govplane-toolkit/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/govplane/govplane-toolkit/compare/v1.0.0...v1.0.1
