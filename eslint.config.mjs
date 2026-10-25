import { fixupPluginRules } from '@eslint/compat';
import configJs from '@notmike101/eslint-config-js';
import configJsdoc from '@notmike101/eslint-config-jsdoc';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import vueParser from 'vue-eslint-parser';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];

/* eslint-plugin-import@2.32.0 rule code calls SourceCode methods that
   ESLint 10 removed (getTokenOrCommentBefore and friends); fixupPluginRules
   restores them so a rule violation reports a diagnostic instead of crashing. */
const fixedImportPlugin = fixupPluginRules(importPlugin);

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

/**
 * Scope one shared-package config entry to JavaScript source files.
 *
 * Entries from `@notmike101/eslint-config-js` and `@notmike101/eslint-config-jsdoc`
 * either have no `files` key (applied globally) or already restrict themselves to
 * JavaScript patterns; scoping the keyless ones keeps TypeScript and Vue sources
 * on their existing presets.
 *
 * @param {import('eslint').Linter.Config | import('eslint').Linter.Config[]} entry - Config entry from a shared package.
 * @returns {import('eslint').Linter.Config | import('eslint').Linter.Config[]} Entry restricted to JavaScript file patterns.
 */
function scopeToJavaScript(entry) {
    if (Array.isArray(entry)) {
        return entry.map(scopeToJavaScript);
    }

    const scoped = entry.files ? entry : { ...entry, files: javascriptFiles };

    if (scoped.plugins?.import) {
        return { ...scoped, plugins: { ...scoped.plugins, import: fixedImportPlugin } };
    }

    return scoped;
}

export default [
    { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '.worktrees/**', '.superpowers/**'] },
    ...scopeToJavaScript(configJs),
    ...scopeToJavaScript(configJsdoc),
    {
        /* The package defaults to browser globals outside scripts/bin,
           so declare Node
           globals for the Node helper scripts that live outside that convention. */
        files: ['**/test/fixtures/**/*.{js,mjs,cjs}'],
        languageOptions: { globals: globals.nodeBuiltin },
    },
    {
        /* eslint-plugin-import@2.32.0's default resolver predates exports
           maps: it cannot see ESM-only packages installed under pnpm (no
           "main" field), so no-unresolved false-positives on imports that
           Node itself resolves fine. */
        files: javascriptFiles,
        rules: { 'import/no-unresolved': 'off' },
    },
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
