# `govplane license`

Shows and manages the licence on this machine. Everything here is local — no
command in this file makes a network request.

```bash
govplane license [verify | remove] [options]
```

## Status

```bash
govplane license
```

```text
Govplane Licence

Status:
  Activated

Email:
  dev@example.com

Licence ID:
  lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD

Plan:
  toolkit-free

Issued at:
  2026-07-29T12:00:00.000Z

Terms accepted:
  2026-07-01 (2026-07-29T11:59:58.000Z)

Product news:
  not subscribed

Signature:
  Valid (Ed25519, license-key-01)

Source:
  local licence file

Manage your account, preferences and data:
  https://govplane.com/account
```

Before activation it reports the grace period instead:

```text
Status:
  Not activated — 22 days remaining

Expected licence file:
  /Users/example/.govplane/license.json

Activation is free and needs only an email address:
  govplane activate
```

Exit code is `0` when a valid licence is present and `1` when it is not, so a
script can gate on it:

```bash
govplane license --quiet || govplane activate
```

Reporting status never creates the grace anchor, so checking whether you are
activated does not start the 30-day clock.

## `verify`

```bash
govplane license verify
```

Re-checks the signature against the canonical bytes of the licence, using a
public key shipped inside the package. Useful after copying a licence between
machines, and as a CI assertion.

```text
✓ Licence signature is valid

  Licence ID:  lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD
  Key ID:      license-key-01
```

An edited licence is rejected:

```text
Error: The licence could not be verified.

The licence signature does not match its contents. The file may have been edited.

Activate with:
  govplane activate
```

## `remove`

```bash
govplane license remove
```

Deletes the local licence file. Use it to move a machine to a different account,
or to clear your email address off a shared machine.

```text
Licence removed: /Users/example/.govplane/license.json

This removed the local copy only. To delete your account or change your
communication preferences:
  https://govplane.com/account
```

It is deliberately explicit that this is a local action: removing a file cannot
delete an account, and pretending otherwise would be misleading.

## Options

```text
--format <text|json>      Output format
--quiet                   Suppress non-essential output
--verbose                 Show additional detail
-h, --help                Command help
```

## JSON output

Activated:

```json
{
  "state": "activated",
  "licenseId": "lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD",
  "email": "dev@example.com",
  "plan": "toolkit-free",
  "issuedAt": "2026-07-29T12:00:00.000Z",
  "renewAfter": "2027-07-29T12:00:00.000Z",
  "terms": { "version": "2026-07-01", "acceptedAt": "2026-07-29T11:59:58.000Z" },
  "marketingConsent": false,
  "signature": { "algorithm": "Ed25519", "keyId": "license-key-01", "valid": true },
  "renewalDue": false,
  "source": "file"
}
```

Not activated:

```json
{
  "state": "grace",
  "daysRemaining": 22,
  "licensePath": "/Users/example/.govplane/license.json"
}
```

`source` is `environment`, `environment-file` or `file`. `state` is `activated`,
`grace` or `grace_expired`.

**`signature.value` is never present in any output.** The licence contains
personal data, and there is no reason for a terminal or a log to carry the
signature blob.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Status reported, licence verified, or licence removed |
| `1` | No usable licence, or verification failed |
| `2` | The licence file could not be read or written |
| `3` | Invalid CLI arguments or unknown subcommand |
| `5` | Unexpected internal error |
