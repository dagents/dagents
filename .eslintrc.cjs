/**
 * Root ESLint config (eslint 8 / .eslintrc). Shared across all workspaces;
 * each package runs it via its `lint` script (`turbo run lint`).
 *
 * Baseline is typescript-eslint `recommended`. It overlaps heavily with the
 * project's strict `tsc --noEmit`, so it surfaces a small, high-signal set of
 * issues (unused vars, untyped catches, empty blocks, etc.) rather than
 * re-linting what the compiler already enforces. `ecmaFeatures.jsx` lets the
 * same config lint the console's `.tsx`.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // tsc (noUnusedLocals) already covers unused locals; keep eslint's version
    // as a non-blocking warning so intentional _-prefixed args don't fail CI.
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // react-hooks: rules-of-hooks catches real bugs (hooks called conditionally
    // or in loops); exhaustive-deps is a warning so the pre-existing
    // eslint-disable comments in console components stay meaningful.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    {
      // Test/stub files routinely use `any`, alias `this`, and write generator
      // stubs that never yield — all intentional in fixtures, not regressions.
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-this-alias': 'off',
        'require-yield': 'off',
      },
    },
  ],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '.next/',
    'coverage/',
    'vendor/',
    'next-env.d.ts',
    '*.config.js',
    '*.config.ts',
  ],
}
