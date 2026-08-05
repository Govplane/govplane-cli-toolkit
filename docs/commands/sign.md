# `govplane sign`

Applies a signature to an existing **unsigned** runtime bundle, using local key
material only.

```bash
govplane sign [options]
```

## When to use it

Prefer `govplane build --signed` when the signing key is available at build
time — one step, one artifact. Reach for `sign` when signing is a separate
concern:

- a bundle was built without `--signed`
- a bundle was assembled by hand
- your pipeline compiles in one job and signs in another, with the key held only
  by the second

```bash
govplane sign \
  --signing-algorithm HMAC_SHA256 \
  --hmac-secret-env GOVPLANE_HMAC_SECRET
```

```text
Govplane Sign

Input:
  Bundle: policy-bundle.json

Integrity:
  Checksum: sha256:2f7d…  (recomputed)
  ETag: "2f7d…"

Signature:
  Algorithm: HMAC_SHA256
  Key ID:    GOVPLANE_HMAC_SECRET

Output:
  Bundle: policy-bundle.json  (in-place)

Result:
  Bundle signed successfully
```

## The same engine as build

`sign` and `build --signed` are the same signing code over the same canonical
payload. Signing the same content with the same key produces **byte-identical
signatures** either way, and the toolkit's test suite asserts it. There is no
second implementation to drift.

## What it does, in order

1. Resolve and load the bundle.
2. Refuse it if it already carries a signature — before any key is read.
3. Validate it against the runtime rules.
4. Resolve the output path, so a collision is reported before a key is read.
5. Recompute the checksum and ETag.
6. Sign the canonical payload.
7. Write atomically.

Nothing is written unless every step passes, and no key material is touched
until the bundle is known to be worth signing.

## Input

| Order | Source |
| ----- | ------ |
| 1 | `--bundle <path>` |
| 2 | `bundle.path` in `govplane.config.json` |
| 3 | `policy-bundle.json` in the working folder |

The bundle must be JSON. A missing file, unparsable JSON, or a document that is
not an object is reported and nothing is signed.

## Output

By default the input file is **overwritten in place** with the signed version.

```bash
govplane sign --output ./dist/policy-bundle.signed.json
```

With `--output`, the input is never modified. If the output path already exists,
the command stops rather than clobbering a file it did not create:

```text
Error: The output path already exists: ./dist/policy-bundle.signed.json

Use --force-output to allow overwriting it.
```

Writes are atomic — temporary file, fsync, rename — so an interrupted run cannot
leave a half-signed bundle on disk.

## Already-signed bundles

A bundle that carries a `signature` field is refused:

```text
Error: The bundle already contains a signature.

Input: ./policy-bundle.json

To re-sign, remove the existing signature field first. There is no override:
replacing a signature is an explicit decision, not a flag.

BUNDLE_ALREADY_SIGNED
```

There is deliberately **no `--force` or `--re-sign`**. If replacing a signature
were one flag away, an artifact's signature would stop being evidence of a
decision and become evidence of whichever key happened to run last.

## Integrity is recomputed

The checksum and ETag are recomputed from the bundle's current contents
immediately before signing, whether the input had a correct checksum, a stale
one, or none at all. The signed artifact therefore always describes what it
actually contains.

A stale checksum on input is **not** an error — repairing it is part of what
this command is for. (`govplane validate` does treat it as one, because there
nothing is going to fix it.)

## Signing

```bash
# HMAC — a shared 256-bit secret, as 64 hex characters
govplane sign --signing-algorithm HMAC_SHA256 --hmac-secret-env GOVPLANE_HMAC_SECRET

# ECDSA — a local P-256 private key
govplane sign \
  --signing-algorithm ECDSA_SHA_256 \
  --ecdsa-private-key ./keys/signing-private.pem \
  --signing-key-id release-2026-07
```

| Algorithm | Key | Signature |
| --------- | --- | --------- |
| `HMAC_SHA256` | 64 hex characters (256-bit) | lowercase hex |
| `ECDSA_SHA_256` | unencrypted EC private key, PEM | base64 DER |

The algorithm must be stated, by flag or by `sign.signing.algorithm`. Unlike
`build`, there is no default: you are retrofitting a signature onto an existing
artifact, and guessing how to sign it is not a helpful default.

### Generating a key pair

`ECDSA_SHA_256` needs a **P-256** (`prime256v1`) key pair. `openssl` ships with
macOS and most Linux distributions:

```bash
mkdir -p keys && chmod 700 keys

# Private key — keep it out of the repository
openssl ecparam -name prime256v1 -genkey -noout -out keys/signing-private.pem
chmod 600 keys/signing-private.pem

# Public key — this is the one you distribute to verifiers
openssl pkey -in keys/signing-private.pem -pubout -out keys/signing-public.pem
```

Node produces the same pair, which avoids the differences between OpenSSL and
the LibreSSL that older macOS versions ship:

