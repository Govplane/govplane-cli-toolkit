# Contributing to the Govplane CLI Toolkit

Thanks for taking the time to contribute. This document covers getting set up,
what we expect from a change, and the rules that activation code in particular
has to follow.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

```bash
git clone https://github.com/govplane/govplane-toolkit.git
cd govplane-toolkit
npm install
npm test
```

Requirements: Node.js 20 or later.

> While `@govplane/cli` is unpublished, `package.json` resolves it from the
> sibling working copy (`file:../../CLI/govplane-cli`). Build the CLI once
> (`npm run build` in that package) before running the toolkit, since the
> dependency points at its `dist/`. This becomes a normal semver range when the
> CLI is published.

| Script | What it does |
| ------ | ------------ |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm test` | Run the Jest suite |
| `npm run test:coverage` | Run tests and enforce coverage thresholds |
| `npm run lint` | Check the Airbnb style rules |
| `npm run typecheck` | Type-check sources and tests |
| `npm run stub-server` | Run the local stand-in for the activation service |

Trying a change by hand:

```bash
npm run build
npm run stub-server            # terminal 1
# terminal 2: follow the printed exports, then
node bin/govplane-toolkit.js activate
```

## Rules activation code must follow

These come from
[`cli_toolkit_activation_spec.md`](../../specs/cli-toolkit/cli_toolkit_activation_spec.md)
and are not negotiable in review. A change that breaks one of them will be
rejected even if it is otherwise good.

1. **Activation is never a runtime dependency.** Policy evaluation, `validate`
   and `inspect` must work with no licence, forever.
2. **No network after activation.** No heartbeat, no licence check, no renewal
   call, no telemetry. `govplane activate` is the only command that may make a
   request, and only while it runs.
3. **The CLI never collects the email address.** Personal data is captured in the
   browser, so nothing personal reaches shell history or CI logs.
4. **Marketing consent stays unbundled.** Optional, off by default, and declining
   it must still produce a licence. Consent that is a condition of service is not
   valid consent.
5. **Data minimisation.** The activation request carries the client name and
   version. Adding a field to it needs a spec change first.
6. **No enforcement theatre.** No fingerprinting, no hardware binding, no
   activation counting, no phone-home checks. The licence is free; there is
   nothing to protect.
7. **Never brick a user.** No expiry on the free licence. An unusable licence is
   reported and worked around, never a dead end.
8. **The signature value is never printed** — in any format, at any verbosity.

## Code style

- The [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript),
  enforced by ESLint. `npm run lint` must pass.
- TypeScript in `strict` mode; avoid `any`.
- Never call `new Date()` in activation code — take the clock from
  `context.now`. Grace-period behaviour has to be testable at any instant.
- Never write to `process.stdout` directly — use the reporter, so `--quiet` and
  `--format json` behave consistently.
- User-facing copy belongs in `src/activation/messages.ts`, not inline in control
  flow.
- Comments explain *why*, not *what*.

## Tests

- Jest, with at least **80% coverage** enforced in `jest.config.js`.
- Tests must not touch the developer's profile (`GOVPLANE_HOME` is redirected by
  the harness), launch a browser (inject `spawnImpl`), wait on real time (inject
  the clock), or reach the network (inject `fetchImpl` or stub global `fetch`).
- A new gated command needs a test for its day-31 behaviour, and a test that the
  basic CLI commands still work at that point.
- A bug fix should come with a regression test.

## Adding a CLI Toolkit command

See [docs/architecture.md](docs/architecture.md#adding-a-toolkit-command).
The short version: export a `CommandDefinition`, call
`requireActivation(context, '<name>')` before doing any work, set
`requiresToolkit: true`, register it, test it, document it.

## Pull requests

1. Branch from `main`, and keep the change focused.
2. Make sure `npm run lint`, `npm run typecheck` and `npm run test:coverage` pass.
3. Update `docs/` and the `README.md` when behaviour changes, and add a
   `CHANGELOG.md` entry under *Unreleased*.
4. If your change touches activation behaviour, say which of the eight rules above
   you checked it against.

## Reporting bugs

Open an issue with the command you ran, what you expected, what happened, and the
output of `govplane version --verbose`. Please redact policy contents and your
email address.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
