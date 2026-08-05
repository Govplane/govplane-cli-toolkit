# `govplane policies`

Creates and edits local Govplane policy **drafts** — the authoring format that
`govplane build` compiles into a runtime bundle.

```bash
govplane policies <subcommand> [options]
```

Everything here is local file editing. No network access, and no policy leaves
your machine.

## The workflow

```bash
govplane policies create-file --env prod
govplane policies add-policy --policy-key login-protection --defaults-effect allow
govplane policies add-rule --policy-key login-protection --rule-file ./deny-retries.json
govplane policies validate
govplane policies list
```

Which fits into the wider flow as:

```text
analyze  →  policies  →  validate  →  build  →  simulate
(optional)  (authoring)              (bundle)
```

## Which file is edited

1. `--draft <path>` — relative paths resolve from the working folder
2. `draft.path` in `govplane.config.json`
3. `policy-drafts.json` in the working folder

```bash
govplane policies list --draft ./governance/policy-drafts.json
govplane policies list -w ./governance
```

Both draft shapes are accepted: the build-ready documents this command writes,
and the `drafts[]` documents `govplane analyze` produces. Analyze documents are
shown and edited in build-ready form, and the target analyze discovered is kept
rather than dropped.

## Subcommands

### `create-file`

```bash
govplane policies create-file
govplane policies create-file --env prod
govplane policies create-file --draft ./governance/drafts.json
```

Writes a valid, empty, build-ready draft. It refuses to overwrite an existing
file unless `--force` is given, or `--versioned` is used to write the next
version instead.

### `add-policy`

```bash
govplane policies add-policy --policy-key login-protection --defaults-effect allow
```

| Option | Purpose |
| ------ | ------- |
| `--policy-key` | Required. Unique within the draft. |
| `--defaults-effect` | Required. `allow`, `deny`, `kill_switch`, `throttle` or `custom`. |
| `--active-version` | Defaults to `1`. |
| `--friendly-name`, `--description` | Optional metadata. |

Effects that carry a payload need it up front, so an unusable policy is never
written:

```bash
govplane policies add-policy --policy-key payments-kill \
  --defaults-effect kill_switch --kill-switch-service payments \
  --kill-switch-reason "incident response"

govplane policies add-policy --policy-key api-throttle \
  --defaults-effect throttle --throttle-limit 60 \
  --throttle-window-seconds 60 --throttle-key ip

govplane policies add-policy --policy-key quarantine \
  --defaults-effect custom --custom-effect quarantine
```

Or supply the whole policy as JSON:

```bash
govplane policies add-policy --policy-file ./policies/login-protection.json
govplane policies add-policy --policy-json '{"policyKey":"a","defaults":{"effect":"deny"}}'
```

### `update-policy`

```bash
govplane policies update-policy --policy-key login-protection --defaults-effect deny
govplane policies update-policy --policy-key login-protection --active-version 2
```

Updates `defaults`, `activeVersion`, `friendlyName` and `description`. Rules are
left alone.

`policyKey` is immutable: it is how bundles and simulations refer to a policy,
so renaming one would quietly detach it from everything that points at it. To
rename, add the new policy and remove the old one.

### `remove-policy`

```bash
govplane policies remove-policy --policy-key login-protection
```

A policy that still has rules needs `--force`, because there is no interactive
prompt to catch a mistake:

```text
Error: "login-protection" still has 3 rule(s).

Remove it and its rules with:
  govplane policies remove-policy --policy-key login-protection --force
```

### `add-rule`

```bash
govplane policies add-rule --policy-key login-protection --rule-file ./deny-retries.json
govplane policies add-rule --policy-key login-protection --rule-json '{ … }'
```

A rule needs an `id`, a numeric `priority`, a complete `target` and an `effect`:

```json
{
  "id": "deny-after-five-failures",
  "status": "active",
  "priority": 100,
  "target": { "service": "auth", "resource": "login", "action": "authenticate" },
  "when": { "op": "gte", "path": "ctx.failedAttempts", "value": 5 },
  "effect": { "type": "deny" }
}
```

Rule ids are unique within a policy; a duplicate is rejected rather than merged.

### `update-rule`

```bash
govplane policies update-rule --policy-key login-protection \
  --rule-id deny-after-five-failures --rule-file ./deny-retries.v2.json
```

