import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Flat config. Goal: catch real bug classes (undefined vars, duplicate keys,
// unreachable code, accidental assignments) as errors, while keeping stylistic
// / unused-var noise as warnings so the large existing codebase stays green.
export default [
  {
    ignores: [
      'node_modules/**',
      'wear/**', // Android/Gradle + vendored overlay assets
      'fixtures/**',
      'tools/test_single_pass.js', // dead CommonJS scratch file (unreferenced, can't run under ESM)
      '**/*.min.js'
    ]
  },
  js.configs.recommended,
  prettier,
  {
    // Browser-side source (app, DSP core, controllers, UI helpers).
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Element with id="recBtn" is exposed by browsers as a named global on
        // window; the game code relies on this. (Fragile pattern — a future
        // cleanup could declare it explicitly via getElementById.)
        recBtn: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }]
    }
  },
  {
    // CommonJS maintenance/build scripts.
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Node-side tooling, tests, and scripts.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  }
];
