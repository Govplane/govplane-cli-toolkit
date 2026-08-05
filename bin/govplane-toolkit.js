#!/usr/bin/env node
/**
 * Govplane CLI Toolkit launcher.
 *
 * The usual way to reach these commands is the `govplane` executable, which
 * discovers the kit automatically. This launcher exists for installations where
 * the CLI cannot resolve the toolkit — a local project install, for example —
 * and for running the kit directly from a checkout.
 */

var MINIMUM_NODE_MAJOR = 20;
var EXIT_COMPATIBILITY = 4;
var EXIT_INTERNAL_ERROR = 5;

var current = process.versions.node;
var major = Number.parseInt(current.split('.')[0], 10);

if (Number.isNaN(major) || major < MINIMUM_NODE_MAJOR) {
  process.stderr.write(
    'Govplane CLI Toolkit requires Node.js ' + MINIMUM_NODE_MAJOR + ' or later. '
      + 'Current version: Node.js ' + current + '\n',
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
