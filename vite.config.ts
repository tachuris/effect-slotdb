import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    server: { deps: { inline: ['@effect/vitest'] } },
  },
  fmt: {
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    arrowParens: 'avoid',
  },
  lint: {
    // The consumer fixture resolves its imports only inside scripts/check-consumer.sh.
    ignorePatterns: ['scripts/consumer/**'],
    options: { typeAware: true, typeCheck: true },
    jsPlugins: ['eslint-plugin-sql'],
    rules: {
      'sql/format': [
        'warn',
        {
          ignoreExpressions: false,
          ignoreInline: false,
          ignoreStartWithNewLine: true,
          ignoreTagless: true,
          retainBaseIndent: true,
          sqlTag: 'sql',
        },
        {
          keywordCase: 'upper',
          dataTypeCase: 'upper',
          language: 'sqlite',
        },
      ],
    },
  },
})
