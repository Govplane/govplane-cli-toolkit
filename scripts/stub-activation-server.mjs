/**
 * Local stub of the Govplane activation service.
 *
 * Implements the contract in
 * `specs/cli-toolkit/cli_toolkit_activation_spec.md` §8 so the whole activation
 * flow — device start, browser confirmation, polling, licence signing and local
 * verification — can be developed and demonstrated before the production
 * endpoints exist.
 *
 * An Ed25519 key pair is generated on start-up and only ever lives in memory:
 * no private key material is written to disk or committed.
 *
 * Usage:
 *   npm run stub-server
 *
 * Then, in another terminal, follow the printed instructions.
 */

import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, sign as signPayload } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const TERMS_VERSION = '2026-07-01';
const KEY_ID = 'stub-license-key';
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// The public half is written out so it can be pointed at rather than copied:
// a PEM block pasted into a shell export is easy to mangle. The private half
// stays in memory and is discarded when this process exits.
const publicKeyPath = join(tmpdir(), `govplane-stub-license-key-${PORT}.pem`);
writeFileSync(publicKeyPath, publicKeyPem);

/** deviceCode -> { userCode, state, email, marketingConsent, createdAt } */
const requests = new Map();

const sortKeysDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((accumulator, key) => {
      accumulator[key] = sortKeysDeep(value[key]);
      return accumulator;
    }, {});
  }
  return value;
};

/** Same canonicalisation as `canonicalDocument` in @govplane/cli. */
const canonicalDocument = (document) => {
  const copy = { ...document };
  delete copy.signature;
  return Buffer.from(JSON.stringify(sortKeysDeep(copy)), 'utf8');
};

const randomCode = (length) => Array.from(
  randomBytes(length),
  (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
).join('');

const issueLicense = (email, marketingConsent) => {
  const issuedAt = new Date();
  const renewAfter = new Date(issuedAt.getTime());
  renewAfter.setFullYear(renewAfter.getFullYear() + 1);

  const body = {
    schemaVersion: 1,
    licenseId: `lic_stub_${randomCode(10)}`,
    // No email means no `subject` key at all — never an empty object. The signature
    // covers the canonical bytes, so the two are different documents, and this stub
    // exists to reproduce exactly what the real service emits.
    ...(email ? { subject: { email } } : {}),
    plan: 'toolkit-free',
    issuedAt: issuedAt.toISOString(),
    renewAfter: renewAfter.toISOString(),
    terms: { version: TERMS_VERSION, acceptedAt: issuedAt.toISOString() },
    marketingConsent,
  };

  return {
    ...body,
    signature: {
      algorithm: 'Ed25519',
      keyId: KEY_ID,
      value: signPayload(null, canonicalDocument(body), privateKey).toString('base64'),
    },
  };
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
};

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
};

const sendHtml = (response, status, html) => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
};

/**
 * Escapes a value for interpolation into HTML.
 *
 * Both values this page interpolates come from the request — the code from a
 * query string on GET and from the form body on POST — so writing either
 * straight into the markup is a reflected cross-site scripting hole. The code
 * lands inside a quoted attribute, where `"` alone is enough to break out and
 * add an event handler.
 *
 * Quotes are escaped as well as angle brackets, so the same function is correct
 * in both element and attribute context and there is no second helper to reach
 * for the wrong one.
 */
const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * Narrows a submitted code to the shape a real one has.
 *
 * Escaping already makes the page safe; this keeps anything that is not a code
 * from being echoed back at all. `CODE_ALPHABET` plus the separator is the whole
 * of the vocabulary — see `randomCode`.
 */
const sanitiseUserCode = (value) => String(value ?? '')
  .toUpperCase()
  .replace(/[^0-9A-Z-]/g, '')
  .slice(0, 20);

/**
 * The confirmation page.
 *
 * Deliberately mirrors the consent rules the real page must follow: the terms
 * checkbox is required, the marketing checkbox is separate and unticked, and
 * activation completes either way.
 */
