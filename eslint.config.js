'use strict';
// Lint rules for the whole project.
//
//   npm run lint
//
// Three environments live here, and mixing them up is itself a bug: the main
// process is CommonJS on Node, the renderer is ES modules in the browser
// without Node, and the preload sits in between - CommonJS, but with the
// browser's globals.
//
// Beyond `eslint:recommended` two things are watched that this app can get
// wrong without anybody noticing: markup built from strings (the renderer
// writes the panels itself, and a branch name or a table name is foreign
// input), and the usual Node traps around child processes and paths.

const js = require('@eslint/js');
const globals = require('globals');
const nounsanitized = require('eslint-plugin-no-unsanitized');
const security = require('eslint-plugin-security');

// The functions whose result may go into markup. Anything else that ends up in
// innerHTML is reported - which is the point of the rule.
const HTML_PRODUCERS = ['escapeHtml', 'mdToHtml', 'highlightDiff'];

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'out/**'] },

  js.configs.recommended,
  nounsanitized.configs.recommended,
  security.configs.recommended,

  {
    // Everything shares these - the defaults are for the main process, the
    // blocks below only say what differs.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // An unused catch binding is the case that actually happens here: the
      // error is swallowed and nobody looks at it again.
      'no-unused-vars': ['error', {
        args: 'after-used',
        caughtErrors: 'all',
        ignoreRestSiblings: true,
      }],
      // Everything the renderer interpolates into markup goes through
      // escapeHtml() from dom.js; mdToHtml() and highlightDiff() run their
      // input through it first and then build the markup themselves. Told
      // that, the rule stops reporting whole files and reports the places
      // where a value goes in raw.
      'no-unsanitized/property': ['error', { escape: { methods: HTML_PRODUCERS } }],
      'no-unsanitized/method': ['error', { escape: { methods: HTML_PRODUCERS } }],

      // Escape sequences are this app's subject matter: a terminal reads OSC
      // and CSI out of the PTY stream, and those are control characters.
      'no-control-regex': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',
      'no-console': 'off',

      // Off from the security plugin, each for its own reason:
      // the object indexing is over our own maps and dictionaries;
      'security/detect-object-injection': 'off',
      // the regexes are literals in the sources, not built out of input;
      'security/detect-non-literal-regexp': 'off',
      // safe-regex counts star height and reports nested quantifiers that are
      // anchored and bounded here - sixteen of them, all in parsers whose
      // input the callers have already collapsed;
      'security/detect-unsafe-regex': 'off',
      // and reading a path that comes from somewhere else is what this app
      // does all day: the transcripts, migrations and repositories the user
      // points it at.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  {
    // The build configuration is loaded by Vite, which reads ES modules only.
    files: ['electron.vite.config.js', 'scripts/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },

  {
    // The i18n runtime is the one module all three processes share, and the
    // renderer imports it as it stands - so it is an ES module, unlike the
    // rest of src/i18n and src/main around it.
    files: ['src/i18n/runtime.js'],
    languageOptions: { sourceType: 'module' },
  },

  {
    // The renderer: ES modules, browser, no Node.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.browser,
    },
  },

  {
    // The preload runs in the renderer process but is loaded as CommonJS.
    files: ['src/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    files: ['test/**/*.js'],
    rules: {
      // A test starts processes and loads modules by a name it puts together
      // itself - that is how it gets at every locale or at a real shell.
      'security/detect-child-process': 'off',
      'security/detect-non-literal-require': 'off',
      // `throw null` is a case the code has to survive, so a test throws it.
      'no-throw-literal': 'off',
    },
  },
];
