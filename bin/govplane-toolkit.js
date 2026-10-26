#!/usr/bin/env node
/**
 * Govplane CLI Toolkit launcher.
 *
 * The usual way to reach these commands is the `govplane` executable, which
 * discovers the kit automatically. This launcher exists for installations where
 * the CLI cannot resolve the toolkit — a local project install, for example —
 * and for running the kit directly from a checkout.
 */

// Oldest release accepted on each supported line: the 21 October 2026
// security releases that fix CVE-2026-111497 (Brotli decompression). Lines
// without an entry never got the fix; lines newer than the last shipped with
// it. Mirrored in the CLI's src/core/environment.ts.
var PATCHED_NODE_RELEASES = ['22.23.4', '24.22.1', '26.12.1'];
var EXIT_COMPATIBILITY = 4;
var EXIT_INTERNAL_ERROR = 5;

function parseRelease(version) {
  var parts = version.split('.').slice(0, 3).map(function toInt(part) {
    return Number.parseInt(part, 10);
  });
  return parts.length === 3 && !parts.some(Number.isNaN) ? parts : null;
}

function isPatchedNode(version) {
  var release = parseRelease(version);
  var newest = parseRelease(PATCHED_NODE_RELEASES[PATCHED_NODE_RELEASES.length - 1]);
  var floor = null;
  var i;
  if (release === null) return false;
  if (release[0] > newest[0]) return true;
  for (i = 0; i < PATCHED_NODE_RELEASES.length; i += 1) {
    if (parseRelease(PATCHED_NODE_RELEASES[i])[0] === release[0]) {
      floor = parseRelease(PATCHED_NODE_RELEASES[i]);
    }
  }
  if (floor === null) return false;
  if (release[1] !== floor[1]) return release[1] > floor[1];
  return release[2] >= floor[2];
}

var current = process.versions.node;

if (!isPatchedNode(current)) {
  process.stderr.write(
    'Govplane CLI Toolkit requires Node.js ' + PATCHED_NODE_RELEASES.join('+, ') + '+ '
      + '(CVE-2026-111497). Current version: Node.js ' + current + '\n',
  );
  process.exit(EXIT_COMPATIBILITY);
}

function ignoreEpipe(stream) {
  stream.on('error', function onError(error) {
    if (error && error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

import('../dist/toolkit.js')
  .then(function run(module) {
    return module.main(process.argv.slice(2));
  })
  .then(function exit(code) {
    process.exitCode = code;
  })
  .catch(function fail(error) {
    process.stderr.write(
      'Govplane CLI Toolkit failed to start: ' + (error && error.message) + '\n',
    );
    process.exitCode = EXIT_INTERNAL_ERROR;
  });