const activationPage = (prefilledCode, message) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Activate Govplane (stub)</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
    fieldset { border: 1px solid #ccc; border-radius: .5rem; padding: 1rem; margin: 1.5rem 0; }
    label { display: block; margin: .75rem 0; }
    input[type=text], input[type=email] { width: 100%; padding: .5rem; font: inherit; }
    button { font: inherit; padding: .6rem 1.2rem; border-radius: .4rem; cursor: pointer; }
    .note { color: #555; font-size: .9rem; }
    .banner { background: #fff8e1; border: 1px solid #ffe082; padding: .75rem 1rem; border-radius: .4rem; }
    .msg { background: #e8f5e9; border: 1px solid #a5d6a7; padding: .75rem 1rem; border-radius: .4rem; }
  </style>
</head>
<body>
  <p class="banner"><strong>Stub activation service.</strong> For local development only.</p>
  <h1>Activate the Govplane CLI Toolkit</h1>
  <p>Activation is free and takes about 30 seconds. An email address is optional.</p>
  ${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
  <form method="POST" action="/activate">
    <label>Code from your terminal
      <input type="text" name="userCode" value="${escapeHtml(sanitiseUserCode(prefilledCode))}" required>
    </label>
    <label>Email address <span class="note">Optional. Leave it empty to activate without one.</span>
      <input type="email" name="email">
    </label>
    <fieldset>
      <legend>Before you continue</legend>
      <label><input type="checkbox" name="terms" required> I accept the terms of service (version ${TERMS_VERSION}). <span class="note">Required.</span></label>
      <label><input type="checkbox" name="marketing"> Send me occasional product news. <span class="note">Optional, and only meaningful with an email address.</span></label>
    </fieldset>
    <button type="submit">Activate</button>
    <button type="submit" name="decline" value="1">Decline</button>
  </form>
</body>
</html>`;

const findByUserCode = (userCode) => {
  const normalised = String(userCode ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  for (const [deviceCode, entry] of requests) {
    if (entry.userCode.replace(/[^0-9A-Z]/g, '') === normalised) {
      return { deviceCode, entry };
    }
  }
  return null;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  if (request.method === 'POST' && url.pathname === '/v1/activation/device/start') {
    const deviceCode = randomBytes(24).toString('hex');
    const userCode = `GOVP-${randomCode(4)}-${randomCode(4)}`;
    requests.set(deviceCode, { userCode, state: 'pending', createdAt: Date.now() });

    console.log(`\n  → activation started: ${userCode}`);
    console.log(`    confirm at: http://localhost:${PORT}/activate?code=${userCode}\n`);

    sendJson(response, 200, {
      deviceCode,
      userCode,
      verificationUri: `http://localhost:${PORT}/activate`,
      verificationUriComplete: `http://localhost:${PORT}/activate?code=${userCode}`,
      interval: 1,
      expiresIn: 600,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/activation/device/poll') {
    const body = await readBody(request);
    const entry = requests.get(body.deviceCode);

    if (!entry) {
      sendJson(response, 200, { status: 'expired' });
      return;
    }
    if (entry.state === 'approved') {
      sendJson(response, 200, {
        status: 'activated',
        license: issueLicense(entry.email, entry.marketingConsent),
      });
      requests.delete(body.deviceCode);
      return;
    }
    if (entry.state === 'denied') {
      sendJson(response, 200, { status: 'denied' });
      requests.delete(body.deviceCode);
      return;
    }

    sendJson(response, 200, { status: 'pending' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/activate') {
    sendHtml(response, 200, activationPage(url.searchParams.get('code'), null));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/activate') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const found = findByUserCode(form.get('userCode'));

    if (!found) {
      sendHtml(response, 404, activationPage(form.get('userCode'), 'That code was not found.'));
      return;
    }

    if (form.get('decline') === '1') {
      found.entry.state = 'denied';
      console.log('  → activation declined');
      sendHtml(response, 200, activationPage(
        null,
        'Activation declined. You can close this page.',
      ));
      return;
    }

    // An empty field means "no address", not "use a default". Substituting one here
    // would make the anonymous path impossible to exercise locally, which is the one
    // thing this stub exists for.
    const email = (form.get('email') ?? '').trim();

    found.entry.state = 'approved';
    found.entry.email = email === '' ? null : email;
    // Consent needs an address to mean anything, so without one it is recorded as false.
    found.entry.marketingConsent = email !== '' && form.get('marketing') === 'on';
    console.log(`  → activation approved for ${found.entry.email ?? '(no email)'}`
      + ` (product news: ${found.entry.marketingConsent ? 'yes' : 'no'})`);

    sendHtml(response, 200, activationPage(
      null,
      'Activated. You can close this page and return to your terminal.',
    ));
    return;
  }

  sendJson(response, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Govplane stub activation service listening on http://localhost:${PORT}`);
  console.log('');
  console.log('Run the toolkit against it with:');
  console.log('');
  console.log(`  export GOVPLANE_API_URL=http://localhost:${PORT}`);
  console.log(`  export GOVPLANE_LICENSE_PUBLIC_KEY="$(cat ${publicKeyPath})"`);
  console.log('  export GOVPLANE_HOME=$(mktemp -d)          # keep your real profile untouched');
  console.log('');
  console.log('  node bin/govplane-toolkit.js activate');
  console.log('');
  console.log('The signing key is generated per run and never leaves memory.');
});
