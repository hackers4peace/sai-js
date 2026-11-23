import cloudflare from '@cloudflare/oxlint-config'
import { defineConfig } from 'oxlint'

// This repository is Vue + plain TypeScript: there is no React or JSX code, and
// no .tsx/.jsx files, so the preset's React and a11y plugins have nothing to lint.
const reactRules = Object.fromEntries(
  Object.keys(cloudflare.rules)
    .filter((rule) => /^(?:jsx-a11y|react|react-hooks)\//.test(rule))
    .map((rule) => [rule, 'off' as const])
)

// Temporary migration state: rules that report findings in this repository are
// disabled here and re-enabled one per commit, with fixes or a documented reason
// to stay off. Delete each entry as its rule is migrated.
const notYetMigrated = Object.fromEntries(
  [
    'typescript/no-unsafe-type-assertion',
    'quality/no-unsafe-dictionary-type',
    'quality/no-chained-type-assertions',
    'typescript/no-unsafe-member-access',
    'typescript/no-unnecessary-type-assertion',
    'typescript/no-unsafe-assignment',
    'typescript/no-unsafe-call',
    'quality/no-conditional-empty-object-spread',
    'typescript/no-unsafe-argument',
    'quality/no-known-value-widening',
    'typescript/no-unsafe-return',
    'import/no-namespace',
    'unicorn/catch-error-name',
    'typescript/no-floating-promises',
    'no-console',
    'quality/no-unknown-returns',
    'typescript/no-misused-spread',
    'typescript/await-thenable',
    'no-undef',
    'typescript/use-unknown-in-catch-callback-variable',
    'typescript/unbound-method',
    'quality/no-array-filter-map',
    'typescript/no-misused-promises',
    'unicorn/prefer-top-level-await',
    'typescript/only-throw-error',
    'unicorn/prefer-single-call',
  ].map((rule) => [rule, 'off' as const])
)

export default defineConfig({
  ...cloudflare,
  options: {
    ...cloudflare.options,
    // Temporary during migration: with most rules off, existing disable comments
    // read as unused. Re-enabled once every rule below has been migrated.
    reportUnusedDisableDirectives: 'off',
  },
  rules: {
    ...cloudflare.rules,
    ...reactRules,
    ...notYetMigrated,

    // Carried over from .oxlintrc.json
    'no-underscore-dangle': [
      'error',
      {
        allow: ['_tag', '__dirname', '_getContextManager', 'currentAth_', '_tracerProvider'],
      },
    ],
    // The preset bans `instanceof`, but this code brands its own error classes and
    // checks same-realm values (CryptoKey, Uint8Array, URL, URLSearchParams) where
    // duck typing would be weaker and harder to read.
    '@nkzw/no-instanceof': 'off',
    'unicorn/no-array-for-each': 'off',
    'oxc/no-accumulating-spread': 'off',
    'typescript/no-explicit-any': 'off',
    'typescript/no-non-null-assertion': 'off',
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      files: ['**/test/**', '**/*.test.ts', '**/*.spec.ts', 'examples/**', 'docs/**'],
      rules: {
        'unicorn/consistent-function-scoping': 'off',
        'no-shadow': 'off',
      },
    },
    {
      // CommonJS is mandatory: these files are loaded through `node --require`
      // before the app's main module, so http instrumentation can patch the
      // server first. `typescript/no-require-imports` would force ESM here.
      files: ['**/*.cjs'],
      rules: {
        'typescript/no-require-imports': 'off',
      },
    },
    {
      files: ['**/sw.js'],
      rules: {
        'unicorn/require-post-message-target-origin': 'off',
      },
    },
    // Temporary during migration: the preset's own overrides turn some rules back
    // on for TypeScript files, so the not-yet-migrated rules need to be repeated
    // after them. Remove with the matching top-level entry.
    {
      files: ['**/*'],
      rules: notYetMigrated,
    },
  ],
  ignorePatterns: [
    '**/dist/**',
    '**/src/**/*.d.ts',
    '**/test/**/*.d.ts',
    '**/.dagger/sdk/**',
    '.devbox',
    '.turbo',
    'docs/website/.astro',
    'docs/website/likec4-webcomponent.js',
    'docs/website/public/likec4-webcomponent.js',
  ],
})
