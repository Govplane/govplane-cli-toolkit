# Govplane CLI Toolkit documentation

The CLI Toolkit is the free advanced toolkit. It extends the Govplane CLI with
the commands that author, build, sign and simulate policy bundles locally.

## Commands

| Document | Command | Status |
| -------- | ------- | ------ |
| [activate](commands/activate.md) | `govplane activate` | Available |
| [license](commands/license.md) | `govplane license` | Available |
| [policies](commands/policies.md) | `govplane policies` | Available |
| [build](commands/build.md) | `govplane build` | Available |
| [sign](commands/sign.md) | `govplane sign` | Available |
| [simulate](commands/simulate.md) | `govplane simulate` | Available |
| [analyze](commands/analyze.md) | `govplane analyze` | Available |

## Reference

- [Activation](activation.md) — the licence, the grace period, key rotation, and
  why the toolkit works offline once activated.
- [CI and automation](automation.md) — supplying a licence to a pipeline.
- [Privacy](privacy.md) — exactly what is transmitted, and what never is.
- [Architecture](architecture.md) — how the kit plugs into the CLI.

## The short version

```bash
npm install --global @govplane/cli @govplane/cli-toolkit
govplane activate
```

- Activation is **free** and needs only an email address.
- The email is collected in your **browser**, never by the CLI.
- Marketing consent is **optional** and declining it changes nothing.
- After activation the toolkit **never contacts Govplane again**.
- The licence **does not expire** and is **not machine-bound**.
- You may skip activation for **30 days**; after that only toolkit commands stop.
- `validate`, `inspect`, the SDK and existing bundles are **never** gated.

## Related

- [Govplane CLI documentation](https://github.com/govplane/govplane-cli/tree/main/docs)
- [Activation specification](../../../specs/cli-toolkit/cli_toolkit_activation_spec.md) — normative
