# Architecture

The CLI Toolkit is not a second CLI. It is a package of commands that the
existing `govplane` executable picks up, so parsing, help, output formats and
exit codes stay identical whichever executable was invoked.

```text
@govplane/cli                       @govplane/toolkit
─────────────                       ─────────────────
bin/govplane.js
  └── main()
        └── loadToolkitCommands() ───► src/index.ts  →  commands
              (dynamic import)              ├── activate
                                            └── license
        └── run(argv, { extraCommands })
              └── mergeCommands(basic, kit)
                    · a kit command replaces the built-in placeholder
                      of the same name (`build`, `sign`, …)
                    · new commands (`activate`) are appended
```

## How discovery works

`@govplane/cli` resolves `@govplane/toolkit` **by name at runtime**, holding the
specifier in a variable so nothing is statically linked. Three consequences, all
intended:

- The basic CLI has **no dependency** on the toolkit. Advanced tooling is not
  dragged into every install.
- A missing toolkit is a normal, silent outcome — the basic CLI behaves exactly
  as it did before.
- A broken or mismatched toolkit degrades to the basic CLI rather than crashing
  it: exports that do not look like commands are ignored, not trusted.

The reverse direction is a normal dependency: the toolkit imports
`@govplane/cli` for the reporter, working-folder resolution, canonicalisation,
signature verification and file helpers. Nothing is reimplemented.

Resolution works because Node walks up from the CLI's own location: in a global
install (`npm i -g @govplane/cli @govplane/toolkit`) and in a project-local
install, both packages sit in the same `node_modules`, so the walk finds the kit.

`bin/govplane-toolkit.js` exists for the case that walk cannot cover — a
symlinked checkout, as created by `npm link`, where Node resolves from the real
path and never sees the sibling. It calls the same `run()`, so behaviour is
identical.

## Layout

```text
bin/govplane-toolkit.js        Direct launcher (Node version guard, EPIPE handling)
src/toolkit.ts                run() — the CLI with kit commands registered
src/index.ts                  Public API; `commands` is the contract with the CLI
src/commands/                 activate, license, and the registry
src/activation/
  types.ts                    Licence and activation-state model
  license.ts                  Read, verify, store, remove; resolution order
  keys.ts                     Public keys by keyId, with an env override
  grace.ts                    Grace anchor, elapsed days, state resolution
  guard.ts                    requireActivation() — the single gate
  deviceFlow.ts               Device start, polling, back-off, browser launch
  messages.ts                 User-facing copy, in one place
src/http/client.ts            The only network code in the package
keys/                         Shipped public keys (never private material)
scripts/stub-activation-server.mjs   Local stand-in for the activation service
```

## Design decisions

**One gate, applied everywhere.** `requireActivation()` resolves the state,
prints the reminder at the right volume, and throws only when the grace period has
run out. Every gated command calls it and nothing else, so activation behaviour
cannot drift between commands.

**Time is injected.** Nothing in `activation/` calls `new Date()`. The clock
arrives on `CommandContext.now`, which is what makes day-0, day-24 and day-31
behaviour testable at all — and it means a command's output cannot silently depend
on the wall clock.

**The transport is injectable.** `postJson` takes a `fetchImpl`, so every
device-flow state — pending, `slow_down`, denied, expired, unreachable, malformed
— is exercised deterministically with no server and no waiting.

**Copy lives in `messages.ts`.** Reminder text is reviewed as prose rather than
scattered through control flow. It also keeps the reassurance in the day-31
message (`your policies keep working`) from being lost in a refactor.

**Verification reuses the CLI's crypto.** `inspectSignature` from
`@govplane/cli`, with `canonicalDocument` as the canonicaliser. The licence and
bundle canonicalisations differ on purpose, and both live next to each other in
`@govplane/cli`'s `canonical.ts` with the reason written down.

**Failure is never a dead end.** An unusable licence is treated as absent, and a
key this build does not know asks for an update rather than crying tamper. A user
should always be able to see a way forward.

## Adding a CLI Toolkit command

The five remaining commands (`policies`, `build`, `sign`, `simulate`, `analyze`)
follow the same shape:

1. Create `src/commands/<name>.ts` exporting a `CommandDefinition`, reusing
   `commonOptions` and `formatOption` from `@govplane/cli`.
2. Call `requireActivation(context, '<name>')` **before any work**, and attach
   `activationSummary(status)` to structured output.
3. Set `requiresToolkit: true`, so the command replaces the CLI's placeholder.
4. Add it to `src/commands/registry.ts`.
5. Test it with the sandbox harness in `test/helpers/harness.ts`, including its
   behaviour at day 31.
6. Document it in `docs/commands/` and link it from `docs/README.md`.

## Testing

- `test/activation/` — unit tests for the licence, grace arithmetic, guard
  volume and every device-flow state.
- `test/commands/` — end-to-end runs through `run()` with in-memory streams, an
  isolated `GOVPLANE_HOME`, a per-test signing key and a scripted service.
- `scripts/stub-activation-server.mjs` — the manual walkthrough, including
  declining marketing consent and confirming a licence is still issued.

No test touches the developer's real profile, launches a browser, waits on a
timer, or reaches the network.
