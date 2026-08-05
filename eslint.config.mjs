import { configs, plugins } from 'eslint-config-airbnb-extended';

/**
 * ESLint flat configuration.
 *
 * The Airbnb JavaScript Style Guide is the project standard; it is applied here
 * through its maintained flat-config distribution, extended with the TypeScript
 * and Node rule sets.
 */
export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'examples/**'],
  },
  plugins.stylistic,
  plugins.importX,
  plugins.node,
  plugins.typescriptEslint,
  ...configs.base.typescript,
  ...configs.node.recommended,
  {
    settings: {
      'import-x/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      // The CLI is native ESM: explicit `.js` specifiers are required at runtime.
      'import-x/extensions': 'off',
      // Modules export named building blocks on purpose; a default export would
      // make the public API harder to grow.
      'import-x/prefer-default-export': 'off',
      // The CLI is a short-lived process that reads and writes small local
      // documents. Synchronous filesystem calls keep ordering, error handling
      // and exit codes straightforward, and are a deliberate design choice.
      'n/no-sync': 'off',
      // `fetch` is available on every supported Node.js LTS release and is only
      // used by the explicit, opt-in `version --check` command.
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch'] }],
      // Commands write through the reporter so that --quiet, --format and
      // stream redirection behave consistently.
      'no-console': 'error',
      'max-len': ['error', { code: 100, ignoreUrls: true, ignoreTemplateLiterals: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The stub activation service is a development tool whose whole job is to
    // print instructions to a terminal.
    files: ['scripts/*.mjs'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'no-await-in-loop': 'off',
      'import-x/no-extraneous-dependencies': 'off',
    },
  },
  {
    files: ['bin/*.js', '*.config.js', '*.config.mjs'],
    rules: {
      // The launcher is the process entry point: exiting on an unsupported
      // Node.js runtime is the whole point of the check.
      'n/no-process-exit': 'off',
      'no-var': 'off',
      'vars-on-top': 'off',
      'prefer-arrow-callback': 'off',
      'func-names': 'off',
      'prefer-template': 'off',
      'import-x/no-extraneous-dependencies': 'off',
    },
  },
];
