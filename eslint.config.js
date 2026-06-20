import js from '@eslint/js';
import globals from 'globals';

// Flat ESLint config for Vox Ball / ProsodyBall.
//
// Goal: catch real bugs (undefined vars, typos, unreachable code, duplicate keys)
// in the large untyped browser sources without forcing a giant stylistic churn.
// Stylistic-only rules are intentionally left off; correctness rules are errors.
export default [
  {
    ignores: ['node_modules/**', '**/*.min.js'],
  },

  js.configs.recommended,

  // Browser-side application + device controllers (ES modules, DOM/Web APIs).
  {
    files: [
      'app.js',
      'dsp-utils.js',
      'performance-monitor.js',
      'calibration-wizard.js',
      'bulb-controller.js',
      'necklace-controller.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Surface unused symbols without blocking on every incidental one.
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      // Empty catch blocks are used intentionally for best-effort hardware/teardown paths.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Node-side ESM tooling, BLE/LAN proxy, and test files.
  {
    files: ['**/*.mjs', 'hue-bridge.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // CommonJS build/update scripts and tooling.
  {
    files: ['**/*.cjs', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Wear OS overlay scripts run as classic browser scripts.
  {
    files: ['wear/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
