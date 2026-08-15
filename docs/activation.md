# Activation

The Govplane CLI Toolkit is free, and asks for one thing: that you accept the
terms. An email address is optional — you can give one, or activate without.
This document explains what activation actually does, what it stores, and why it
does not turn the toolkit into something that depends on Govplane.

The normative specification is
[`cli_toolkit_activation_spec.md`](../../../specs/cli-toolkit/cli_toolkit_activation_spec.md).

## The shape of it

```text
govplane activate
      │
      ├─ CLI asks the service to open an activation request
      │     sends: { client: "govplane-toolkit", clientVersion: "1.1.1" }
      │     gets:  a short code and a URL
      │
      ├─ you confirm in the browser
      │     accept terms · optionally: email · verify it · product news
      │
      ├─ CLI polls until you are done
      │
      └─ CLI receives a signed licence, verifies it locally, stores it
            ~/.govplane/license.json   (mode 0600)

…and then never contacts Govplane again.
```

This is the OAuth 2.0 Device Authorization Grant (RFC 8628) — the same flow as
`gh auth login`, `docker login` and `stripe login`. It is used here for three
reasons:

1. **The terminal never handles your email address.** Nothing personal enters
   shell history, process arguments or CI logs.
2. **Consent is captured where it can be shown properly.** The terms are
   versioned and readable; the marketing checkbox is separate and unticked.
3. **No OTP infrastructure.** There is no code to email, no spam folder to blame,
   and no rate-limiting puzzle to get wrong.

## The licence is evidence, not permission

The licence is a signed JSON document that **you** hold. The toolkit verifies it
with a public key shipped inside the package. Govplane is not asked for
permission at use time — there is nothing to ask.

```json
{
  "schemaVersion": 1,
  "licenseId": "lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD",
  "subject": { "email": "dev@example.com" },
  "plan": "toolkit-free",
  "issuedAt": "2026-07-29T12:00:00.000Z",
  "renewAfter": "2027-07-29T12:00:00.000Z",
  "terms": { "version": "2026-07-01", "acceptedAt": "2026-07-29T11:59:58.000Z" },
  "marketingConsent": false,
  "signature": { "algorithm": "Ed25519", "keyId": "license-key-01", "value": "…" }
}
```

Activated without an email address, the same document simply has **no `subject`
key**:

```json
{
  "schemaVersion": 1,
  "licenseId": "lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD",
  "plan": "toolkit-free",
  "issuedAt": "2026-07-29T12:00:00.000Z",
  "renewAfter": "2027-07-29T12:00:00.000Z",
  "terms": { "version": "2026-08-15", "acceptedAt": "2026-07-29T11:59:58.000Z" },
  "marketingConsent": false,
  "signature": { "algorithm": "Ed25519", "keyId": "license-key-01", "value": "…" }
}
```

The key is omitted rather than left empty. That distinction is not cosmetic: the
signature covers the canonical bytes, so `"subject": {}` is a different document
and would not verify. A licence with an empty subject is treated as malformed,
not anonymous.

Such a licence has no owning account, so it cannot be re-downloaded from the
dashboard. Losing it costs one `govplane activate`.

That design decision is what keeps the promise "own your runtime" true for the
toolkit as well as the SDK:

- **No network after activation.** No heartbeat, no licence check, no telemetry.
- **No expiry.** An offline or long-lived build machine cannot be timed out.
- **No machine binding.** One licence, all your machines.
- **Tamper-evident.** Editing any field — the email, the plan, the consent flag —
  invalidates the signature. So does adding a `subject` to a licence issued
  without one, or removing it from a licence issued with one.

The trade-off is honest and worth stating: because verification is offline,
licences cannot be revoked. For a free licence, that is an acceptable price for
never breaking a user's build.

### What is signed

Everything except the `signature` field. The document is deep-key-sorted,
serialised without whitespace, and encoded as UTF-8.

This differs from how *bundles* are canonicalised — those project down to an
explicit list of fields — and the difference is deliberate. A licence means
something in every field it carries, so no field may sit outside the signature's
coverage.

### Verifying it yourself

```bash
govplane license verify
```

