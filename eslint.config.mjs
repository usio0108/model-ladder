import js from '@eslint/js';

// Node globals listed by hand so the config needs no extra package (@eslint/js has no `globals`).
const nodeGlobals = Object.fromEntries(
  ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'AbortController',
    'AbortSignal', 'TextDecoder', 'TextEncoder', 'fetch', 'performance', '__dirname', '__filename', 'globalThis',
    'require', 'module', 'exports'].map((n) => [n, 'readonly']),
);

export default [
  {
    ignores: [
      'node_modules/**',
      '.claude/worktrees/**',
      'hooks/band/**/*.ts',
      'hooks/band/**/*.tsx',
      // Workflow script body: top-level `return` and `await` next to `export`, which no parser mode accepts.
      'workflows/ladder.js',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    rules: {
      // Best-effort cleanup (fs, kill, JSON) deliberately swallows errors with an empty catch.
      'no-empty': 'off',
      // Strips ANSI escapes and control characters from terminal output on purpose.
      'no-control-regex': 'off',
      // Some strings deliberately contain a BOM or non-breaking space.
      'no-irregular-whitespace': 'off',
      // `({ drop, ...rest }) => rest` is the idiom for omitting a key.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['tests/**'],
    rules: {
      // Style only in test fixtures; tests are not edited by lint cleanups.
      'no-unused-vars': 'off',
      'no-unsafe-finally': 'off',
      'no-regex-spaces': 'off',
    },
  },
  {
    // Generated from workflows/ladder.js by sync-rules.mjs: it carries helpers this module does not use.
    files: ['scripts/ladder-rules.mjs'],
    rules: { 'no-unused-vars': 'off' },
  },
];
