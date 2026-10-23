import jsdoc from 'eslint-plugin-jsdoc';
import tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';

// Adapted from @notmike101/eslint-config-jsdoc: syntax and coverage stay separate.
const coverageRules = [
  'require-jsdoc', 'require-description', 'require-param',
  'require-param-description', 'require-param-name', 'require-param-type',
  'require-property', 'require-property-description', 'require-property-name',
  'require-property-type', 'require-returns', 'require-returns-check',
  'require-returns-description', 'require-returns-type',
  'require-yields', 'require-yields-check',
];

/**
 * Build matching syntax and coverage configs for one source language.
 *
 * @param {string[]} files - Source file patterns handled by the preset.
 * @param {import('eslint').Linter.Config} preset - Language-aware JSDoc recommendations.
 * @param {import('eslint').Linter.LanguageOptions} languageOptions - Parser configuration.
 * @returns {import('eslint').Linter.Config[]} Syntax and coverage configurations.
 */
function documentation(files, preset, languageOptions = {}) {
  return [
    {
      ...preset,
      files,
      languageOptions,
      rules: {
        ...preset.rules,
        ...Object.fromEntries(coverageRules.map((name) => [`jsdoc/${name}`, 'off'])),
        'jsdoc/no-defaults': 'off',
        'jsdoc/tag-lines': ['warn', 'any', { startLines: 1 }],
        'jsdoc/require-hyphen-before-param-description': ['warn', 'always'],
      },
    },
    {
      files,
      rules: {
        ...Object.fromEntries(coverageRules.map((name) => [
          `jsdoc/${name}`, preset.rules[`jsdoc/${name}`] ?? 'off',
        ])),
        'jsdoc/require-jsdoc': ['warn', {
          require: {
            ArrowFunctionExpression: true,
            FunctionExpression: true,
            FunctionDeclaration: true,
            ClassExpression: true,
            ClassDeclaration: true,
            MethodDefinition: true,
          },
        }],
        'jsdoc/require-description': 'warn',
      },
    },
  ];
}

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '.worktrees/**', '.superpowers/**'] },
  ...documentation(['**/*.{js,mjs,cjs}'], jsdoc.configs['flat/recommended']),
  ...documentation(['**/*.{ts,mts,cts}'], jsdoc.configs['flat/recommended-typescript'], { parser: tsParser }),
  ...documentation(['**/*.vue'], jsdoc.configs['flat/recommended-typescript'], {
    parser: vueParser,
    parserOptions: { parser: tsParser, extraFileExtensions: ['.vue'] },
  }),
  {
    files: ['**/*.{ts,mts,cts,vue}'],
    // Keep generator and error documentation descriptive rather than repeating types.
    rules: {
      'jsdoc/require-yields-type': 'off',
      'jsdoc/require-next-type': 'off',
      'jsdoc/require-throws-type': 'off',
    },
  },
];
