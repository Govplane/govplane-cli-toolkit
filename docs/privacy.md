# Privacy

The toolkit collects one item of personal data — an email address — and it is
collected in your browser, not by the CLI.

This document states exactly what happens, because "free tool that asks for your
email" deserves to be specific rather than reassuring.

## What is transmitted

The toolkit makes **two** HTTP requests in its entire lifetime, both while
`govplane activate` is running.

Starting activation:

```json
POST /v1/activation/device/start
{ "client": "govplane-toolkit", "clientVersion": "1.0.0" }
```

Polling for your confirmation:

```json
POST /v1/activation/device/poll
{ "deviceCode": "<opaque>" }
```

That is the complete list. You can verify it: the only network code in this
package is [`src/http/client.ts`](../src/http/client.ts), called only from
[`src/activation/deviceFlow.ts`](../src/activation/deviceFlow.ts).

## What is never transmitted

- Your hostname, username or home directory
- File paths, project names or repository details
- Policy contents, drafts, bundles or simulation data
- Any machine, hardware or installation identifier
- Any usage, timing or command-frequency data

There is no telemetry, no crash reporting, no analytics, and no heartbeat. There
is no fingerprinting, and the
[activation spec](../../../specs/cli-toolkit/cli_toolkit_activation_spec.md)
forbids introducing any.

## After activation: nothing

Once a licence is stored, the toolkit performs **no** network requests at all. It
does not check whether the licence is still valid, because verification is a
local signature check. Every command works with the network unplugged, and that
property is tested.

## Your email address

Collected on the activation page, and stored in the licence on your machine:

```text
~/.govplane/license.json      mode 0600 (owner read/write only)
```

`govplane license` shows it. `govplane license remove` deletes the local copy.

Because the licence is signed, the email address inside it cannot be changed
without invalidating it — which also means the licence is a small piece of
personal data. Treat it accordingly: use a secret store in CI, and prefer
`GOVPLANE_LICENSE_FILE` over committing it anywhere.

## Consent

- **Terms of service** — required to activate, recorded with its version and the
  moment you accepted it.
- **Product news** — optional, unticked by default, and **declining it activates
  you exactly the same**.

The second point is not a courtesy. Consent that is a condition of getting the
service is not valid consent, so marketing consent is never bundled with
activation. If you ever see a Govplane flow that requires it to activate, that is
a bug worth reporting.

## Your rights

| What you want | How |
| ------------- | --- |
| See what is stored locally | `govplane license` |
| Delete the local copy | `govplane license remove` |
| Withdraw marketing consent | https://govplane.com/account |
| Export your data | https://govplane.com/account |
| Delete your account | https://govplane.com/account |

`govplane license` prints that URL, so the path to withdrawing consent is always
one command away.

## Verbose output

`--verbose` adds diagnostics — the resolved service URL, polling detail, resolved
paths. It never prints the licence signature, and the basic CLI rule that verbose
output never exposes licence keys or OTP values applies here too.

## Offline and air-gapped use

If you would rather no request left your machine at all, activate on a different
machine and import the licence:

```bash
govplane activate --license ./govplane.license
```

And if you would rather not activate at all: the Govplane SDK,
`govplane validate` and `govplane inspect` never require activation, and bundles
can be written and signed by hand. That path is supported indefinitely — it is
the point of the project.
