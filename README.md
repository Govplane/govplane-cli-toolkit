# Govplane CLI Toolkit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Govplane CLI Toolkit is the free advanced set of tools for [Govplane](https://govplane.com). It extends the [Govplane CLI](https://github.com/govplane/govplane-cli) with the
commands that author, build, sign and simulate policy bundles on your own
machine.

```bash
npm install --global @govplane/cli @govplane/cli-toolkit
govplane activate      # free, one-time, no email required
```

The kit is **free**. Activation asks you to accept the terms and nothing else —
an email address is optional — and once activated, **the toolkit never contacts
Govplane again**.

---

## Table of contents

- [What this adds](#what-this-adds)
- [Installation](#installation)
- [Activation](#activation)
- [Continuous integration](#continuous-integration)
- [Air-gapped machines](#air-gapped-machines)
- [The 30-day grace period](#the-30-day-grace-period)
- [What is sent, and what is not](#what-is-sent-and-what-is-not)
- [Commands](#commands)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## What this adds

| Command | Purpose | Status |
| ------- | ------- | ------ |
| `activate` | Activate this machine (free) | ✅ Available |
| `license` | Show, verify or remove the licence | ✅ Available |
| `policies` | Manage local policy drafts | ✅ Available |
| `build` | Build a policy bundle from drafts | ✅ Available |
| `sign` | Sign a policy bundle | ✅ Available |
| `simulate` | Simulate policy evaluations locally | ✅ Available |
| `analyze` | Find policy evaluation points in source | ✅ Available |

Installing the toolkit is all it takes: the `govplane` executable discovers it
and the new commands appear in `govplane help`.

**What the toolkit is not.** It is never required to *run* policies. The
Govplane SDK, which is a separate package, evaluates policies from a signed bundle. 

The toolkit is productivity tooling, and everything it produces stays yours.

## Installation

```bash
npm install --global @govplane/cli @govplane/cli-toolkit
```

Or, from the CLI:

```bash
govplane --install-kit
```

**Requirements:** Node.js 20 or later.

## Activation

```bash
govplane activate
```

```text
Activation is free and takes about 30 seconds. An email address is optional.

Open this page and enter the code:

  https://govplane.com/activate

  Code:  GOVP-7K2Q-8XPD

Waiting for confirmation... (expires in 10 minutes)

✓ Activated for dev@*******

  Licence:       /Users/example/.govplane/license.json
  Terms:         2026-07-01
  Product news:  not subscribed

This machine will not contact Govplane again.
```

You enter the code in your browser and accept the terms. You may also give an
email address — verifying it and choosing whether you want product news — or
choose **Continue without an email address**, which activates you immediately.

Both produce a fully valid licence. Without an email the confirmation is simply
`✓ Activated`, the licence carries no subject, and **no personal data is
collected at all**. The marketing choice is optional and unticked by default;
declining it activates you exactly the same, and it is not offered when there is
no address to send to.

The CLI itself never asks for your email address, so nothing personal ends up in
your shell history or your CI logs.

On a headless or remote machine:

```bash
govplane activate --no-browser
```

Check the result at any time:

```bash
govplane license          # status, email, terms, source
govplane license verify   # re-verify the signature locally
govplane license remove   # delete the local licence
```

## Continuous integration

CI never activates interactively. Activate once as a human, then give the
pipeline the licence:

```yaml
env:
  GOVPLANE_LICENSE: ${{ secrets.GOVPLANE_LICENSE }}   # contents of license.json
```

Or point at a file:

```bash
export GOVPLANE_LICENSE_FILE=/etc/govplane/license.json
```

The licence is not machine-bound, so one licence covers every machine you own.
It is not a secret in the credential sense — it cannot be used to access
anything. If you gave an email address it contains one, so treat it as personal
data and use your CI secret store. A licence activated without an email contains
no personal data at all, which makes it the simpler thing to put in a pipeline.

## Air-gapped machines

A machine with no outbound network is activated by importing a licence issued
elsewhere:

```bash
# on a machine with a browser
govplane activate
cp ~/.govplane/license.json ./govplane.license

# on the air-gapped machine
govplane activate --license ./govplane.license
```

Verification is identical: the signature is checked locally against a public key
shipped inside this package.

## The 30-day grace period

The toolkit works for **30 days** before activation is required. The clock starts
the first time you run a toolkit command, not when you install it.

| Days | What happens |
| ---- | ------------ |
| 1–23 | Commands run. One-line reminder. |
| 24–30 | Commands run. Short notice with the days remaining. |
| 31+ | Toolkit commands stop and explain how to activate. |

When the grace period ends, **only the toolkit commands stop**. `validate`,
`inspect`, `version`, `help`, `working-folder`, the SDK, and every bundle you
have already built keep working exactly as before. Nothing in production is
affected, ever.

In CI the reminder appears from the first run rather than staying quiet for a
month, so a pipeline is never surprised by a failure on day 31.

`--quiet` silences reminders. With `--format json` the state travels as data
instead of prose:

```json
{ "activation": { "state": "grace", "daysRemaining": 22 } }
```

## What is sent, and what is not

Activation makes exactly two HTTP requests, and only while `govplane activate`
is running.

**Sent:** the client name and version.

```json
{ "client": "govplane-toolkit", "clientVersion": "1.1.1" }
```

**Not sent, ever:** your hostname, username, file paths, project contents,
policy contents, machine identifiers, or any usage data. There is no telemetry,
no heartbeat, no licence check, and no fingerprinting — by design, and the
[activation spec](../../specs/cli-toolkit/cli_toolkit_activation_spec.md)
forbids adding any.

If you gave an email address it is collected in the browser, by the activation
page, and stored in the licence file on your machine at mode `0600`. If you did
not, the licence contains no personal data and there is nothing to protect. `govplane license`
links to the dashboard for withdrawing consent, exporting your data or deleting
your account. `govplane license remove` deletes the local copy.

## Commands

Full reference: [`docs/`](docs).

- [`activate`](docs/commands/activate.md)
- [`license`](docs/commands/license.md)
- [`policies`](docs/commands/policies.md)
- [`build`](docs/commands/build.md)
- [`sign`](docs/commands/sign.md)
- [`simulate`](docs/commands/simulate.md)
- [`analyze`](docs/commands/analyze.md)
- [Activation model](docs/activation.md) — the licence, the grace period, and
  why it works offline
- [CI and automation](docs/automation.md)
- [Privacy](docs/privacy.md)

## Development

```bash
npm install
npm run build          # compile TypeScript to dist/
npm test               # run the test suite
npm run test:coverage  # run tests with coverage thresholds
npm run lint           # Airbnb style checks
npm run typecheck      # type-check sources and tests
```

Run the whole activation flow locally, with no Govplane service involved:

```bash
npm run stub-server
# follow the printed instructions in a second terminal
```

The stub generates its own signing key per run and keeps it in memory, so no
private key material ever touches the repository.

> While `@govplane/cli` is unpublished, this package resolves it from the
> sibling working copy (`file:../../CLI/govplane-cli` in `package.json`). That
> becomes a normal semver range once the CLI is on npm.

Architecture and design notes: [`docs/architecture.md`](docs/architecture.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Platformstack Technologies OÜ. and contributors. See [NOTICE.md](NOTICE.md) for third-party notices.
