import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // The first array is the untracked output that a local run of `mastra dev` /
    // `mastra build` / `next dev` leaves behind. CI never has it, so `npm run lint`
    // is green there and red here, and the noise is not cosmetic: `projectService`
    // is handed a few thousand generated `.mjs`/`.js` files it cannot attribute to a
    // tsconfig, and type-aware rules then start reporting `any` access in real
    // source. These directories are the ones .gitignore already excludes.
    ignores: [
      'dist/**',
      'coverage/**',
      'migrations/**',
      'node_modules/**',
      'eslint.config.js',
      '.mastra/**',
      '.preview/**',
      '.qoder/**',
      '.superpowers/**',
      '.worktrees/**',
      'tmp/**',
      // `console/` is a separate npm project with its own tsconfig and its own
      // lint script (`next lint`). Linting it from here reaches it through the
      // root tsconfig, so its files are reported against the wrong project: the
      // `.tsx` errors are real, but `next.config.js` cannot even be parsed
      // ("not found by the project service").
      'console/**',
      // Plain-JS helper scripts (the Gmail OAuth probe) are not in any tsconfig
      // include, so type-aware rules cannot run on them at all and the only thing
      // this config can say about them is "I cannot read this file".
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Smoke tests assert that wrong code does not compile. They carry
    // @ts-expect-error directives and intentionally unused bindings. The fixtures
    // are async only because Mastra's execute signatures return a Promise, so
    // there is never anything to await.
    files: ['tests/smoke/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
)
