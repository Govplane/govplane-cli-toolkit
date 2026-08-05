# Licence verification keys

Public keys that verify activation licences, loaded by
`src/activation/keys.ts` and selected by the licence's `signature.keyId`.

Only public keys belong here. No private key material is ever committed to this
repository or shipped in the published package.

## Files

| File                   | Key ID           | Status                       |
| ---------------------- | ---------------- | ---------------------------- |
| `license-key-01.pem`   | `license-key-01` | **Placeholder — see below.** |

Release checklist:

1. Generate the production Ed25519 licence key in the signing service.
2. Replace `license-key-01.pem` with its public half, as an **SPKI PEM** — the file must
   begin with `-----BEGIN PUBLIC KEY-----`. The signing service holds its keys as JWKS;
   a JWKS pasted here is rejected at verification time with *"Public key must be PEM
   encoded or a base64-encoded raw 32-byte Ed25519 key"*. Convert with:
   ```bash
   node -e "const {createPublicKey}=require('crypto');\
   const jwk=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).keys[0];\
   process.stdout.write(createPublicKey({key:jwk,format:'jwk'}).export({type:'spki',format:'pem'}))" \
     public-jwks-license-key-01.json > license-key-01.pem
   ```
   Use the **public** JWKS. A JWK carrying the private component `d` must never reach this
   directory: it would be committed and published to npm.
3. Confirm `govplane license verify` accepts a licence issued by the service.

## Local development

You do not need a production key to work on activation. The stub activation
server generates an ephemeral key pair on start-up and prints the public key to
use:

```bash
npm run stub-server
# then, in another terminal, follow the printed instructions
```

`GOVPLANE_LICENSE_PUBLIC_KEY` overrides the keys in this directory. It exists
for that stub server and for the test suite; a user who sets it is trusting only
a key they chose themselves.

## Key rotation

Several keys may be valid at once. To rotate:

1. Add the new public key here and register its `keyId` in
   `SHIPPED_KEYS` (`src/activation/keys.ts`).
2. Release the toolkit, and only then start issuing licences signed with the new
   key.

Previously issued licences keep verifying against the old key, so rotation never
invalidates a licence a user already holds. A licence signed with a `keyId` this
build does not know reports that an update is needed — it is never reported as
tampering.
