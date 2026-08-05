# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report them privately to **security@govplane.com**, or through GitHub's private
vulnerability reporting on this repository.

Include, where possible:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The versions in use (`govplane version --verbose`) and your platform

We aim to acknowledge a report within three business days and to keep you updated
while we work on a fix. Please give us a reasonable window to release a patch
before any public disclosure.

## In scope

The toolkit handles a signed licence, a small amount of personal data, and a
short-lived network exchange. These properties are the security-relevant ones:

- **Licence forgery.** A licence that verifies without being signed by a key this
  package ships, or a way to make a modified licence verify, is a serious issue.
  The signature covers every field except `signature` itself.
- **No implicit network access.** Any request outside `govplane activate` is a
  bug, including a licence check, heartbeat or telemetry call.
- **Data minimisation.** The activation request must carry only the client name
  and version. Anything that leaks a hostname, username, path, project or policy
  content is in scope.
- **Secret exposure.** No output path may print `signature.value`. Verbose output
  must never expose licence keys, tokens or private key material.
- **Licence file handling.** The licence is written atomically at mode `0600`. A
  path that leaves it world-readable, or leaves a partial file behind, is in
  scope.
- **Never bricking a user.** A state where the toolkit cannot be recovered — a
  corrupted licence with no path forward, or a clock change that permanently
  blocks a machine — is a defect we want to hear about.
- **Parsing paths.** Licence, state-file and service-response parsing that could
  lead to unexpected file writes or code execution.

## Out of scope

- **Resetting the grace period.** Deleting `~/.govplane` restarts the 30 days,
  and ephemeral CI containers do so on every run. This is a known and accepted
  consequence of refusing to fingerprint machines. The licence is free; there is
  nothing to protect, and reports of this are not treated as vulnerabilities.
- **Licence revocation.** Verification is deliberately offline, so revocation is
  not possible for the free licence. This is documented, not a defect.
- **Sharing a licence.** Licences are not machine-bound by design.

## Key material

This repository contains **public keys only**, in [`keys/`](keys). No private key
is ever committed or published, and the local stub server generates its own key
pair in memory per run.

`keys/license-key-01.pem` is the public half of the production licence signing
key; its private half is held by the activation service in AWS Secrets Manager
and never leaves it.

Each file there is an Ed25519 public key in SPKI PEM form, loaded by
`src/activation/keys.ts` and selected by the licence's `signature.keyId`. Several
may be valid at once: rotation adds a key rather than replacing one, so a licence
a user already holds keeps verifying against the key that signed it. A licence
signed with a `keyId` a build does not know reports that an update is needed, and
is never reported as tampering.

`GOVPLANE_LICENSE_PUBLIC_KEY` overrides this directory. It exists for the stub
server and the test suite; someone who sets it is trusting only a key they chose
themselves.
