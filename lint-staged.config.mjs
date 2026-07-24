/** @type {import('lint-staged').Configuration} */
export default {
  '*.{ts,tsx}': [
    'eslint',
    'prettier --check',
    () => 'pnpm exec turbo run check-types --filter=...[HEAD]',
  ],
  '*.{json,yml,yaml,css}': 'prettier --check',
};
