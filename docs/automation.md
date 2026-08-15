# CI and automation

The toolkit never runs an interactive activation. In automation you supply a
licence obtained once by a human.

## Getting a licence for CI

```bash
# once, on a machine with a browser
govplane activate
cat ~/.govplane/license.json
```

Store the contents in your CI secret store. The licence is not machine-bound, so
one licence covers every runner.

It is not a credential — it cannot be used to access anything — but it does
contain an email address if you gave one, so treat it as personal data rather than as public
configuration.

## Supplying it

Inline, which suits most CI systems:

```bash
export GOVPLANE_LICENSE='{"schemaVersion":1,...}'
```

Or from a file, which suits shared build images:

```bash
export GOVPLANE_LICENSE_FILE=/etc/govplane/license.json
```

Resolution order is `GOVPLANE_LICENSE`, then `GOVPLANE_LICENSE_FILE`, then
`$GOVPLANE_HOME/license.json`.

### GitHub Actions

```yaml
jobs:
  policies:
    runs-on: ubuntu-latest
    env:
      GOVPLANE_LICENSE: ${{ secrets.GOVPLANE_LICENSE }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm install --global @govplane/cli @govplane/cli-toolkit

      - name: Confirm the licence is usable
        run: govplane license verify

      - name: Validate policies
        run: govplane validate --strict --format json -w ./governance
```

### GitLab CI

```yaml
policies:
  image: node:22
  variables:
    GOVPLANE_HOME: "$CI_PROJECT_DIR/.govplane"
  script:
    - npm install --global @govplane/cli @govplane/cli-toolkit
    - govplane license verify
    - govplane validate --strict -w ./governance
```

Setting `GOVPLANE_HOME` inside the workspace keeps Govplane state out of the
runner's home directory, which matters on shared runners.

## Keeping pipelines quiet

```bash
govplane validate --quiet             # nothing on success
govplane license --format json        # data, never a prose banner
```

With `--format json`, activation state travels as a field:

```json
{ "activation": { "state": "grace", "daysRemaining": 22 } }
```

## Without a licence in CI

A pipeline with no licence still works during the grace period, but the
activation notice prints on **every** run rather than staying quiet for 30 days.
That is deliberate: a pipeline that has been told every run is never surprised by
a first failure on day 31.

Ephemeral containers reset the grace anchor each run, so in practice an
unlicensed CI job keeps working. That is not a loophole to rely on — it is the
consequence of refusing to fingerprint machines. Supply a licence and get a
predictable pipeline.

## Gating on activation

```bash
if ! govplane license --quiet; then
  echo "No Govplane licence available; skipping bundle build."
  exit 0
fi
```

`govplane license` exits `0` only with a valid licence, and never starts the
grace clock just to answer the question.

## Exit codes worth handling

| Code | Meaning | Typical response |
| ---- | ------- | ---------------- |
| `0` | Success | continue |
| `1` | Validation failed, or no usable licence | fail the build |
| `2` | File or working-folder error | fix the checkout or paths |
| `3` | Invalid arguments | fix the command |
| `7` | Not activated, grace period over | supply `GOVPLANE_LICENSE` |

Full table: [exit codes in the CLI docs](https://github.com/govplane/govplane-cli/blob/main/docs/exit-codes.md).

## Testing against a stub service

Neither the production service nor a real licence is needed to test integration:

```bash
npm run stub-server        # in the toolkit checkout
```

It prints the `GOVPLANE_API_URL` and `GOVPLANE_LICENSE_PUBLIC_KEY` to export. The
stub signs with a key generated per run and held only in memory.
