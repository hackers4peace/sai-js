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
    'quality/no-unknown-returns',
  ].map((rule) => [rule, 'off' as const])
)

/**
 * The preset's type-safety tier: rules that pin down what may cross a typed
 * boundary. They are enforced in library source, and deliberately relaxed in the
 * two places that cannot meet them yet — see the overrides below.
 */
const typeSafetyTier = {
  'quality/no-chained-type-assertions': 'off',
  'quality/no-conditional-empty-object-spread': 'off',
  'quality/no-known-value-widening': 'off',
  'quality/no-unknown-returns': 'off',
  'quality/no-unsafe-dictionary-type': 'off',
  'typescript/no-unnecessary-type-assertion': 'off',
  'typescript/no-unsafe-argument': 'off',
  'typescript/no-unsafe-assignment': 'off',
  'typescript/no-unsafe-call': 'off',
  'typescript/no-unsafe-member-access': 'off',
  'typescript/no-unsafe-return': 'off',
  'typescript/no-unsafe-type-assertion': 'off',
} as const

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
    // Kept off: the four sites are entry points whose promise chains end in
    // `process.exit(1)` or mount the app. packages/components emits CommonJS, so a
    // top-level await there is invalid, and the Vite apps' build target would have
    // to move to esnext for it.
    'unicorn/prefer-top-level-await': 'off',
    // `typeof import('x')` is the only spelling for a module-namespace type that
    // vi.importOriginal and Temporal's proxyActivities accept, so it stays legal.
    'typescript/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
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
      // Plain JavaScript has no annotations to widen, so the typed catch-callback
      // rule cannot be satisfied in .js/.mjs/.cjs files.
      files: ['**/*.{js,jsx,mjs,cjs}'],
      rules: {
        'typescript/use-unknown-in-catch-callback-variable': 'off',
      },
    },
    {
      // CommonJS is mandatory: these files are loaded through `node --require`
      // before the app's main module, so http instrumentation can patch the
      // server first. `typescript/no-require-imports` would force ESM here.
      files: ['**/*.cjs'],
      rules: {
        'typescript/no-require-imports': 'off',
        // untyped monkey-patching of prototype methods (see preload.cjs)
        'typescript/unbound-method': 'off',
      },
    },
    {
      // Namespaces that library or local shape force: Temporal addresses activity
      // modules as a whole (`proxyActivities<typeof activities>`, and the module
      // object registered on a worker); jsonld-lib unwraps the CJS default export
      // of `jsonld`; effect/Schema's `S.*` keeps its schema constructors from
      // shadowing global String/Number/Array; and the UI store declares actions
      // with the same names as the `@/effect` helpers it calls.
      files: [
        '**/src/temporal/**',
        '**/src/workers/**',
        'packages/utils/src/jsonld-lib.ts',
        'services/id/**',
        'packages/api-messages/src/effect.ts',
        'ui/authorization/src/store/app.ts',
      ],
      rules: {
        'import/no-namespace': 'off',
      },
    },
    {
      // Tier exemption: tests build malformed and partial JSON-LD/RDF payloads on
      // purpose, so decoding them would fight the subject under test. The preset
      // already relaxes seven rules for these same paths.
      files: ['**/test/**', '**/__tests__/**', '**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts}'],
      rules: { ...typeSafetyTier },
    },
    {
      // Tier exemption: .dagger owns a yarn-managed dependency tree with no
      // @types/node, so the type-aware backend resolves node:crypto to `any` and
      // reports every randomUUID() as unsafe. tsc sees the real type; the finding
      // is a resolution artifact. Follow-up: add @types/node to .dagger.
      files: ['.dagger/**'],
      rules: { ...typeSafetyTier },
    },
    {
      // Process entry points, build scripts, Temporal activities (sandboxed), and
      // the Vue apps fall back to the console: none of them has a CSS logger.
      files: [
        'scripts/**',
        'shapetrees/**',
        'test/**',
        'examples/**',
        'ui/**',
        '**/src/workers/**',
        '**/src/temporal/**',
        'packages/components/src/tracing/**',
        'packages/application/src/notification-manager.ts',
      ],
      rules: {
        'no-console': 'off',
      },
    },
    {
      // Vue <script setup> macros and Astro's component global are compiler
      // provided: oxlint parses .vue/.astro but does not inject their globals.
      files: ['**/*.vue'],
      globals: {
        defineEmits: 'readonly',
        defineExpose: 'readonly',
        defineModel: 'readonly',
        defineOptions: 'readonly',
        defineProps: 'readonly',
        defineSlots: 'readonly',
        withDefaults: 'readonly',
      },
    },
    {
      files: ['**/*.astro'],
      globals: {
        Astro: 'readonly',
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