Replaces a rule wholesale. Rules are addressed by id, so the replacement must
keep the same `id` — otherwise you would think you had edited a rule that in
fact still exists untouched.

### `list`

```bash
govplane policies list
govplane policies list --verbose
govplane policies list --format json
```

```text
Govplane Policies

Draft file: policy-drafts.json

Policies: 2

KEY               ACTIVE VERSION  DEFAULT EFFECT  RULES
login-protection  1               allow           3
refund-control    1               deny            2
```

`--verbose` adds each policy's rules, with priority, target and effect.

### `validate`

```bash
govplane policies validate
govplane policies validate --draft ./policy-drafts.v3.json
govplane policies validate --strict
```

Validates the draft **as written**, so an analyze document is judged by the
analyze rules — the same verdict `govplane validate --type draft` gives the same
file. The file is never modified.

`--strict` turns warnings, such as a draft with no rules yet, into a failure.
That is the setting to use in CI.

## How drafts are written

**Deterministically.** Policies are sorted by key, and rules by priority
descending then id ascending — the order the control plane compiles bundles in.
A diff then shows what changed, not where an entry happened to land.

**Atomically.** Content is written to a temporary file, fsynced and renamed, so
an interrupted write cannot corrupt a draft you have been editing.

**Only when valid.** Every mutation is checked against the draft validator
before it is written, so a command can never leave a draft its own `validate`
would reject.

## Versioning

Off by default: mutations overwrite the same file.

```json
{ "policies": { "versioning": { "enabled": true } } }
```

With versioning on, each write creates the next semantic-suffix file and leaves
the previous one untouched:

```text
policy-drafts.json  →  policy-drafts.v2.json  →  policy-drafts.v3.json
```

Override per command in either direction:

```bash
govplane policies add-policy --policy-key a --defaults-effect allow --versioned
govplane policies add-policy --policy-key b --defaults-effect deny --no-versioned
```

The highest existing suffix always wins, so a gap in the sequence never causes
an earlier version to be overwritten.

## Options

```text
--draft <path>                    Draft file to use
--policy-key <key>                Policy to act on
--defaults-effect <effect>        allow, deny, kill_switch, throttle or custom
--active-version <number>         Active version of the policy
--friendly-name <name>            Human-readable policy name
--description <text>              Policy description
--kill-switch-service <service>   Service a kill_switch default applies to
--kill-switch-reason <text>       Reason recorded with a kill_switch default
--throttle-limit <number>         Throttle limit
--throttle-window-seconds <n>     Throttle window, in seconds
--throttle-key <key>              Context key a throttle counts against
--custom-effect <value>           Value for a custom default effect
--policy-file <path>              Policy payload as a JSON file
--policy-json <json>              Policy payload as inline JSON
--rule-id <id>                    Rule to act on
--rule-file <path>                Rule payload as a JSON file
--rule-json <json>                Rule payload as inline JSON
--env <env>                       Environment recorded in a new draft file
--versioned / --no-versioned      Write to the next versioned file, or not
--force                           Replace a file, or remove a policy with rules
--strict                          Treat validation warnings as errors
--format <text|json>              Output format
--quiet                           Suppress non-essential output
--verbose                         Show resolved paths and per-rule detail
-w, --working-folder <path>       Working folder
--config <path>                   Configuration file
-h, --help                        Command help
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success |
| `1` | The policy or rule does not exist |
| `2` | Draft file or working-folder error |
| `3` | Invalid CLI arguments |
| `4` | Draft or payload validation failed |
| `5` | Conflict — duplicate key or id, or a guard that needs `--force` |
| `6` | The draft could not be written |
| `7` | Not activated and the grace period has ended |

## JSON output

Every subcommand supports `--format json`. Mutations report what changed:

```json
{
  "success": true,
  "action": "add-policy",
  "draftFile": "/project/policy-drafts.json",
  "versioned": false,
  "policyKey": "login-protection",
  "stats": { "policies": 2, "rules": 5 }
}
```

`validate` reports the issues:

```json
{
  "success": false,
  "draftFile": "/project/policy-drafts.json",
  "errors": [
    {
      "code": "INVALID_DEFAULT_EFFECT",
      "path": "$.policies[0].defaults.effect",
      "message": "defaults.effect must be one of: allow, deny, kill_switch, throttle, custom."
    }
  ],
  "warnings": [],
  "stats": { "policies": 1, "rules": 0 }
}
```
