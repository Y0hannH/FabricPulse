// Diverge volontairement de la config commune Pulse Suite (voir HARMONISATION.md) :
// ce fichier inclut eslint:recommended, que la config commune n'a pas encore.
// À converger en phase 1b, en généralisant eslint:recommended aux quatre repos.
// Flat config — ESLint 9 dropped eslintrc support, so the old .eslintrc.json
// stopped being read and `npm run lint` failed outright ("couldn't find
// eslint.config.js") from the ESLint 10 upgrade onwards. Rule set below is a
// faithful port of that file; nothing was tightened or relaxed in the move.
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const simpleImportSort = require('eslint-plugin-simple-import-sort');

module.exports = [
  // Was `ignorePatterns`. src/webview is plain browser JS (its own globals and
  // conventions) and is deliberately left unlinted.
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'src/webview/**'] },

  {
    // Scoped to .ts so neither the TS parser nor the TS rules reach esbuild.js
    // or this file — what `--ext ts` used to do on the command line.
    files: ['**/*.ts'],

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },

    plugins: { '@typescript-eslint': tsPlugin, 'simple-import-sort': simpleImportSort },

    rules: {
      // extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"]
      ...js.configs.recommended.rules,
      // Turns off the base rules TypeScript already enforces (no-undef among
      // them — without this every require/console/__dirname would be flagged,
      // since flat config defines no globals of its own).
      ...tsPlugin.configs['flat/eslint-recommended'].rules,
      ...tsPlugin.configs.recommended.rules,

      // Project overrides — carried over unchanged.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Was `no-var-requires` in .eslintrc.json; typescript-eslint 8 folded that
      // rule into `no-require-imports`. Same intent: the one require() in
      // storageService is deliberate (sql.js WASM loader under esbuild).
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Phase 1b hardening (HARMONISATION.md) — all autofixable via `eslint --fix`.
      '@typescript-eslint/consistent-type-imports': 'warn',
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Redundant now that `private` already says it: see HARMONISATION.md decision
      // to drop the `_` prefix from private class members. Does not touch the
      // unused-parameter idiom (`argsIgnorePattern: '^_'` above), which is unrelated.
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: ['classProperty', 'classMethod', 'accessor', 'parameterProperty'],
          modifiers: ['private'],
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
