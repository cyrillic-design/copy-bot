// @ts-check
const js = require('@eslint/js')
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')
const globals = require('globals')

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      camelcase: 0,
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
]
