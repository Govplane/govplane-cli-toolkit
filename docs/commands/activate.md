# `govplane activate`

Activates the Govplane CLI Toolkit on this machine. Activation is free, needs
about 30 seconds, and an email address only if you want to give one.

```bash
govplane activate [options]
```

## The normal path

```bash
govplane activate
```

```text
Activation is free and takes about 30 seconds. An email address is optional.

Your browser should open. If it does not, open this page and enter the code:

  https://govplane.com/activate

  Code:  GOVP-7K2Q-8XPD

Waiting for confirmation... (expires in 10 minutes)

✓ Activated for dev@*******

  Licence:       /Users/example/.govplane/license.json
  Terms:         2026-07-01
  Product news:  not subscribed

This machine will not contact Govplane again.
```

In the browser you accept the terms, and may supply an email address, verify it, and
choose whether to receive product news. That last choice is optional and off by
default — declining it produces exactly the same licence.

The command polls until you finish, you decline, or the request expires after ten
minutes. `Ctrl-C` is safe at any point and leaves nothing behind.

## Headless and remote machines

```bash
govplane activate --no-browser
```

Prints the URL and code without trying to launch anything, so you can confirm
from your phone or another machine. Launching a browser is best-effort anyway: if
it fails, the URL is already on screen and activation continues.

## Air-gapped machines

```bash
govplane activate --license ./govplane.license
```

Imports a licence issued elsewhere. No network access is attempted, and
verification is identical to the online path. Licences are not machine-bound, so
one licence covers every machine you own.

## Re-activating

Running `activate` on an already-activated machine does nothing and makes no
network request:

```text
This machine is already activated for dev@*******.

Re-run with --force to activate again.
```

Activated without an email address, both lines omit the subject — `✓ Activated`
and `This machine is already activated.`

```bash
govplane activate --force
```

## What gets sent

Exactly this, and only while the command is running:

```json
{ "client": "govplane-toolkit", "clientVersion": "1.1.1" }
```

No hostname, no username, no paths, no project or policy contents, no machine
identifier. See [privacy](../privacy.md).

## Options

```text
--no-browser              Do not try to open a browser
--license <path>          Import a licence file instead of activating online
--force                   Activate again even if already activated
--format <text|json>      Output format
--quiet                   Suppress non-essential output
--verbose                 Show the activation service URL and polling detail
-h, --help                Command help
```

`--verbose` prints the effective service URL, which is useful when
`GOVPLANE_API_URL` points somewhere other than production.

## JSON output

```bash
govplane activate --format json
```

```json
{
  "success": true,
  "licenseId": "lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD",
  "email": "dev@example.com",
  "plan": "toolkit-free",
  "issuedAt": "2026-07-29T12:00:00.000Z",
  "terms": { "version": "2026-07-01", "acceptedAt": "2026-07-29T11:59:58.000Z" },
  "marketingConsent": false,
  "licensePath": "/Users/example/.govplane/license.json"
}
```

Activated without an email address, the `email` key is **absent** rather than
`null`, so a script can test for the key:

```json
{
  "success": true,
  "licenseId": "lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD",
  "plan": "toolkit-free",
  "issuedAt": "2026-07-29T12:00:00.000Z",
  "terms": { "version": "2026-08-15", "acceptedAt": "2026-07-29T11:59:58.000Z" },
  "marketingConsent": false,
  "licensePath": "/Users/example/.govplane/license.json"
}
```

The signature is never included in output, in any format.

## Environment

| Variable | Purpose |
| -------- | ------- |
| `GOVPLANE_HOME` | Where the licence is stored (default `~/.govplane`) |
| `GOVPLANE_API_URL` | Activation service base URL, for staging or local development |
| `GOVPLANE_LICENSE` | An inline licence, used instead of activating |
| `GOVPLANE_LICENSE_FILE` | Path to a licence, used instead of activating |

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Activated, or already activated |
| `1` | Declined, expired, or the service could not be reached |
| `2` | The licence file could not be read or written |
| `3` | Invalid CLI arguments |
| `4` | The licence failed verification, or is unsupported |
| `5` | Unexpected internal error |

A failure never leaves a partial licence on disk: the file is written only after
the signature verifies.