```bash
mkdir -p keys && chmod 700 keys && node -e '
const { generateKeyPairSync } = require("crypto");
const { writeFileSync } = require("fs");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
writeFileSync("keys/signing-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync("keys/signing-public.pem", publicKey.export({ type: "spki", format: "pem" }));
'
```

Either private-key encoding works — `-----BEGIN EC PRIVATE KEY-----` from
`openssl ecparam`, or `-----BEGIN PRIVATE KEY-----` from Node. The key must be
**unencrypted**: `sign` has no way to prompt for a passphrase, and a protected key
fails with *"the private key could not be parsed"*.

Sign with it, then verify with the public half:

```bash
govplane sign \
  --signing-algorithm ECDSA_SHA_256 \
  --ecdsa-private-key ./keys/signing-private.pem \
  --signing-key-id release-2026-08

govplane inspect --signature --public-key ./keys/signing-public.pem
```

For HMAC, the secret is 64 hex characters:

```bash
openssl rand -hex 32
```

Anyone who can verify an HMAC signature can also produce one, so it says a bundle
was not altered — not who signed it. Use ECDSA where that distinction matters.

### Key identifiers

`keyId` is recorded in the signature so a verifier knows which key to reach for.
When `--signing-key-id` is not given, it is derived from where the key came from:

| Key source | Derived `keyId` |
| ---------- | --------------- |
| `--hmac-secret-env GOVPLANE_HMAC_SECRET` | `GOVPLANE_HMAC_SECRET` |
| `--ecdsa-private-key ./keys/release-key.pem` | `release-key.pem` |
| `--hmac-secret <hex>` | none — `--signing-key-id` is required |

An inline secret has no name worth recording, so rather than invent one the
command asks for `--signing-key-id`. A made-up identifier inside a signature is a
false provenance claim.

### Key material never appears in output

No secret, private key, or fragment of either is printed — including under
`--verbose`. Errors name the *source* of a key, never its contents:

```text
Error: Signing failed for key source GOVPLANE_HMAC_SECRET.

Reason: invalid hex length (expected 64 hexadecimal characters, got 6).
```

## Verifying the result

```bash
govplane inspect ./policy-bundle.json --signature --public-key ./keys/signing-public.pem
```

For HMAC there is no separate public key: verification uses the same secret, and
the runtime SDK is configured with it directly.

## Options

```text
--bundle <path>                  Bundle to sign (default: policy-bundle.json)
--signing-algorithm <algorithm>  HMAC_SHA256 or ECDSA_SHA_256 (required)
--signing-key-id <value>         Key identifier recorded in the signature
--hmac-secret <hex>              HMAC secret (prefer --hmac-secret-env)
--hmac-secret-env <var>          Environment variable holding the HMAC secret
--ecdsa-private-key <path>       ECDSA private key, PEM
--output <path>                  Write here instead of in-place
--force-output                   Allow overwriting an existing --output
--strict                         Treat warnings as requiring attention
--format <text|json>             Output format
--quiet                          Suppress non-essential output
--verbose                        Show resolved paths and the key source
-w, --working-folder <path>      Working folder
--config <path>                  Configuration file
-h, --help                       Command help
```

## Configuration

`sign` keeps its own signing block, separate from `build`, so a project can build
unsigned in development and sign with a release key elsewhere:

```json
{
  "bundle": { "path": "policy-bundle.json" },
  "sign": {
    "signing": {
      "algorithm": "HMAC_SHA256",
      "keyId": "local-key-01",
      "hmacSecretEnv": "GOVPLANE_HMAC_SECRET",
      "ecdsaPrivateKeyPath": "./keys/signing-private.pem"
    }
  }
}
```

Flags always win over configuration.

## JSON output

```json
{
  "success": true,
  "input": { "bundlePath": "/project/policy-bundle.json" },
  "output": {
    "bundlePath": "/project/policy-bundle.json",
    "inPlace": true,
    "schemaVersion": 1,
    "env": "prod",
    "bundleVersion": 3,
    "checksum": "sha256:2f7d…",
    "etag": "\"2f7d…\"",
    "signatureAlgorithm": "HMAC_SHA256",
    "signatureKeyId": "GOVPLANE_HMAC_SECRET"
  },
  "warnings": [],
  "stats": { "policies": 8, "rules": 21 }
}
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Signed |
| `1` | Signed, but `--strict` and warnings were present |
| `2` | Bundle file or working-folder error |
| `3` | Invalid arguments, or a missing algorithm or key identifier |
| `4` | Bundle validation failed, or the bundle was already signed |
| `5` | Signing failed — key error or algorithm error |
| `6` | The output could not be written, or the output path was taken |
| `7` | Not activated and the grace period has ended |

Every failure prints its stable error code as the last line, so CI can match on
something that will not change when the wording improves.

## Where this sits

```text
build            →  policy-bundle.json (unsigned)
                          ↓
sign                      ↓
                    policy-bundle.json (signed)  →  SDK
```

```bash
govplane build
govplane sign --signing-algorithm HMAC_SHA256 --hmac-secret-env GOVPLANE_HMAC_SECRET
govplane validate ./policy-bundle.json
```