```text
✓ Licence signature is valid

  Licence ID:  lic_01JQ8ZC4T7YB3W0P5R2K9M6XQD
  Key ID:      license-key-01
```

This works with the network unplugged, which is the point.

## Where the licence is read from

| Order | Source | Typical use |
| ----- | ------ | ----------- |
| 1 | `GOVPLANE_LICENSE` (inline JSON) | CI |
| 2 | `GOVPLANE_LICENSE_FILE` (path) | shared build images |
| 3 | `$GOVPLANE_HOME/license.json` | a developer machine |

`GOVPLANE_HOME` defaults to `~/.govplane` and redirects everything, which is how
CI keeps Govplane state inside the workspace.

## The grace period

The toolkit works for 30 days before activation is required.

The clock starts on your **first toolkit command**, recorded once in
`$GOVPLANE_HOME/state.json`:

```json
{ "schemaVersion": 1, "toolkitFirstUsedAt": "2026-07-29T12:00:00.000Z" }
```

Anchoring on first use rather than install time means someone who installs the
kit, gets pulled onto something else, and comes back two months later still has a
full 30 days.

| Days elapsed | Behaviour |
| ------------ | --------- |
| 0–23 | Runs. One-line reminder. |
| 24–30 | Runs. Short notice with the days remaining. |
| 31+ | Toolkit commands stop, with instructions. Exit code `7`. |

Moving your clock backwards does not extend anything: elapsed days are floored at
zero, never negative.

### What still works on day 31

Everything that matters in production:

```bash
govplane validate       # ✅ never gated
govplane inspect        # ✅ never gated
govplane version        # ✅ never gated
govplane help           # ✅ never gated
govplane working-folder  # ✅ never gated
```

The SDK is untouched, and every bundle you have already built keeps evaluating.
Only `analyze`, `build`, `sign`, `simulate` and `policies` stop, and the message
says so explicitly, because someone hitting a wall deserves to know immediately
that nothing is on fire.

### It is a nudge, not a lock

The grace anchor lives in a file in your home directory. Deleting it resets the
clock, and an ephemeral CI container resets it every run.

That is known and accepted. Detecting it would need machine fingerprinting or a
call home, both of which contradict everything above — and the licence is free,
so there is nothing to protect. Activation is a way to say hello, not a lock.

What we do instead: in CI, the reminder prints from the very first run, so a
pipeline is never surprised by a day-31 failure.

## Renewal

A licence may carry `renewAfter`. Once it passes, the toolkit shows a one-line
nudge to run `govplane activate` again. It never blocks, and it never triggers a
network call. A licence with no `renewAfter` never nudges.

## Key rotation

Licences name the key that signed them. The toolkit ships every currently valid
public key, so rotating a signing key does not invalidate licences already
issued.

A licence signed with a key this build does not know reports that an update is
needed:

```text
This licence was signed with key "license-key-02", which this version does not
recognise. Update the toolkit with:
  npm install --global @govplane/cli-toolkit@latest
```

That is deliberately not phrased as tampering — an out-of-date CLI is a much more
likely explanation than an attack.

## When something is wrong with a licence

A licence that fails verification is treated as **absent**, not fatal: you are
told what is wrong and how to fix it, and the grace period still decides whether
the command runs.

```text
The licence on this machine could not be used:
  The licence signature does not match its contents. The file may have been edited.

Run "govplane activate" to replace it, or "govplane license remove" to delete it.
```

A corrupted file should never leave someone stuck with no way forward.

| Code | Meaning |
| ---- | ------- |
| `LICENSE_NOT_FOUND` | No licence on this machine |
| `LICENSE_INVALID_JSON` | The file is not valid JSON |
| `LICENSE_INVALID_SCHEMA` | Required fields are missing or malformed |
| `LICENSE_SIGNATURE_INVALID` | The contents no longer match the signature |
| `LICENSE_UNKNOWN_KEY` | Signed with a key this build does not ship |
| `LICENSE_UNSUPPORTED` | A licence this version cannot honour |
| `ACTIVATION_REQUIRED` | Grace period over, no licence |
| `ACTIVATION_DECLINED` | You declined in the browser |
| `ACTIVATION_EXPIRED` | The request timed out |
| `ACTIVATION_UNREACHABLE` | The activation service could not be reached |
